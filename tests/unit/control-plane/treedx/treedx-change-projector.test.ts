import { beforeEach, describe, expect, it, vi } from 'vitest';

const { reconcileExecutionGraph } = vi.hoisted(() => ({ reconcileExecutionGraph: vi.fn() }));
vi.mock('../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-service.ts', () => ({ reconcileExecutionGraph }));

import { projectTreeDxCommitSignals } from '../../../../src/api/capacity/services/treedx/repositories/treedx-change-projector.ts';

function database() {
	return {
		first: vi.fn(async (sql: string) => sql.includes('FROM projects') ? { team_id: 'team-1' } : { repository_id: 'repo-1' }),
		run: vi.fn(async () => undefined),
	};
}

describe('TreeDX change projection', () => {
	beforeEach(() => reconcileExecutionGraph.mockReset());

	it('does not feed a terminal Reporter note back into the execution graph', async () => {
		await projectTreeDxCommitSignals(database() as never, {
			projectId: 'project-1', commitSha: 'a'.repeat(40), changedPaths: ['notes/workday-report.mdx'],
			changeSummary: 'Committed workday report.', assignmentId: 'assignment-1', activityType: 'reporting', actorType: 'capacity_provider',
		});
		expect(reconcileExecutionGraph).not.toHaveBeenCalled();
	});

	it('does not treat an unpublished estimating result as new execution intent', async () => {
		await projectTreeDxCommitSignals(database() as never, {
			projectId: 'project-1', commitSha: 'b'.repeat(40), changedPaths: ['proposals/change.mdx'],
			changeSummary: 'Committed estimate.', assignmentId: 'assignment-2', activityType: 'estimating', actorType: 'capacity_provider',
		});
		expect(reconcileExecutionGraph).not.toHaveBeenCalled();
	});

	it('continues to reconcile authoritative proposal changes outside assignments', async () => {
		await projectTreeDxCommitSignals(database() as never, {
			projectId: 'project-1', commitSha: 'c'.repeat(40), changedPaths: ['proposals/change.mdx'],
			changeSummary: 'Committed proposal.', actorType: 'user',
		});
		expect(reconcileExecutionGraph).toHaveBeenCalledOnce();
	});
});
