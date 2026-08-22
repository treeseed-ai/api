import { describe, expect, it } from 'vitest';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { createProjectUpdateOperation } from '../../../../src/api/control-plane/catalog/project-operations.ts';

const dependencies = (overrides: Record<string, unknown> = {}) => ({
	capacity: { async evaluateProjectDeletionBlockers() { return []; } },
	store: {
		async getProjectDetails() { return { project: { id: 'project-1', teamId: 'team-1', slug: 'sdk', name: 'SDK', updatedAt: 'revision-1', metadata: {} } }; },
		async principalCanAccessTeam() { return true; }, async principalCanManageTeam() { return true; },
		async getProjectByTeamAndSlug() { return null; },
		async updateProject(id: string, input: Record<string, unknown>) { return { id, ...input, updatedAt: 'revision-2' }; },
		async recordAuditEvent() {}, ...overrides,
	},
}) as any;

describe('project update operation', () => {
	it('binds the last retained project operation and passes its exact revision into persistence', async () => {
		let update: Record<string, unknown> | undefined;
		const operation = createProjectUpdateOperation(dependencies({ async updateProject(id: string, input: Record<string, unknown>) { update = input; return { id, ...input, updatedAt: 'revision-2' }; } }));
		expect(operation.binding).toBe(CONTROL_PLANE_OPERATIONS.projects.update);
		await expect(operation.handler({ path: { projectId: 'project-1' }, query: {}, body: { name: 'Portable SDK' } }, { interface: 'rest', requestId: 'request-1', ifMatch: 'revision-1', principal: { id: 'user-1' } }))
			.resolves.toMatchObject({ id: 'project-1', name: 'Portable SDK', expectedRevision: 'revision-1' });
		expect(update).toMatchObject({ expectedRevision: 'revision-1' });
	});

	it('rejects a stale project revision before persistence', async () => {
		const operation = createProjectUpdateOperation(dependencies());
		await expect(operation.handler({ path: { projectId: 'project-1' }, query: {}, body: { name: 'Portable SDK' } }, { interface: 'rest', requestId: 'request-1', ifMatch: 'stale', principal: { id: 'user-1' } }))
			.rejects.toMatchObject({ status: 412, code: 'project_revision_changed' });
	});
});
