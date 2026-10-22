import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveConnection, snapshot } = vi.hoisted(() => ({ resolveConnection: vi.fn(), snapshot: vi.fn() }));
vi.mock('../../../../../src/api/knowledge/gateway-treedx-connection.ts', async (importOriginal) => ({
	...await importOriginal<typeof import('../../../../../src/api/knowledge/gateway-treedx-connection.ts')>(),
	resolveKnowledgeGatewayConnection: resolveConnection,
}));
vi.mock('../../../../../src/api/capacity/services/capacity/agents/agent-definition-snapshot.ts', async (importOriginal) => ({
	...await importOriginal<typeof import('../../../../../src/api/capacity/services/capacity/agents/agent-definition-snapshot.ts')>(),
	snapshotAgentDefinitions: snapshot,
}));

import { AgentTeamCloneService } from '../../../../../src/api/capacity/services/capacity/agents/team-clone/agent-team-clone-service.ts';

const commit = 'a'.repeat(40);

describe('team clone with shared-class profiles', () => {
	beforeEach(() => {
		resolveConnection.mockReset(); snapshot.mockReset();
		resolveConnection.mockResolvedValue({ repositoryId: 'source-repo', baseRef: 'refs/heads/main' });
		snapshot.mockResolvedValue({ commit, files: [
			{ path: 'agents/operator-engineer.yaml', sourceDigest: `sha256:${'1'.repeat(64)}`, definition: { id: 'sdk/operator-engineer', agentClass: 'engineer' } },
			{ path: 'agents/engineer.mdx', sourceDigest: `sha256:${'2'.repeat(64)}`, definition: { id: 'sdk/engineer', agentClass: 'engineer' } },
		] });
	});

	it('rejects before target reads or mutation when profiles would collapse to one class path', async () => {
		const store = {
			listTeamProjects: vi.fn(async () => [
				{ id: 'source-id', slug: 'source', name: 'Source' }, { id: 'target-id', slug: 'target', name: 'Target' },
			]),
			listProjectAgentClassesPage: vi.fn(async () => ({ items: [{ status: 'active', metadata: { immutableRef: commit } }] })),
			createWorkspace: vi.fn(), updateProjectAgentClass: vi.fn(), createProjectAgentClass: vi.fn(),
		};
		const service = new AgentTeamCloneService(store);
		await expect(service.plan({ id: 'admin', roles: ['admin'] }, 'team-id', {
			sourceProject: 'source', targetProjects: ['target'],
		})).rejects.toMatchObject({ code: 'agent_team_multi_profile_unsupported', details: {
			agentClass: 'engineer', agentIds: ['sdk/operator-engineer', 'sdk/engineer'],
		} });
		expect(resolveConnection).toHaveBeenCalledOnce();
		expect(store.createWorkspace).not.toHaveBeenCalled();
		expect(store.updateProjectAgentClass).not.toHaveBeenCalled();
		expect(store.createProjectAgentClass).not.toHaveBeenCalled();
	});
});
