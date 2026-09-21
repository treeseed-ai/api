import { describe, expect, it, vi } from 'vitest';
import { buildProjectAgentSummary } from '../../../../../src/api/capacity/services/projects/agents/project-agent-summary-service.ts';

describe('project agent health summary', () => {
	it('uses assignment state rather than retired mode-run telemetry', async () => {
		const store = {
			getProjectDetails: vi.fn(async () => ({ id: 'project', teamId: 'team' })),
			listApprovalRequestsForProject: vi.fn(async () => []),
			all: vi.fn(async () => [{ id: 'run', status: 'running', summary: { completedAssignments: 2 }, createdAt: '2026-09-20T00:00:00Z' }]),
			listProviderAssignmentsPage: vi.fn(async () => ({ items: [
				{ id: 'active', agentId: 'engineer', status: 'running' },
				{ id: 'failed', agentId: 'tester', status: 'failed' },
			], page: { hasMore: false } })),
		};
		const summary = await buildProjectAgentSummary(store, 'project');
		expect(store.listProviderAssignmentsPage).toHaveBeenCalledWith('team', { projectId: 'project', limit: 200 });
		expect(store.all.mock.calls[0]?.[0]).toContain('capacity_workday_runs');
		expect(summary?.currentWorkday).toMatchObject({ id: 'run', status: 'running' });
		expect(summary?.runtimeReports[0]).toMatchObject({ workDayId: 'run', summary: { completedAssignments: 2 } });
		expect(summary?.taskHealth.activeTasks).toEqual([expect.objectContaining({ id: 'active' })]);
		expect(summary?.docsAutomation.verificationFailureCount).toBe(1);
		expect(summary?.agents).toEqual(expect.arrayContaining([
			expect.objectContaining({ agentSlug: 'engineer', status: 'active' }),
			expect.objectContaining({ agentSlug: 'tester', status: 'idle' }),
		]));
	});
});
