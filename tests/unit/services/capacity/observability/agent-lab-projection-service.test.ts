import { describe, expect, it, vi } from 'vitest';
import { AgentLabProjectionService, operatingDay } from '../../../../../src/api/capacity/services/capacity/observability/agent-lab-projection-service.ts';

const startedAt = '2026-08-03T14:00:00.000Z';
const completedAt = '2026-08-03T14:10:00.000Z';
const output = JSON.stringify({ artifactManifest: { contentReferences: [
	{ receiptId: 'receipt-a', model: 'note', contentPath: 'notes/a.mdx' },
	{ receiptId: 'receipt-a', model: 'note', contentPath: 'notes/a.mdx' },
] } });

function fixtureStore() {
	const all = vi.fn(async (query: string) => {
		if (query.includes('FROM projects')) return [{ id: 'project-a', name: 'Guide' }, { id: 'project-b', name: 'Platform' }];
		if (query.includes('capacity_workday_runs')) return [{ id: 'day-a', scenario_id: 'editorial', status: 'completed', created_at: startedAt, completed_at: completedAt, updated_at: completedAt }];
		if (query.includes('capacity_workday_events')) return [{ id: 'event-a', event_type: 'execution.started', created_at: startedAt, event_index: 1 }];
		if (query.includes('FROM capacity_provider_assignments assignment')) return [{ id: 'assignment-a', project_id: 'project-a', project_name: 'Guide', status: 'completed', created_at: startedAt, completed_at: completedAt, updated_at: completedAt }];
		if (query.includes('FROM agent_mode_runs')) return [{ id: 'execution-a', provider_assignment_id: 'assignment-a', project_id: 'project-a', project_name: 'Guide', agent_id: 'guide-steward', project_agent_class_id: 'steward', handler_id: 'estimate', status: 'succeeded', started_at: startedAt, completed_at: completedAt, updated_at: completedAt, outputs_json: output, lifecycle_output_json: output, selected_input_json: JSON.stringify({ activityType: 'estimating' }), assignment_state_version: 3, execution_provider_id: 'codex' }];
		if (query.includes('capacity_provider_availability_sessions')) return [{ id: 'provider-a', status: 'open', updated_at: startedAt }];
		if (query.includes('project_agent_classes')) return [{ id: 'steward', slug: 'guide-steward', name: 'Guide Steward', status: 'active', updated_at: startedAt }];
		return [];
	});
	return { ensureInitialized: vi.fn(), first: vi.fn(async (query: string) => query.includes('FROM teams') ? { id: 'team-a', name: 'Editorial' } : null), all,
		getProjectAgentsSummary: vi.fn(async (projectId: string) => ({ agents: projectId === 'project-a' ? [{ agentSlug: 'guide-steward', name: 'Guide Steward', status: 'active' }] : [] })) };
}

describe('Agent Lab projection service', () => {
	it('uses the signed-in time zone for DST-sensitive operating-day bounds', () => {
		const result = operatingDay(new Date('2026-03-08T16:00:00.000Z'), 'America/New_York');
		expect(result).toEqual({ start: '2026-03-08T05:00:00.000Z', end: '2026-03-09T04:00:00.000Z' });
	});

	it('derives native attempt metrics and deduplicates durable artifacts', async () => {
		const service = new AgentLabProjectionService(fixtureStore());
		const snapshot = await service.snapshot('team-a', 'America/New_York', new Date('2026-08-03T16:00:00.000Z'));
		expect(Object.fromEntries(snapshot!.overview.metrics.map((metric) => [metric.key, metric.value]))).toMatchObject({ agents: 1, workdays: 1, systemEvents: 1, assignments: 1, executions: 1, artifacts: 1, passed: 1, failed: 0, running: 0 });
		expect(service.activity(snapshot!.rows)[0]).toMatchObject({ activityProfile: 'estimating', status: 'succeeded', stateVersion: 3 });
		const series = service.series(snapshot!.rows, snapshot!.overview.operatingDay, new Date('2026-08-03T16:00:00.000Z'));
		expect(series.at(-1)?.statistics.assignments).toMatchObject({ semantic: 'cumulative', exactTotal: 1, mean: 0.5, standardDeviation: 0.5, low: 0, high: 1, sampleSize: 2 });
		expect(series.at(-1)?.statistics.workdays).toMatchObject({ semantic: 'exact-total', exactTotal: 1, mean: 1, standardDeviation: null, sampleSize: 1 });
		expect(series.at(-1)?.statistics.running?.semantic).toBe('instantaneous');
		expect(snapshot!.overview.workdayContext).toMatchObject({ selectedDate: '2026-08-03', selectedWorkdayId: null, latestWorkdayId: 'day-a' });
	});
});
