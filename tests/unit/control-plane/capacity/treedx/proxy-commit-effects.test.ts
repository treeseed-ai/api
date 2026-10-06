import { beforeEach, expect, it, vi } from 'vitest';

const effects = vi.hoisted(() => ({ signals: vi.fn(), authoring: vi.fn() }));
vi.mock('../../../../../src/api/capacity/services/treedx/repositories/treedx-change-projector.ts', () => ({
	projectTreeDxCommitSignals: effects.signals,
}));
vi.mock('../../../../../src/api/capacity/services/treedx/repositories/treedx-authoring-journal.ts', () => ({
	recordTreeDxAuthoringState: effects.authoring,
}));

import { projectTreeDxProxyCommit } from '../../../../../src/api/capacity/services/treedx/repositories/treedx-proxy-effects.ts';

beforeEach(() => {
	effects.signals.mockReset();
	effects.authoring.mockReset();
});

it('projects the durable assignment workday identity after a TreeDX commit', async () => {
	const store = { getProjectTreeDxLibrary: vi.fn(async () => ({ repositoryId: 'repository' })) };
	await projectTreeDxProxyCommit({
		store: store as never,
		projectId: 'project', method: 'POST', path: '/workspaces/workspace/commit',
		body: { message: 'Planning contribution.' },
		payload: { commit: { commitSha: 'a'.repeat(40), branchName: 'refs/heads/assignment', changedPaths: ['notes/result.mdx'] } },
		access: {
			actorType: 'capacity_provider', principal: { capacityProviderId: 'provider' },
			handle: { repositoryId: 'repository' },
			assignment: { id: 'assignment', workDayId: 'workday', agentId: 'sdk/architect',
				assignmentAttempt: { effectiveProfile: { activity: 'planning' } } },
		},
	});
	expect(effects.signals).toHaveBeenCalledWith(store, expect.objectContaining({
		assignmentId: 'assignment', workdayRunId: 'workday', agentId: 'sdk/architect', activityType: 'planning',
	}));
});
