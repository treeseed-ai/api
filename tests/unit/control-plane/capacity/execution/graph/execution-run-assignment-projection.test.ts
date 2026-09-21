import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('../../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts', () => ({
	ProviderAssignmentRepository: class { list = mocks.list; },
}));

import { listExecutionRunsForTeamPage } from '../../../../../../src/api/capacity/repositories/support/execution-run.ts';

describe('execution-run assignment projection', () => {
	it('reads one immutable assignment/result without querying mode-run state', async () => {
		mocks.list.mockResolvedValueOnce({ page: { limit: 10, hasMore: false, nextCursor: null }, items: [{
			id: 'assignment-1', status: 'completed', mode: 'acting', createdAt: '2026-09-20T10:00:00.000Z',
			assignedAt: '2026-09-20T10:00:00.000Z', claimedAt: '2026-09-20T10:00:01.000Z',
			completedAt: '2026-09-20T10:00:04.000Z', failedAt: null, returnedAt: null,
			teamId: 'team-1', projectId: 'sdk', projectAgentClassId: 'engineer', agentId: 'agent-1',
			handlerId: 'actor', executionProviderId: 'codex-implementation', capacityProviderId: 'provider-1',
			workDayId: 'workday-1', assignmentResult: { assignmentId: 'assignment-1', references: [{ kind: 'git',
				repository: 'treeseed-ai/sdk', commit: 'a'.repeat(40) }], usage: { modelInputTokens: 40, modelOutputTokens: 10 } },
		} ] });
		const database = { all: vi.fn(() => { throw new Error('mode-run query forbidden'); }) };
		const page = await listExecutionRunsForTeamPage(database as never, 'team-1', { projection: 'activity' });
		expect(mocks.list).toHaveBeenCalledWith('team-1', { projection: 'activity' });
		expect(page.items[0]).toMatchObject({ id: 'assignment-1', status: 'completed',
			executionProvider: { tokenCounts: { inputTokens: 40, outputTokens: 10 } },
			contentArtifactRefs: [{ kind: 'git', repository: 'treeseed-ai/sdk' }] });
		expect(database.all).not.toHaveBeenCalled();
	});
});
