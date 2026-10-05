import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { parsePublicWorkdayIntent, WorkdayPreflightService } from '../../../../../src/api/capacity/services/capacity/workdays/scheduling/workday-preflight-service.ts';
import { canonicalWorkdayShares } from '../../../../../src/api/capacity/services/capacity/workdays/scheduling/workday-scheduling-service.ts';

const input = () => ({ profileId: 'default', projects: ['sdk'], startsAt: new Date().toISOString(), durationSeconds: 600, agentSelection: { agentSlugs: ['reviewer'], activityTypes: ['reviewing'] } });
const exactDigest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const executionNodeRow = (value: { id: string; kind: string; agentClass: string; digest: string; expectedSeconds: number; nodeRevision?: number; decisionRevision?: number }) => ({
	id: value.id, team_id: 'team', project_id: 'project-sdk', kind: value.kind, pair_role: value.kind === 'reviewing' ? 'reviewer' : value.kind === 'acting' ? 'actor' : null,
	...(value.kind === 'acting' || value.kind === 'reviewing' ? { work_item_id: 'work-item', maximum_review_cycles: 2 } : {}),
	source_ref_json: JSON.stringify({ store: 'treedx', model: 'proposal', id: 'proposal', revision: 1, digest: exactDigest(value.digest) }),
	authority_refs_json: JSON.stringify(value.decisionRevision ? [{ store: 'treedx', model: 'decision', id: 'decision', revision: value.decisionRevision, digest: `sha256:${'d'.repeat(64)}` }] : []),
	rule_revision: 1, node_revision: value.nodeRevision ?? 1, agent_class: value.agentClass, status: 'ready',
	estimate_json: JSON.stringify({ expectedSeconds: value.expectedSeconds, maximumSeconds: value.expectedSeconds * 2 }),
	required_capabilities_json: '[]', requested_permissions_json: JSON.stringify({ content: { read: [], write: [] }, tools: [] }),
	workspace: value.kind === 'acting' ? 'git' : 'treedx', graph_revision_created: 1, graph_revision_updated: 1,
});
function fixture(acceptedDecision = false) {
	let stored: any; let replay: any;
	// Supplied UNIT authority only; native governance is proved separately.
	const decision = { id: 'decision', team_id: 'team', project_id: 'project-sdk', proposal_id: 'proposal',
		proposal_version: 1, proposal_content_hash: 'd'.repeat(64), status: 'accepted', superseded_at: null,
		proposal_status: 'accepted', active_version: 1, active_content_hash: 'd'.repeat(64),
		decision_record_json: JSON.stringify({ decisionDependencies: [], proposalRef: { id: 'proposal', revision: 1,
			digest: `sha256:${'d'.repeat(64)}`, repository: 'library', commit: 'a'.repeat(40), path: 'proposals/proposal.mdx' } }) };
	const store = {
		ensureInitialized: vi.fn(async () => {}),
		all: vi.fn(async (sql: string): Promise<Record<string, unknown>[]> => sql.includes('capacity_provider_team_memberships') ? [{ capacity_provider_id: 'provider' }] : sql.includes('project_agent_classes') ? [{ id: 'class', slug: 'assurance' }] : sql.includes('SELECT id,slug FROM projects') ? [{ id: 'project-sdk', slug: 'sdk' }] : []),
		first: vi.fn(async (sql: string) => sql.includes('FROM teams') ? { metadata_json: '{}' } : sql.includes('FROM governance_decisions decision') && acceptedDecision ? decision : sql.includes("operation='workday.start'") ? replay : sql.includes("resource_type='workday_preflight'") ? { response_json: JSON.stringify(stored) } : null),
		run: vi.fn(async (_sql: string, args: unknown[]) => {
			if (args[2] === 'workday.preflight') stored = JSON.parse(String(args[7]));
			else replay = { request_digest: args[4], response_json: args[7] };
		}),
		preflightCapacityWorkdayRunRequest: vi.fn(async () => ({ availableSeconds: 600, projects: [{ id: 'project-sdk', agents: [{ slug: 'reviewer', agentClass: 'assurance', classSlug: 'assurance', activityTypes: ['reviewing'] }] }], executionNodeDemands: [{ graph_revision: 5, ...executionNodeRow({ id: 'node-review', kind: 'reviewing', agentClass: 'assurance', digest: 'sha256:source', expectedSeconds: 120, decisionRevision: 1 }) }] })),
		createCapacityWorkdayRun: vi.fn(async (_team: string, value: any) => ({ id: value.id, startedAt: value.startedAt })),
	};
	return { store, service: new WorkdayPreflightService(store as any), stored: () => stored };
}

describe('public workday selection custody', () => {
	it('denies expired original admission and every nonrunning retained run without a start receipt or changed authority', async () => {
		for (const status of ['queued', 'failed', 'cancelled', 'completed', 'degraded']) {
			const f = fixture(), planned = await f.service.preflight('team', parsePublicWorkdayIntent('team', input()), 'actor');
			const original = structuredClone(f.stored()), first = f.store.first.getMockImplementation()!;
			f.store.first.mockImplementation(async (sql: string) => sql.includes('SELECT * FROM capacity_workday_runs WHERE team_id')
				? { id: `workday-${planned.id}`, status } : first(sql));
			f.store.run.mockClear();
			await expect(f.service.start('team', { preflightId: planned.id, preflightDigest: planned.preflightDigest,
				idempotencyKey: `retained-${status}` }, 'actor')).rejects.toMatchObject({ status: 409 });
			expect(f.store.run).not.toHaveBeenCalled(); expect(f.store.createCapacityWorkdayRun).not.toHaveBeenCalled();
			expect(f.stored()).toEqual(original);
		}
		const f = fixture(), planned = await f.service.preflight('team', parsePublicWorkdayIntent('team', {
			...input(), startsAt: new Date(Date.now() - 120_000).toISOString(), durationSeconds: 60,
		}), 'actor'), original = structuredClone(f.stored()); f.store.run.mockClear();
		await expect(f.service.start('team', { preflightId: planned.id, preflightDigest: planned.preflightDigest,
			idempotencyKey: 'elapsed' }, 'actor')).rejects.toMatchObject({ status: 409 });
		expect(f.store.run).not.toHaveBeenCalled(); expect(f.store.createCapacityWorkdayRun).not.toHaveBeenCalled();
		expect(f.stored()).toEqual(original);
	});
	it('binds preflight to exact project library and agent profile revisions before any start write', async () => {
		for (const field of ['contentRevision', 'agentProfileRevision']) {
			const f = fixture(), project = { id: 'project-sdk', repositoryId: 'library', contentRevision: 'a'.repeat(40),
				agentProfileRevision: 'profile-one', agents: [] };
			f.store.preflightCapacityWorkdayRunRequest.mockResolvedValue({ availableSeconds: 600, projects: [project], executionNodeDemands: [] });
			const planned = await f.service.preflight('team', parsePublicWorkdayIntent('team', input()), 'actor'), original = structuredClone(f.stored());
			f.store.preflightCapacityWorkdayRunRequest.mockResolvedValue({ availableSeconds: 600,
				projects: [{ ...project, [field]: field === 'contentRevision' ? 'b'.repeat(40) : 'profile-two' }], executionNodeDemands: [] });
			f.store.run.mockClear();
			await expect(f.service.start('team', { preflightId: planned.id, preflightDigest: planned.preflightDigest,
				idempotencyKey: field }, 'actor')).rejects.toMatchObject({ status: 409, code: 'workday_preflight_stale' });
			expect(f.store.run).not.toHaveBeenCalled(); expect(f.store.createCapacityWorkdayRun).not.toHaveBeenCalled(); expect(f.stored()).toEqual(original);
		}
	});
	it('requires every explicit decision selector to resolve before persisting even a planning-only or partially matched preflight', async () => {
		for (const executionMode of ['simulation', 'production']) {
			for (const planningOnly of [false, true]) {
				for (const decisionIds of [['missing-decision'], ['decision', 'missing-decision']]) {
					const f = fixture();
					// The original projection supplies a node labelled with decision. It
					// is not proof of accepted authority for any selected identity.
					const body = { ...input(), executionMode, planningOnly, decisionIds };
					const supplied = structuredClone(body), intent = parsePublicWorkdayIntent('team', body);
					const frozen = structuredClone(intent);
					await expect(f.service.preflight('team', intent, 'actor')).rejects.toMatchObject({
						status: 409, code: 'governance_decision_missing',
					});
					expect(f.store.run).not.toHaveBeenCalled(); expect(f.store.createCapacityWorkdayRun).not.toHaveBeenCalled();
					expect(f.stored()).toBeUndefined(); expect(body).toEqual(supplied); expect(intent).toEqual(frozen);
				}
			}
		}
	});
	it('snapshots explicit continuation without resetting completed graph roots', async () => {
		const f = fixture(true);
		const first = f.store.first.getMockImplementation()!, all = f.store.all.getMockImplementation()!;
		f.store.first.mockImplementation(async (sql: string) => sql.includes('SELECT * FROM capacity_workday_runs WHERE team_id')
			? { id: 'old', team_id: 'team', status: 'completed', execution_kind: 'workday', execution_mode: 'simulation', capacity_provider_id: 'provider',
				parameters_json: '{"scheduledProjectIds":["project-sdk"]}' } : first(sql));
		f.store.all.mockImplementation(async (sql: string) => sql.includes('SELECT id,slug FROM projects')
			? [{ id: 'project-sdk', slug: 'sdk' }] : sql.includes('SELECT DISTINCT decision_id')
				? [{ decision_id: 'decision', assignment_attempt_json: '{}' }] : all(sql));
		await f.service.preflight('team', parsePublicWorkdayIntent('team', { ...input(), decisionIds: ['decision'], continueFromWorkdayId: 'old' }), 'actor');
		expect(f.stored().runInput.parameters).toMatchObject({ continueFromWorkdayId: 'old', decisionIds: ['decision'] });
		expect(f.stored().receipt.intentDigest).toBeTruthy();
		expect(() => parsePublicWorkdayIntent('team', { ...input(), continueFromWorkdayId: 'old' })).toThrow(/invalid/u);
	});
	it('preserves explicit production custody and defaults omitted mode to simulation', async () => {
		const f = fixture();
		await f.service.preflight('team', parsePublicWorkdayIntent('team', { ...input(), executionMode: 'production' }), 'actor');
		expect(f.stored().runInput.executionMode).toBe('production');
		await f.service.preflight('team', parsePublicWorkdayIntent('team', input()), 'actor');
		expect(f.stored().runInput.executionMode).toBe('simulation');
		expect(() => parsePublicWorkdayIntent('team', { ...input(), executionMode: 'other' })).toThrow(/invalid/u);
	});
	it('projects inherited team targets onto selected projects without filtering explicit overrides', async () => {
		const f = fixture();
		f.store.first.mockImplementation(async (sql: string) => sql.includes('FROM teams') ? { metadata_json: JSON.stringify({ workdayProfile: {
			revision: 3, policy: { durationSeconds: 600, maximumConcurrency: 1, communicationConcurrency: 1,
				planningPercent: 20, allocationWeight: 1, planningTurnMaximumSeconds: 180,
				projectPercentages: { 'project-sdk': 75, api: 25 }, agentClassPercentages: { sdk: { reviewer: 100 }, api: { engineer: 100 } } },
		} }) } : null);
		f.store.all.mockImplementation(async (sql: string) => sql.includes('FROM projects')
			? [{ id: 'project-sdk', slug: 'sdk' }, { id: 'project-api', slug: 'api' }]
			: sql.includes('capacity_provider_team_memberships') ? [{ capacity_provider_id: 'provider' }] : []);
		await f.service.preflight('team', parsePublicWorkdayIntent('team', input()), 'actor');
		expect(f.stored().runInput.parameters).toMatchObject({ policyRevision: 3,
			projectPercentages: { 'project-sdk': 75 }, agentClassPercentages: { sdk: { reviewer: 100 } } });
		await f.service.preflight('team', parsePublicWorkdayIntent('team', { ...input(), allocation: { projectPercentages: { other: 100 } } }), 'actor');
		expect(f.stored().runInput.parameters.projectPercentages).toEqual({ other: 100 });
	});
	it('snapshots the team policy and resolves omitted duration without operator task budgets', async () => {
		const f = fixture();
		const { durationSeconds: _duration, profileId: _profile, ...value } = input();
		const intent = parsePublicWorkdayIntent('team', value);
		const receipt = await f.service.preflight('team', intent, 'actor');
		expect(intent.profileId).toBe('default');
		expect(Date.parse(receipt.endsAt) - Date.parse(receipt.startsAt)).toBe(28_800_000);
		expect(f.stored().runInput.parameters).toMatchObject({ policyId: 'default', policyRevision: 1,
			planningPercent: 20, allocationWeight: 1, planningTurnMaximumSeconds: 180, maximumConcurrency: 1 });
	});
	it('resolves allocation slugs to the graph project identity and rejects ambiguous or unselected inputs', () => {
		const projects = [{ id: 'project-sdk', slug: 'sdk' }, { id: 'project-api', slug: 'api' }];
		expect(canonicalWorkdayShares({ projectPercentages: { sdk: 75, api: 25 },
			agentClassPercentages: { sdk: { engineer: 80, tester: 20 } } }, projects)).toEqual({
			projectPercentages: { 'project-sdk': 75, 'project-api': 25 },
			agentClassPercentages: { 'project-sdk': { engineer: 80, tester: 20 } },
		});
		expect(() => canonicalWorkdayShares({ projectPercentages: { sdk: 50, 'project-sdk': 50 } }, projects)).toThrow('one identifier');
		expect(() => canonicalWorkdayShares({ projectPercentages: { other: 100 } }, projects)).toThrow('selected project');
	});
	it('preflights fresh simulation roots without counting a prior exhausted run as ready work', async () => {
		const f = fixture(true);
		const actor = { ...executionNodeRow({ id: 'actor', kind: 'acting', agentClass: 'engineer',
			digest: 'source', expectedSeconds: 180, nodeRevision: 4, decisionRevision: 1 }), status: 'blocked', workday_id: 'old' };
		const reviewer = { ...executionNodeRow({ id: 'reviewer', kind: 'reviewing', agentClass: 'reviewer',
			digest: 'source', expectedSeconds: 120, nodeRevision: 4, decisionRevision: 1 }), status: 'failed', workday_id: 'old' };
		f.store.preflightCapacityWorkdayRunRequest.mockResolvedValue({ availableSeconds: 7200,
			projects: [{ id: 'project-sdk', agents: [] }], executionNodeDemands: [], appliedPlan: {} });
		f.store.all.mockImplementation(async (sql: string) => sql.includes('capacity_provider_team_memberships')
			? [{ capacity_provider_id: 'provider' }] : sql.includes('FROM execution_nodes node')
			? [{ ...actor, graph_revision: 4 }, { ...reviewer, graph_revision: 4 }] : sql.includes('FROM execution_edges')
					? [{ from_node_id: 'actor', to_node_id: 'reviewer' }] : sql.includes('SELECT id,slug FROM projects')
						? [{ id: 'project-sdk', slug: 'sdk' }] : []);
		const receipt = await f.service.preflight('team', parsePublicWorkdayIntent('team', {
			...input(), executionMode: 'simulation', decisionIds: ['decision'], durationSeconds: 7200,
		}), 'actor');
		expect(receipt.selectedDemands).toEqual([expect.objectContaining({ sourceId: 'actor',
			actingAuthority: expect.objectContaining({ executionNodeRevision: 5 }) })]);
	});
	it('freezes the admission time when an explicit start is omitted', () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date('2026-09-12T01:30:00.000Z'));
			const { startsAt: _startsAt, ...withoutStart } = input();
			expect(parsePublicWorkdayIntent('team', withoutStart).startsAt).toBe('2026-09-12T01:30:00.000Z');
		} finally {
			vi.useRealTimers();
		}
	});
	it('validates before normalization and preserves omitted selection', () => {
		const { agentSelection, ...unselected } = input();
		expect(parsePublicWorkdayIntent('team', unselected).agentSelection).toBeUndefined();
		for (const invalid of [{}, null, { agentSlugs: [] }, { agentSlugs: [''] }, { activityTypes: ['acting'] }]) expect(() => parsePublicWorkdayIntent('team', { ...input(), agentSelection: invalid })).toThrow(/invalid/u);
		expect(parsePublicWorkdayIntent('team', { ...input(), agentSelection: { ...agentSelection, agentSlugs: [' reviewer ', 'reviewer'] } }).agentSelection?.agentSlugs).toEqual(['reviewer']);
		const canonical = parsePublicWorkdayIntent('team', input());
		expect(parsePublicWorkdayIntent('team', canonical as unknown as Record<string, unknown>)).toEqual(canonical);
		expect(canonical.agentSelection).not.toHaveProperty('classIds');
	});
	it('normalizes explicit accepted-decision selection and rejects malformed selection', () => {
		expect(parsePublicWorkdayIntent('team', { ...input(), decisionIds: [' decision-b ', 'decision-a', 'decision-b'] }).decisionIds).toEqual(['decision-a', 'decision-b']);
		expect(() => parsePublicWorkdayIntent('team', { ...input(), decisionIds: [] })).toThrow(/invalid/u);
	});
	it('normalizes exact proposal selection for cooperative planning', () => {
		expect(parsePublicWorkdayIntent('team', { ...input(), proposalIds: [' proposal-b ', 'proposal-a', 'proposal-b'] }).proposalIds)
			.toEqual(['proposal-a', 'proposal-b']);
		expect(() => parsePublicWorkdayIntent('team', { ...input(), proposalIds: [] })).toThrow(/invalid/u);
	});
	it('preserves explicit planning-only intent and rejects non-boolean values', () => {
		expect(parsePublicWorkdayIntent('team', { ...input(), planningOnly: true }).planningOnly).toBe(true);
		expect(() => parsePublicWorkdayIntent('team', { ...input(), planningOnly: 'true' })).toThrow(/invalid/u);
	});
	it('freezes exact living-node authority without creating a capacity plan', async () => {
		const f = fixture(true);
		f.store.preflightCapacityWorkdayRunRequest.mockResolvedValue({ availableSeconds: 600, executionNodeDemands: [{ graph_revision: 7, ...executionNodeRow({ id: 'node', kind: 'acting', agentClass: 'engineering', digest: 'sha256:source', expectedSeconds: 180, nodeRevision: 3, decisionRevision: 2 }) }] });
		await f.service.preflight('team', parsePublicWorkdayIntent('team', { ...input(), decisionIds: ['decision'] }), 'actor');
		expect(f.stored().runInput.parameters).toMatchObject({ decisionIds: ['decision'] });
		expect(f.stored().runInput.parameters).not.toHaveProperty('decisionWorkflows');
		expect(f.stored().receipt.selectedDemands).toEqual([expect.objectContaining({ sourceType: 'execution-node', sourceId: 'node', actingAuthority: {
			decisionId: 'decision', decisionRevision: 2, executionNodeId: 'node', executionNodeRevision: 3, graphRevision: 7, sourceDigest: exactDigest('sha256:source'),
		} })]);
		expect(f.store.first.mock.calls.map((call) => String(call[0])).join('\n')).not.toMatch(/capacity_allocation_sets|agent_capacity_plans/u);
	});

	it('rejects the retired generic reserve instead of silently preserving it', () => {
		expect(() => parsePublicWorkdayIntent('team', { ...input(), operatorConstraints: { reservePercent: 10 } }))
			.toThrow(/retired or unsupported/u);
	});
	it('freezes selection, starts the exact plan, and replays without creating more work', async () => {
		const f = fixture(); const intent = parsePublicWorkdayIntent('team', input());
		const receipt = await f.service.preflight('team', intent, 'actor');
		expect(f.stored().runInput.parameters.agentSelection).toEqual(intent.agentSelection);
		expect(f.stored().runInput).toMatchObject({ executionMode: 'simulation', executionKind: 'workday', triggerKind: 'manual' });
		expect(receipt.selectedDemands.map(d => d.sourceId)).toEqual(['node-review']);
		const request = { preflightId: receipt.id, preflightDigest: receipt.preflightDigest, idempotencyKey: 'start' };
		const started = await f.service.start('team', request, 'actor');
		expect(await f.service.start('team', request, 'actor')).toEqual(started);
		expect(f.store.createCapacityWorkdayRun).toHaveBeenCalledOnce();
		expect(f.store.createCapacityWorkdayRun.mock.calls[0]![1].parameters.agentSelection).toEqual(intent.agentSelection);
	});
	it('limits planning selectors without filtering decision-governed acting work', async () => {
		const f = fixture();
		f.store.preflightCapacityWorkdayRunRequest.mockResolvedValue({ availableSeconds: 600,
			projects: [{ id: 'project-sdk', agents: [{ slug: 'reviewer', agentClass: 'assurance', classSlug: 'assurance', activityTypes: ['reviewing'] }] }],
			executionNodeDemands: [
				{ graph_revision: 5, ...executionNodeRow({ id: 'node-review', kind: 'reviewing', agentClass: 'assurance', digest: 'sha256:review', expectedSeconds: 120, decisionRevision: 1 }) },
				{ graph_revision: 5, ...executionNodeRow({ id: 'node-acting', kind: 'acting', agentClass: 'engineering', digest: 'sha256:acting', expectedSeconds: 180, decisionRevision: 1 }) },
				{ graph_revision: 5, ...executionNodeRow({ id: 'node-plan', kind: 'planning', agentClass: 'architecture', digest: 'sha256:plan', expectedSeconds: 120 }) },
				{ graph_revision: 5, ...executionNodeRow({ id: 'node-estimate', kind: 'estimating', agentClass: 'assurance', digest: 'sha256:estimate', expectedSeconds: 120 }) },
			],
		});
		const receipt = await f.service.preflight('team', parsePublicWorkdayIntent('team', input()), 'actor');
		expect(receipt.selectedDemands.map((demand) => demand.sourceId)).toEqual(['node-review', 'node-acting']);
	});
	it('excludes decision-governed acting work from an explicit planning-only workday', async () => {
		const f = fixture();
		f.store.preflightCapacityWorkdayRunRequest.mockResolvedValue({ availableSeconds: 600,
			projects: [{ id: 'project-sdk', agents: [{ slug: 'reviewer', agentClass: 'assurance', classSlug: 'assurance', activityTypes: ['estimating'] }] }],
			executionNodeDemands: [
				{ graph_revision: 5, ...executionNodeRow({ id: 'node-acting', kind: 'acting', agentClass: 'engineering', digest: 'sha256:acting', expectedSeconds: 180, decisionRevision: 1 }) },
				{ graph_revision: 5, ...executionNodeRow({ id: 'node-estimate', kind: 'estimating', agentClass: 'assurance', digest: 'sha256:estimate', expectedSeconds: 120 }) },
			],
		});
		const receipt = await f.service.preflight('team', parsePublicWorkdayIntent('team', { ...input(), planningOnly: true,
			proposalIds: ['proposal'], agentSelection: { agentSlugs: ['reviewer'], activityTypes: ['estimating'] } }), 'actor');
		expect(receipt.selectedDemands.map((demand) => demand.sourceId)).toEqual(['node-estimate']);
		expect(f.stored().runInput.parameters.planningOnly).toBe(true);
		expect(f.stored().runInput.parameters.proposalIds).toEqual(['proposal']);
	});
	it('keeps decision-only workdays free of unrelated proposal-governance reviews', async () => {
		const f = fixture(true);
		f.store.preflightCapacityWorkdayRunRequest.mockResolvedValue({ availableSeconds: 600,
			projects: [{ id: 'project-sdk', agents: [{ slug: 'reviewer', agentClass: 'reviewer', classSlug: 'reviewer', activityTypes: ['reviewing'] }] }],
			executionNodeDemands: [
				{ graph_revision: 5, ...executionNodeRow({ id: 'proposal-review', kind: 'reviewing', agentClass: 'reviewer', digest: 'proposal', expectedSeconds: 120 }), pair_role: null },
				{ graph_revision: 5, ...executionNodeRow({ id: 'selected-acting', kind: 'acting', agentClass: 'engineer', digest: 'selected', expectedSeconds: 120, decisionRevision: 1 }) },
				{ graph_revision: 5, ...executionNodeRow({ id: 'unselected-acting', kind: 'acting', agentClass: 'engineer', digest: 'unselected', expectedSeconds: 120, decisionRevision: 1 }), authority_refs_json: JSON.stringify([{ store: 'treedx', model: 'decision', id: 'other-decision', revision: 1, digest: `sha256:${'e'.repeat(64)}` }]) },
			],
		});
		const receipt = await f.service.preflight('team', parsePublicWorkdayIntent('team', { ...input(), decisionIds: ['decision'] }), 'actor');
		expect(receipt.selectedDemands.map((demand) => demand.sourceId)).toEqual(['selected-acting']);
	});
	it('excludes all planning demands when the workday has no planning allocation', async () => {
		const f = fixture(true);
		f.store.preflightCapacityWorkdayRunRequest.mockResolvedValue({ availableSeconds: 600,
			projects: [{ id: 'project-sdk', agents: [{ slug: 'reviewer', agentClass: 'reviewer', classSlug: 'reviewer', activityTypes: ['reviewing'] }] }],
			executionNodeDemands: [
				{ graph_revision: 5, ...executionNodeRow({ id: 'proposal-review', kind: 'reviewing', agentClass: 'reviewer', digest: 'proposal', expectedSeconds: 120 }), pair_role: null },
				{ graph_revision: 5, ...executionNodeRow({ id: 'selected-acting', kind: 'acting', agentClass: 'engineer', digest: 'selected', expectedSeconds: 120, decisionRevision: 1 }) },
			],
		});
		const receipt = await f.service.preflight('team', parsePublicWorkdayIntent('team', { ...input(), decisionIds: ['decision'],
			allocation: { planningPercent: 0 } }), 'actor');
		expect(receipt.selectedDemands.map((demand) => demand.sourceId)).toEqual(['selected-acting']);
	});
	it('rejects an altered stored selector instead of compiling broader authority', async () => {
		const f = fixture(); const receipt = await f.service.preflight('team', parsePublicWorkdayIntent('team', input()), 'actor');
		delete f.stored().intent.agentSelection;
		await expect(f.service.start('team', { preflightId: receipt.id, preflightDigest: receipt.preflightDigest, idempotencyKey: 'start' }, 'actor')).rejects.toMatchObject({ code: 'workday_preflight_integrity_invalid' });
		expect(f.store.createCapacityWorkdayRun).not.toHaveBeenCalled();
	});
	it('never executes a modified stored run input', async () => {
		const f = fixture(); const receipt = await f.service.preflight('team', parsePublicWorkdayIntent('team', input()), 'actor');
		delete f.stored().runInput.parameters.agentSelection;
		await f.service.start('team', { preflightId: receipt.id, preflightDigest: receipt.preflightDigest, idempotencyKey: 'start' }, 'actor');
		expect(f.store.createCapacityWorkdayRun.mock.calls[0]![1].parameters.agentSelection.agentSlugs).toEqual(['reviewer']);
	});
});
