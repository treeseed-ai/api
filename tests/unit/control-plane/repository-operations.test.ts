import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { createRepositoryOperations } from '../../../src/api/control-plane/catalog/repositories/index.ts';
import { createProjectRepositoryService } from '../../../src/api/control-plane/repositories/project-repository-service.ts';

const principal = { id: 'user-1', roles: ['team_manager'] };
const topology = {
	contentRepository: { accessMode: 'treedx', githubUrl: null, defaultBranch: null, ref: null, contentPath: 'src/content',
		treeDx: { instanceId: 'treedx-1', libraryId: 'library-1', repositoryId: 'repository-1', baseUrl: null }, remote: null, r2: {} },
	siteRepository: { accessMode: 'filesystem', provider: 'github', owner: null, name: 'site', url: null,
		defaultBranch: 'staging', ref: null, checkoutPath: null, volumePath: null, submoduleMountPath: null, siteSubmodulePath: null },
	projectRepository: null,
};

describe('repository catalog operations', () => {
	it('binds topology operations to the API-owned service', async () => {
		const repositories = { topology: vi.fn(async () => topology), status: vi.fn(async () => ({ drift: 'none' })),
			update: vi.fn(async () => topology) };
		const operations = createRepositoryOperations({ repositories });
		expect(operations.map((operation) => operation.binding)).toEqual([
			CONTROL_PLANE_OPERATIONS.projects.repositoryTopology,
			CONTROL_PLANE_OPERATIONS.projects.repositoryTopologyStatus,
			CONTROL_PLANE_OPERATIONS.projects.updateRepositoryTopology,
		]);
		await operations[2].handler({ path: { projectId: 'project-1' }, query: {}, body: topology },
			{ interface: 'rest', requestId: 'request-1', principal, ifMatch: 'sha256:current' });
		expect(repositories.update).toHaveBeenCalledWith(principal, 'project-1', topology, 'sha256:current');
	});

	it('requires exact read-back evidence before updating topology', async () => {
		const store = {
			getProjectDetails: vi.fn(async () => ({ project: { id: 'project-1', teamId: 'team-1' } })),
			principalCanAccessTeam: vi.fn(async () => true), principalCanManageTeam: vi.fn(async () => true),
			getProjectRepositoryTopology: vi.fn(async () => topology),
			upsertProjectRepositoryTopology: vi.fn(async () => topology), recordAuditEvent: vi.fn(async () => undefined),
		};
		const service = createProjectRepositoryService(store);
		await expect(service.update(principal, 'project-1', topology, 'sha256:stale')).rejects.toMatchObject({
			status: 412, code: 'repository_topology_precondition_failed',
		});
		const current = `sha256:${createHash('sha256').update(JSON.stringify(topology)).digest('hex')}`;
		await expect(service.update(principal, 'project-1', topology, current)).resolves.toEqual(topology);
		expect(store.upsertProjectRepositoryTopology).toHaveBeenCalledWith('project-1', topology);
		expect(store.recordAuditEvent).toHaveBeenCalledOnce();
	});
});
