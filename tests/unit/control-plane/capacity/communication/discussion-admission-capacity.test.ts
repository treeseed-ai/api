import { describe, expect, it, vi } from 'vitest';
import { admitDiscussionInvocations } from '../../../../../src/api/capacity/services/capacity/invocations/discussion-invocation-service.ts';

const permissions = { content: { read: ['knowledge', 'discussion'], write: ['discussion'] }, tools: ['discussion', 'source.read'] };
const agent = (slug: string) => ({
	schemaVersion: 'treeseed.agent/v1', id: `sdk/${slug}`, name: slug, agentClass: slug,
	purpose: `Perform ${slug} work.`, responsibilities: [`Perform ${slug} work.`], capabilities: ['repository-analysis'],
	context: { include: ['project-objectives'] },
	activityProfiles: { chat: { handler: 'writer', permissions, prompt: { system: 'Answer with exact evidence.' } } },
});

describe('discussion invocation capacity admission', () => {
	it('starts only one conversation execution when the communication lane has one worker', async () => {
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
					execution_providers_json: [{ id: 'codex', status: 'active', maxConcurrentWorkers: 1, lanes: [{ purpose: 'communication', maxConcurrentWorkers: 1 }] }],
					metadata_json: { sourceClosureDigest: `sha256:${'b'.repeat(64)}` },
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
				createdRuns.push(String(input.id)); return { id: input.id };
			}),
			tickCapacityWorkdayRun: vi.fn(async () => ({})),
			updateCapacityWorkdayRun: vi.fn(async () => null),
		};

		const result = await admitDiscussionInvocations(store, {
			teamId: 'team', projectId: 'project', projectSlug: 'sdk', discussionId: 'acceptance', messageId: 'message',
			messagePath: 'discussion-messages/acceptance/message.mdx', messageCommit: 'c'.repeat(40), contextRefs: [],
			agentSlugs: ['architect', 'researcher'], idempotencyKey: 'send', durationSeconds: 180,
		});

		expect(createdRuns).toHaveLength(1);
		// Root lanes are shared by capability-specific adapters. Their legacy
		// materialized owner must not veto the current canonical availability report.
		const supplyQuery = store.all.mock.calls.find(([query]) => query.includes('FROM capacity_provider_team_memberships'))?.[0];
		expect(supplyQuery).not.toContain('capacity_provider_lanes');
		expect(result.map((item) => ({ status: item.status, blocker: item.blocker ?? null }))).toEqual([
			{ status: 'admitted', blocker: null },
			{ status: 'queued', blocker: 'communication_capacity_queued' },
		]);
	});
});
