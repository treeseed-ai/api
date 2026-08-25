import { describe, expect, it, vi } from 'vitest';
import { createProjectDeleteOperation } from '../../../../src/api/control-plane/catalog/project-operations.ts';

function dependencies(invoke = vi.fn(async () => ({ result: { alreadyRetired: false } }))) {
	const run = vi.fn(async () => undefined);
	const updateProject = vi.fn(async () => ({ id: 'project-1', updatedAt: 'next' }));
	return {
		invoke, run, updateProject,
		value: {
			capacity: { evaluateProjectDeletionBlockers: vi.fn(async () => []) },
			treeDxProxy: { invoke },
			store: {
				getProjectDetails: vi.fn(async () => ({ project: { id: 'project-1', teamId: 'team-1', slug: 'knowledge', updatedAt: 'revision-1', metadata: {} } })),
				getProjectTreeDxLibrary: vi.fn(async () => ({ repositoryId: 'repo-knowledge' })),
				updateProject, run,
				recordAuditEvent: vi.fn(async () => undefined),
			},
		},
	};
}

describe('project deletion virtual knowledge lifecycle', () => {
	it('marks deletion pending, retires TreeDX, and only then deletes the project', async () => {
		const fixture = dependencies();
		const operation = createProjectDeleteOperation(fixture.value as never);
		const result = await operation.handler({
			path: { projectId: 'project-1' }, query: {}, body: { confirmation: 'DELETE knowledge' },
		}, {
			principal: { id: 'user-1', roles: ['admin'] }, ifMatch: 'revision-1', idempotencyKey: 'delete-project-1',
			requestId: 'request-1', interface: 'rest',
		} as never);
		expect(fixture.updateProject).toHaveBeenCalledBefore(fixture.invoke);
		expect(fixture.invoke).toHaveBeenCalledWith(expect.objectContaining({ operationId: 'treedx.repositories.retire' }), {
			path: { projectId: 'project-1', repoId: 'repo-knowledge' }, query: {}, body: {},
		}, expect.any(Object));
		expect(fixture.invoke).toHaveBeenCalledBefore(fixture.run);
		expect(result).toMatchObject({ id: 'project-1', deleted: true });
	});

	it('keeps the deletion-pending project when TreeDX retirement fails', async () => {
		const fixture = dependencies(vi.fn(async () => { throw { status: 503, code: 'treedx_unavailable', message: 'Unavailable.' }; }));
		const operation = createProjectDeleteOperation(fixture.value as never);
		await expect(operation.handler({
			path: { projectId: 'project-1' }, query: {}, body: { confirmation: 'DELETE knowledge' },
		}, { principal: { id: 'user-1', roles: ['admin'] }, ifMatch: 'revision-1', idempotencyKey: 'delete-project-1' } as never))
			.rejects.toMatchObject({ status: 503, code: 'treedx_unavailable' });
		expect(fixture.updateProject).toHaveBeenCalledOnce();
		expect(fixture.run).not.toHaveBeenCalled();
	});
});
