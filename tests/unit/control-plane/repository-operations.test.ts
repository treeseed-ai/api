import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { createRepositoryOperations } from '../../../src/api/control-plane/catalog/repositories/index.ts';
import { createProjectRepositoryService } from '../../../src/api/control-plane/repositories/project-repository-service.ts';
import { createWorkflowService } from '../../../src/api/control-plane/repositories/workflow-service.ts';

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
		const workflows = { operations: vi.fn(async () => ({ items: [] })), runs: vi.fn(async () => ({ items: [] })),
			update: vi.fn(async () => ({ id: 'workflow-1' })), dispatch: vi.fn(async () => ({ id: 'run-1' })),
			run: vi.fn(async () => ({ id: 'run-1' })), cancel: vi.fn(async () => ({ id: 'run-1', status: 'cancelling' })),
			artifacts: vi.fn(async () => ({ items: [] })) };
		const workflowConfiguration = { publicKey: vi.fn(async () => ({ keyId: 'key-1' })), list: vi.fn(async () => ({ items: [] })),
			put: vi.fn(async () => ({ operation: { id: 'operation-1' } })), remove: vi.fn(async () => ({ operation: { id: 'operation-2' } })) };
		const githubConnector = { setup: vi.fn(async () => ({ redirect: 'https://github.com/apps/example/installations/new' })),
			callback: vi.fn(async () => ({ redirect: 'https://github.com/login/oauth/authorize' })) };
		const githubWebhook = vi.fn(async () => ({ code: 'webhook_processed' }));
		const operations = createRepositoryOperations({ repositories, workflows, workflowConfiguration, githubConnector, githubWebhook });
		expect(operations.map((operation) => operation.binding)).toEqual([
			CONTROL_PLANE_OPERATIONS.repositories.githubSetup,
			CONTROL_PLANE_OPERATIONS.repositories.githubCallback,
			CONTROL_PLANE_OPERATIONS.repositories.githubWebhook,
			CONTROL_PLANE_OPERATIONS.projects.repositoryTopology,
			CONTROL_PLANE_OPERATIONS.projects.repositoryTopologyStatus,
			CONTROL_PLANE_OPERATIONS.projects.updateRepositoryTopology,
			CONTROL_PLANE_OPERATIONS.repositories.workflowOperations,
			CONTROL_PLANE_OPERATIONS.repositories.workflowRuns,
			CONTROL_PLANE_OPERATIONS.repositories.updateWorkflow,
			CONTROL_PLANE_OPERATIONS.repositories.dispatchWorkflow,
			CONTROL_PLANE_OPERATIONS.repositories.workflowRun,
			CONTROL_PLANE_OPERATIONS.repositories.cancelWorkflowRun,
			CONTROL_PLANE_OPERATIONS.repositories.workflowArtifacts,
			CONTROL_PLANE_OPERATIONS.repositories.workflowPublicKey,
			CONTROL_PLANE_OPERATIONS.repositories.workflowSecrets,
			CONTROL_PLANE_OPERATIONS.repositories.putWorkflowSecret,
			CONTROL_PLANE_OPERATIONS.repositories.deleteWorkflowSecret,
			CONTROL_PLANE_OPERATIONS.repositories.workflowVariables,
			CONTROL_PLANE_OPERATIONS.repositories.putWorkflowVariable,
			CONTROL_PLANE_OPERATIONS.repositories.deleteWorkflowVariable,
		]);
		await operations[5].handler({ path: { projectId: 'project-1' }, query: {}, body: topology },
			{ interface: 'rest', requestId: 'request-1', principal, ifMatch: 'sha256:current' });
		expect(repositories.update).toHaveBeenCalledWith(principal, 'project-1', topology, 'sha256:current');
		await operations[9].handler({ path: { projectId: 'project-1', operationId: 'workflow-1' }, query: {}, body: { ref: 'refs/heads/staging' } },
			{ interface: 'rest', requestId: 'request-2', principal, idempotencyKey: 'dispatch-1' });
		expect(workflows.dispatch).toHaveBeenCalledWith(principal, 'project-1', 'workflow-1', { ref: 'refs/heads/staging' }, 'dispatch-1');
		const variable = { repositoryBindingId: 'repository-1', workflowBindingId: 'binding-1', value: 'enabled' };
		await operations[18].handler({ path: { projectId: 'project-1', name: 'FEATURE_FLAG' }, query: {}, body: variable },
			{ interface: 'rest', requestId: 'request-3', principal, idempotencyKey: 'variable-1', ifMatch: '0' });
		expect(workflowConfiguration.put).toHaveBeenCalledWith(principal, 'project-1', 'variables', 'FEATURE_FLAG',
			variable, variable, 'variable-1', '0');
		await operations[2].handler({ path: { kind: 'repository' }, query: {}, body: { action: 'ping' } }, {
			interface: 'rest', requestId: 'request-4', rawBody: '{"action":"ping"}',
			requestHeaders: { 'x-github-delivery': 'delivery-1' },
		});
		expect(githubWebhook).toHaveBeenCalledWith('repository', { action: 'ping' }, '{"action":"ping"}',
			{ 'x-github-delivery': 'delivery-1' });
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

	it('rejects invalid workflow pagination before querying durable runs', async () => {
		const store = { getProjectDetails: vi.fn(async () => ({ project: { id: 'project-1', teamId: 'team-1' } })),
			principalCanAccessTeam: vi.fn(async () => true), getTeamAccessSummary: vi.fn(async () => ({ permissions: ['projects:read:team'] })),
			all: vi.fn() };
		await expect(createWorkflowService(store).runs(principal, 'project-1', { limit: '101' })).rejects.toMatchObject({
			status: 400, code: 'workflow_limit_invalid',
		});
		expect(store.all).not.toHaveBeenCalled();
	});
});
