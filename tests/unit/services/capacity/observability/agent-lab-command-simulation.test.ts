import { describe, expect, it } from 'vitest';
import { AgentLabCommandService } from '../../../../../src/api/capacity/services/capacity/observability/agent-lab-command-service.ts';

describe('Agent Lab simulation command projection', () => {
	it('links a completed launch operation to the real correlated workday', async () => {
		const store = {
			all: async (query: string) => query.includes('platform_operations') ? [{
				id: 'operation-1',
				status: 'succeeded',
				created_at: '2026-08-12T10:00:00.000Z',
				input_json: JSON.stringify({
					teamId: 'team-1',
					projectId: 'project-1',
					scenePath: 'scenes/agent-lab/guide-steward.yaml',
					immutableRef: 'a'.repeat(40),
				}),
				output_json: JSON.stringify({ runId: 'scene-run-1', sceneId: 'guide-steward' }),
			}] : [],
			first: async () => null,
			governanceProposalReadiness: async () => null,
		};
		const snapshot = {
			overview: {
				revision: 'revision-1',
				generatedAt: '2026-08-12T10:01:00.000Z',
				team: { id: 'team-1', name: 'Team One' },
			},
			rows: {
				projects: [{ id: 'project-1', name: 'Project One' }],
				workdays: [{
					id: 'workday-1',
					status: 'running',
					created_at: '2026-08-12T10:00:10.000Z',
					metadata_json: JSON.stringify({ agentLab: { runId: 'scene-run-1' } }),
				}],
				assignments: [], executions: [], agents: [], events: [], classes: [],
			},
			artifacts: [],
		};

		const projection = await new AgentLabCommandService(store).surface('build', snapshot as never);
		const simulation = projection.items.find((item) => item.kind === 'simulation');

		expect(simulation).toMatchObject({
			id: 'operation-1',
			status: 'succeeded',
			projectId: 'project-1',
			data: { workdayId: 'workday-1' },
		});
	});
});
