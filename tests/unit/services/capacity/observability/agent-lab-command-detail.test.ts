import { describe, expect, it } from 'vitest';
import { AgentLabCommandService } from '../../../../../src/api/capacity/services/capacity/observability/agent-lab-command-service.ts';

function snapshot() {
	return {
		overview: { revision: 'revision-1', generatedAt: '2026-08-12T10:00:00.000Z', team: { id: 'team-1', name: 'Team One' } },
		rows: {
			projects: [{ id: 'project-1', name: 'Project One' }], workdays: [], assignments: [], executions: [], classes: [],
			agents: [{ id: 'reviewer', slug: 'reviewer', name: 'Reviewer', project_id: 'project-1' }],
			events: [
				{ id: 'unrelated', event_type: 'workday.tick', created_at: '2026-08-12T09:58:00.000Z', payload_json: '{}' },
				{ id: 'related', event_type: 'agent.updated', created_at: '2026-08-12T09:59:00.000Z', project_id: 'project-1', payload_json: JSON.stringify({ agentId: 'reviewer' }) },
			],
		},
		artifacts: [],
	};
}

describe('Agent Lab command detail evidence', () => {
	it('builds the agent surface without loading unrelated governance records', async () => {
		const queries: string[] = [];
		const store = { all: async (query: string) => { queries.push(query); return []; }, first: async () => null, governanceProposalReadiness: async () => { throw new Error('Build must not resolve proposal readiness.'); } };
		const payload = await new AgentLabCommandService(store).surface('build', snapshot() as never);
		expect(payload.items).toHaveLength(1);
		expect(payload.projects).toEqual([{ id: 'project-1', name: 'Project One' }]);
		expect(queries.some((query) => query.includes('governance_'))).toBe(false);
		expect(queries).toEqual([expect.stringContaining('platform_operations')]);
	});

	it('does not attach every unscoped team event to an agent without an assignment', async () => {
		const store = { all: async () => [], first: async () => null, governanceProposalReadiness: async () => null };
		const detail = await new AgentLabCommandService(store).detail('agent', 'reviewer', snapshot() as never);
		expect(detail?.timeline.map((entry) => entry.id)).toEqual(['related']);
		expect(detail?.metrics).toContainEqual({ label: 'Events', value: 1 });
	});

	it('hydrates heavyweight execution evidence only when its detail is opened', async () => {
		const execution = { id: 'execution-1', kind: 'execution', title: 'Run', description: '', status: 'succeeded', projectId: 'project-1', projectName: 'Project One', occurredAt: '2026-08-12T09:59:00.000Z', data: { id: 'execution-1', provider_assignment_id: 'assignment-1' } };
		const state = snapshot(); state.rows.executions = [execution.data as never];
		const first = async (query: string) => query.includes('FROM agent_mode_runs mode_run') ? { ...execution.data, transcript_json: JSON.stringify({ messages: ['full evidence'] }) } : null;
		const service = new AgentLabCommandService({ all: async () => [], first, governanceProposalReadiness: async () => null });
		service.surface = async () => ({ revision: 'revision-1', generatedAt: state.overview.generatedAt, surface: 'direction', title: 'Direction', description: '', unreadCount: 0, items: [execution], page: { hasMore: false, nextCursor: null, total: 1 } }) as never;
		const detail = await service.detail('execution', 'execution-1', state as never);
		expect(detail?.data).toMatchObject({ transcript_json: JSON.stringify({ messages: ['full evidence'] }) });
	});
});
