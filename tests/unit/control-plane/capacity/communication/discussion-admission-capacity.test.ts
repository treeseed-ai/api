import { describe, expect, it, vi } from 'vitest';
import { admitDiscussionInvocations, conversationRunDurationSeconds } from '../../../../../src/api/capacity/services/capacity/invocations/discussion-invocation-service.ts';
import { compileWorkdayAgentProfileSnapshot } from '../../../../../src/api/capacity/services/capacity/workdays/policy/workday-agent-profile-policy.ts';
import { compileCapacityWorkdayRunRecord } from '../../../../../src/api/capacity/services/capacity/workdays/scheduling/workday-run-service.ts';
import { normalizeWorkdayAgentSelection } from '@treeseed/sdk/operator-contracts';
import { preflightCapacityWorkdayRun } from '../../../../../src/api/capacity/services/capacity/workdays/scheduling/workday-scheduling-service.ts';

const permissions = { content: { read: ['knowledge', 'discussion'], write: ['discussion'] }, tools: ['discussion', 'source.read'] };
const agent = (slug: string) => ({
	schemaVersion: 'treeseed.agent/v1', id: `sdk/${slug}`, name: slug, agentClass: slug,
	purpose: `Perform ${slug} work.`, responsibilities: [`Perform ${slug} work.`], capabilities: ['repository-analysis'],
	context: { include: ['project-objectives'] },
	activityProfiles: { chat: { handler: 'writer', permissions, prompt: { system: 'Answer with exact evidence.' } } },
});

describe('discussion invocation capacity admission', () => {
	it('rejects an unsupported addressed profile before persisting any peer invocation', async () => {
		const store = {
			first: vi.fn(async () => null),
			all: vi.fn(async (sql: string) => sql.includes('FROM project_agent_classes')
				? [{ id: 'class', handler_refs_json: { agents: [agent('engineer')] } }] : []),
			run: vi.fn(async () => ({ meta: { changes: 1 } })),
			createCapacityWorkdayRun: vi.fn(), tickCapacityWorkdayRun: vi.fn(), updateCapacityWorkdayRun: vi.fn(),
		};
		await expect(admitDiscussionInvocations(store, { teamId: 'team', projectId: 'project', projectSlug: 'sdk',
			discussionId: 'discussion', messageId: 'message', messagePath: 'discussion-messages/message.mdx', messageCommit: 'c'.repeat(40),
			contextRefs: [], agentSlugs: ['engineer', 'unsupported'], idempotencyKey: 'invalid-group-profile', durationSeconds: 180 }))
			.rejects.toMatchObject({ code: 'discussion_agent_chat_profile_missing', details: { agentSlug: 'unsupported' } });
		expect(store.run).not.toHaveBeenCalled(); expect(store.createCapacityWorkdayRun).not.toHaveBeenCalled();
	});
	it('preflights a persisted addressed conversation without inventing proposal group membership', async () => {
		const source = { invocationId: 'invocation', discussionId: 'discussion', messageId: 'message',
			messagePath: 'discussion-messages/message.mdx', commitSha: 'c'.repeat(40) };
		const definition = agent('renamed-guide'), revision = 'a'.repeat(40);
		const invocation = { id: source.invocationId, team_id: 'team', project_id: 'project', execution_id: 'conversation',
			execution_kind: 'conversation', status: 'admitted', project_agent_class_id: 'class', agent_id: 'renamed-guide', agent_revision: revision,
			metadata_json: { discussionId: source.discussionId, sourceMessageId: source.messageId,
				sourceMessagePath: source.messagePath, sourceCommit: source.commitSha } };
		const store = { ensureInitialized: async () => {}, all: async () => [],
			first: vi.fn(async (sql: string) => sql.includes('capacity_provider_team_memberships') ? { id: 'membership' } : invocation),
			listTeamProjects: async () => [{ id: 'project', slug: 'agent' }],
			getProjectTreeDxLibrary: async () => ({ repositoryId: 'library', contentPath: '.', metadata: { resolvedRef: revision } }),
			listProjectAgentClassesPage: async () => ({ items: [{ id: 'class', slug: 'configured-guide', metadata: { immutableRef: revision },
				handlerRefs: { agents: [definition, { id: 'outside', invalid: 'Unaddressed profiles must not be admitted' }] } }], page: { hasMore: false } }) };
		const run = compileCapacityWorkdayRunRecord('team', { id: 'conversation', capacityProviderId: 'provider', executionMode: 'simulation',
			executionKind: 'conversation', parameters: { projects: ['agent'], durationSeconds: 240,
				agentSelection: { activityTypes: ['chat'] }, discussion: source } });
		const held = structuredClone(run);
		const result = await preflightCapacityWorkdayRun(store as never, run);
		expect(result).toMatchObject({ groupIds: [], projects: [{ agents: [{ slug: definition.id, activityTypes: ['chat'] }] }] });
		expect(result.agentProfilesByProjectId.project.agents.map(entry => entry.definition.id)).toEqual([definition.id]);
		expect(run).toEqual(held);
		for (const change of [{ messageId: 'forged' }, { commitSha: 'b'.repeat(40) }, { invocationId: '' }]) {
			await expect(preflightCapacityWorkdayRun(store as never, { ...run, parameters: { ...run.parameters,
				discussion: { ...source, ...change } } })).rejects.toMatchObject({ code: 'capacity_workday_discussion_authority_invalid' });
		}
		const original = structuredClone(invocation);
		for (const change of [{ team_id: 'foreign' }, { project_id: 'foreign' }, { execution_id: 'foreign' },
			{ status: 'completed' }, { execution_kind: 'workday' }, { project_agent_class_id: 'foreign' },
			{ agent_id: 'unaddressed' }, { agent_revision: 'b'.repeat(40) }, { metadata_json: '{broken' }]) {
			Object.assign(invocation, original, change);
			await expect(preflightCapacityWorkdayRun(store as never, run)).rejects.toMatchObject({ code: 'capacity_workday_discussion_authority_invalid' });
		}
		Object.assign(invocation, original);
		await expect(preflightCapacityWorkdayRun(store as never, { ...run, parameters: { ...run.parameters,
			agentSelection: { activityTypes: ['planning'] } } })).rejects.toMatchObject({ code: 'capacity_workday_discussion_authority_invalid' });
		await expect(preflightCapacityWorkdayRun(store as never, { ...run, parameters: { ...run.parameters,
			agentSelection: { activityTypes: ['acting'] } } })).rejects.toMatchObject({ name: 'ZodError' });
		expect(run).toEqual(held);
	});
	it('reserves infrastructure preparation outside the productive conversation budget', () => {
		expect(conversationRunDurationSeconds(180)).toBe(240);
	});

	it.each(['selected', 'unknown', 'unselected-chat', 'missing-chat', 'corrupt'])('authorizes parent communication from the existing frozen profiles: %s', async (scenario) => {
		const definition = agent('architect');
		const snapshot = compileWorkdayAgentProfileSnapshot([{ id: 'class', slug: 'architect', handler_refs_json: { agents: [{ ...definition,
			activityProfiles: { ...definition.activityProfiles, planning: definition.activityProfiles.chat } }] } }],
			scenario === 'unselected-chat' ? { activityTypes: ['planning'] } : undefined);
		if (scenario === 'corrupt') snapshot.revision = 'invalid';
		if (scenario === 'missing-chat') {
			const missing = { ...definition, activityProfiles: { planning: definition.activityProfiles.chat } };
			Object.assign(snapshot, compileWorkdayAgentProfileSnapshot([{ id: 'class', slug: 'architect', handler_refs_json: { agents: [missing] } }]));
		}
		const store = {
			first: vi.fn(async (query: string) => query.includes('SELECT * FROM capacity_workday_runs')
				? { id: 'parent', execution_kind: 'workday', parameters_json: { agentProfilesByProjectId: { project: snapshot } } } : null),
			all: vi.fn(async (query: string) => query.includes('FROM project_agent_classes')
				? [{ id: 'class', handler_refs_json: { agents: [agent('architect')] } }] : []),
			run: vi.fn(async () => ({ meta: { changes: 1 } })),
			createCapacityWorkdayRun: vi.fn(), tickCapacityWorkdayRun: vi.fn(), updateCapacityWorkdayRun: vi.fn(),
		};
		const result = admitDiscussionInvocations(store, { teamId: 'team', projectId: 'project', projectSlug: 'sdk',
			discussionId: 'discussion', messageId: 'message', messagePath: 'discussion-messages/message.mdx', messageCommit: 'c'.repeat(40),
			contextRefs: [], agentSlugs: [scenario === 'unknown' ? 'engineer' : 'architect'], idempotencyKey: scenario, parentWorkdayId: 'parent', durationSeconds: 180 });
		if (['selected', 'unselected-chat'].includes(scenario)) await expect(result).resolves.toMatchObject([{ status: 'blocked', blocker: 'communication_supply_unavailable' }]);
		else await expect(result).rejects.toMatchObject({ code: scenario === 'corrupt' ? 'capacity_workday_agent_profile_snapshot_invalid' : 'discussion_parent_agent_not_frozen' });
		expect(store.createCapacityWorkdayRun).not.toHaveBeenCalled();
	});
	it.each([
		{ laneMaximum: 1, availableConcurrency: 1, hostAvailable: 1, expectedRuns: 1 },
		{ laneMaximum: 5, availableConcurrency: 1, hostAvailable: 1, expectedRuns: 1 },
		{ laneMaximum: 5, availableConcurrency: 2, hostAvailable: 1, expectedRuns: 1 },
		{ laneMaximum: 5, availableConcurrency: 1, hostAvailable: 0, expectedRuns: 0 },
		{ laneMaximum: 5, availableConcurrency: 0, hostAvailable: 1, expectedRuns: 0 },
		{ laneMaximum: 5, availableConcurrency: -1, hostAvailable: 1, expectedRuns: 0 },
		{ laneMaximum: 5, availableConcurrency: 1.5, hostAvailable: 1, expectedRuns: 0 },
		{ laneMaximum: 5, availableConcurrency: NaN, hostAvailable: 1, expectedRuns: 0 },
		{ laneMaximum: 5, availableConcurrency: Number.MAX_SAFE_INTEGER + 1, hostAvailable: 1, expectedRuns: 0 },
		{ laneMaximum: 5, availableConcurrency: '1', hostAvailable: 1, expectedRuns: 0 },
		{ laneMaximum: 5, availableConcurrency: undefined, hostAvailable: 1, expectedRuns: 0 },
		{ laneMaximum: 5, availableConcurrency: 1, hostAvailable: NaN, expectedRuns: 0 },
	])('keeps group discussions queued when native capacity is below lane maximum: $laneMaximum/$availableConcurrency/$hostAvailable', async ({ laneMaximum, availableConcurrency, hostAvailable, expectedRuns }) => {
		const claimed = new Map<string, { status: string; execution_id: string; blocking_state_json: string }>();
		const createdRuns: string[] = [];
		const store = {
			all: vi.fn(async (query: string) => {
				if (query.includes("status IN ('admitted','running')") && query.includes('agent_invocation_requests')) return [];
				if (query.includes('FROM capacity_provider_team_memberships')) return [{ membership_id: 'membership', capacity_provider_id: 'provider', execution_provider_id: 'codex' }];
				if (query.includes('FROM project_agent_classes')) return [{ id: 'class', handler_refs_json: { agents: [agent('architect'), agent('researcher')] }, metadata_json: { immutableRef: 'a'.repeat(40) } }];
				if (query.includes('FROM capacity_workday_runs')) return [];
				return [];
			}),
			first: vi.fn(async (query: string, params: unknown[] = []) => {
				if (query.includes('capacity_provider_availability_sessions')) return {
					execution_providers_json: [{ id: 'codex', status: 'active', maxConcurrentWorkers: 5,
						activeWorkers: typeof availableConcurrency === 'number' ? 5 - availableConcurrency : 0, availableConcurrency,
						lanes: [{ purpose: 'communication', maxConcurrentWorkers: laneMaximum }] }],
					runner_pressure_json: { maxConcurrentWorkers: 5, activeWorkers: 5 - hostAvailable },
					metadata_json: { runtimeBuild: `sha256:${'b'.repeat(64)}` },
				};
				if (query.includes('COUNT(*) AS count FROM capacity_provider_assignments')) return { count: 0 };
				if (query.includes('SELECT status,execution_id,blocking_state_json FROM agent_invocation_requests')) return claimed.get(String(params[0])) ?? null;
				return null;
			}),
			run: vi.fn(async (query: string, params: unknown[] = []) => {
				if (query.includes('INSERT INTO agent_invocation_requests')) return { meta: { changes: 1 } };
				if (query.includes("SET status='admitted',execution_id=?")) claimed.set(String(params[3]), {
					status: 'admitted', execution_id: String(params[0]), blocking_state_json: String(params[1]),
				});
				return { meta: { changes: 1 } };
			}),
			createCapacityWorkdayRun: vi.fn(async (_teamId: string, input: Record<string, unknown>) => {
				createdRuns.push(String(input.id)); return compileCapacityWorkdayRunRecord(_teamId, input);
			}),
			tickCapacityWorkdayRun: vi.fn(async () => ({})),
			updateCapacityWorkdayRun: vi.fn(async () => null),
		};

		const result = await admitDiscussionInvocations(store, {
			teamId: 'team', projectId: 'project', projectSlug: 'sdk', discussionId: 'acceptance', messageId: 'message',
			messagePath: 'discussion-messages/acceptance/message.mdx', messageCommit: 'c'.repeat(40), contextRefs: [],
			agentSlugs: ['architect', 'researcher'], idempotencyKey: 'send', durationSeconds: 180,
		});

		expect(createdRuns).toHaveLength(expectedRuns);
		if (expectedRuns) expect(store.createCapacityWorkdayRun).toHaveBeenCalledWith('team', expect.objectContaining({
			parameters: expect.objectContaining({ durationSeconds: 240, scheduledProjectIds: ['project'], agentSelection: normalizeWorkdayAgentSelection({ activityTypes: ['chat'] }) }),
		}));
		// Root lanes are shared by capability-specific adapters. Their legacy
		// materialized owner must not veto the current canonical availability report.
		const supplyQuery = store.all.mock.calls.find(([query]) => query.includes('FROM capacity_provider_team_memberships'))?.[0];
		expect(supplyQuery).not.toContain('capacity_provider_lanes');
		expect(result.map((item) => ({ status: item.status, blocker: 'blocker' in item ? item.blocker ?? null : null }))).toEqual([
			expectedRuns ? { status: 'admitted', blocker: null } : { status: 'queued', blocker: 'communication_capacity_queued' },
			{ status: 'queued', blocker: 'communication_capacity_queued' },
		]);
	});

	it('reconciles a parent workday immediately after admitting an addressed message', async () => {
		const snapshot = compileWorkdayAgentProfileSnapshot([{ id: 'class', slug: 'architect',
			handler_refs_json: { agents: [agent('architect')] } }]);
		let admitted = false;
		let blockingState = '{}';
		const events: string[] = [];
		const store = {
			all: vi.fn(async (query: string) => {
				if (query.includes('FROM capacity_provider_team_memberships')) return [{ membership_id: 'membership', capacity_provider_id: 'provider', execution_provider_id: 'codex' }];
				if (query.includes('FROM project_agent_classes')) return [{ id: 'class', handler_refs_json: { agents: [agent('architect')] }, metadata_json: { immutableRef: 'a'.repeat(40) } }];
				return [];
			}),
			first: vi.fn(async (query: string) => {
				if (query.includes('SELECT * FROM capacity_workday_runs')) return { id: 'parent', execution_kind: 'workday',
					parameters_json: { agentProfilesByProjectId: { project: snapshot } } };
				if (query.includes('capacity_provider_availability_sessions')) return {
					execution_providers_json: [{ id: 'codex', status: 'active', maxConcurrentWorkers: 1,
						lanes: [{ purpose: 'communication', maxConcurrentWorkers: 1 }] }],
					metadata_json: { runtimeBuild: `sha256:${'b'.repeat(64)}` },
				};
				if (query.includes('COUNT(*) AS count FROM capacity_provider_assignments')) return { count: 0 };
				if (query.includes('SELECT status,execution_id,blocking_state_json FROM agent_invocation_requests')) {
					return admitted ? { status: 'admitted', execution_id: 'parent', blocking_state_json: blockingState } : null;
				}
				return null;
			}),
			run: vi.fn(async (query: string, values: unknown[] = []) => {
				if (query.includes('INSERT INTO agent_invocation_requests')) return { meta: { changes: 1 } };
				if (query.includes("SET status='admitted'") || query.includes("SET status = 'admitted'")) {
					admitted = true;
					if (query.includes('communication_admission_claimed') || query.includes('blocking_state_json=?')) blockingState = String(values[1] ?? '{}');
					events.push('claim');
				}
				return { meta: { changes: 1 } };
			}),
			createCapacityWorkdayRun: vi.fn(),
			tickCapacityWorkdayRun: vi.fn(async () => { events.push('tick'); return {}; }),
			updateCapacityWorkdayRun: vi.fn(),
		};
		await expect(admitDiscussionInvocations(store, { teamId: 'team', projectId: 'project', projectSlug: 'sdk',
			discussionId: 'discussion', messageId: 'message', messagePath: 'discussion-messages/discussion/message.mdx',
			messageCommit: 'c'.repeat(40), contextRefs: [], agentSlugs: ['architect'], idempotencyKey: 'parent-send',
			parentWorkdayId: 'parent', durationSeconds: 180 })).resolves.toMatchObject([{ status: 'admitted', executionId: 'parent' }]);
		expect(store.createCapacityWorkdayRun).not.toHaveBeenCalled();
		expect(store.tickCapacityWorkdayRun).toHaveBeenCalledWith('team', 'parent', expect.any(String), expect.stringContaining('discussion-invocation:'));
		expect(events.slice(0, 2)).toEqual(['claim', 'tick']);
	});
});
