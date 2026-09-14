import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { parsePublicWorkdayIntent, WorkdayPreflightService } from '../../../../../src/api/capacity/services/capacity/workdays/scheduling/workday-preflight-service.ts';

const input = () => ({ profileId: 'profile', projects: ['sdk'], startsAt: new Date().toISOString(), durationSeconds: 600, agentSelection: { agentSlugs: ['reviewer'], activityTypes: ['reviewing'] } });
const exactDigest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const executionNodeRow = (value: { id: string; kind: string; agentClass: string; digest: string; expectedSeconds: number; nodeRevision?: number; decisionRevision?: number }) => ({
	id: value.id, team_id: 'team', project_id: 'project-sdk', kind: value.kind, pair_role: value.kind === 'reviewing' ? 'reviewer' : value.kind === 'acting' ? 'actor' : null,
	...(value.kind === 'acting' || value.kind === 'reviewing' ? { work_item_id: 'work-item', maximum_review_cycles: 2 } : {}),
	source_ref_json: JSON.stringify({ store: 'treedx', model: 'proposal', id: 'proposal', revision: 1, digest: exactDigest(value.digest) }),
	authority_refs_json: JSON.stringify(value.decisionRevision ? [{ store: 'treedx', model: 'decision', id: 'decision', revision: value.decisionRevision, digest: `sha256:${'d'.repeat(64)}` }] : []),
	rule_revision: 1, node_revision: value.nodeRevision ?? 1, agent_class: value.agentClass, status: 'ready',
	estimate_json: JSON.stringify({ minimumSeconds: 60, expectedSeconds: value.expectedSeconds, maximumSeconds: value.expectedSeconds * 2 }),
	required_capabilities_json: '[]', requested_permissions_json: JSON.stringify({ content: { read: [], write: [] }, tools: [] }),
	workspace: value.kind === 'acting' ? 'git' : 'treedx', graph_revision_created: 1, graph_revision_updated: 1,
});
function fixture() {
	let stored: any; let replay: any;
	const store = {
		ensureInitialized: vi.fn(async () => {}),
		all: vi.fn(async (sql: string) => sql.includes('capacity_provider_team_memberships') ? [{ capacity_provider_id: 'provider' }] : sql.includes('project_agent_classes') ? [{ id: 'class', slug: 'assurance' }] : []),
		first: vi.fn(async (sql: string) => sql.includes('capacity_allocation_sets') ? { id: 'allocation', version: 1 } : sql.includes("operation='workday.start'") ? replay : sql.includes("resource_type='workday_preflight'") ? { response_json: JSON.stringify(stored) } : null),
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
	});
	it('normalizes explicit accepted-decision selection and rejects malformed selection', () => {
		expect(parsePublicWorkdayIntent('team', { ...input(), decisionIds: [' decision-b ', 'decision-a', 'decision-b'] }).decisionIds).toEqual(['decision-a', 'decision-b']);
		expect(() => parsePublicWorkdayIntent('team', { ...input(), decisionIds: [] })).toThrow(/invalid/u);
	});
	it('freezes exact living-node authority without creating a capacity plan', async () => {
		const f = fixture();
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
		expect(f.stored().runInput).toMatchObject({ executionMode: 'production', executionKind: 'workday', triggerKind: 'manual' });
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
