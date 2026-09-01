import { describe, expect, it, vi } from 'vitest';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { createKnowledgeShareOperations } from '../../../../src/api/control-plane/catalog/knowledge-sharing/operations.ts';

const context = {
	interface: 'rest' as const,
	requestId: 'request-1',
	principal: { id: 'user-1', roles: ['team_owner'] },
};

function fixture() {
	const invokeAuthorizedFederation = vi.fn(async (input) => ({ sources: input.projects }));
	const store = {
		principalCanAccessTeam: vi.fn(async () => true),
		resolvePrincipalTeamContext: vi.fn(async () => ({ roles: ['team_owner'] })),
		listTeamProjects: vi.fn(async () => [
			{ id: 'project-local', slug: 'local', teamId: 'team-target' },
		]),
		listTreeDxSharesForRecipient: vi.fn(async () => [{
			id: 'share-1', teamId: 'team-source', targetTeamId: 'team-target', status: 'active', expiresAt: null,
			trustGrant: { projectIds: ['project-shared'], contentModels: ['knowledge'], paths: ['knowledge/**'], operations: ['query'] },
		}]),
	};
	const operations = createKnowledgeShareOperations({ store, treeDxProxy: { invokeAuthorizedFederation } as never });
	return { operations, invokeAuthorizedFederation };
}

describe('team knowledge share operations', () => {
	it('accepts a scalar model filter and preserves source path bounds', async () => {
		const { operations, invokeAuthorizedFederation } = fixture();
		const operation = operations.find(({ binding }) => binding === CONTROL_PLANE_OPERATIONS.knowledge.teamQuery)!;
		await operation.handler({
			path: { teamId: 'team-target' }, query: {}, body: {
				projectIds: [], projectSlugs: [],
				sharedSources: [{ teamId: 'team-source', projectIds: ['project-shared'] }],
				request: { filters: { model: 'knowledge' } },
			},
		}, context);
		expect(invokeAuthorizedFederation).toHaveBeenCalledWith(expect.objectContaining({
			teamId: 'team-target',
			projects: [
				{ projectId: 'project-local', paths: ['**'] },
				{ projectId: 'project-shared', paths: ['knowledge/**'] },
			],
		}));
	});

	it('does not include shared-team projects unless the request names the source team', async () => {
		const { operations, invokeAuthorizedFederation } = fixture();
		const operation = operations.find(({ binding }) => binding === CONTROL_PLANE_OPERATIONS.knowledge.teamQuery)!;
		await operation.handler({ path: { teamId: 'team-target' }, query: {}, body: {
			projectIds: [], projectSlugs: [], sharedSources: [], request: { filters: { model: 'knowledge' } },
		} }, context);
		expect(invokeAuthorizedFederation.mock.calls[0]![0].projects).toEqual([{ projectId: 'project-local', paths: ['**'] }]);
	});

	it('fails closed instead of broadening an unknown project selector to every same-team project',async()=>{
		const {operations,invokeAuthorizedFederation}=fixture();
		const operation=operations.find(({binding})=>binding===CONTROL_PLANE_OPERATIONS.knowledge.teamQuery)!;
		await expect(operation.handler({path:{teamId:'team-target'},query:{},body:{projectIds:[],projectSlugs:['missing'],sharedSources:[],request:{filters:{model:'knowledge'}}}},context)).rejects.toMatchObject({code:'knowledge_project_not_found'});
		expect(invokeAuthorizedFederation).not.toHaveBeenCalled();
	});
});
