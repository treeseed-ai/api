import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../src/api/control-plane/treedx/delegation-authority.ts', () => ({
	treeDxDelegationAuthority: () => ({ mint: () => ({ token: 'test-delegation' }) }),
}));

import { resolveKnowledgeGatewayConnection } from '../../../../../src/api/knowledge/gateway-treedx-connection.ts';

function store(config: Record<string, string> = {}, treeDx: Record<string, string> = {}) {
	return { config, getProjectTreeDxLibrary: async () => ({
		instanceId: 'database-instance-not-broker', repositoryId: 'repository', contentPath: '.',
		topology: { contentRepository: { treeDx } },
	}) };
}

afterEach(() => vi.unstubAllEnvs());

describe('knowledge gateway broker identity', () => {
	it('uses the runtime service identity instead of the library instance UUID', async () => {
		vi.stubEnv('TREESEED_TREEDX_NODE_ID', 'runtime-broker');
		const connection = await resolveKnowledgeGatewayConnection(store({ TREESEED_TREEDX_NODE_ID: 'configured-broker' }),
			{ projectId: 'project', write: false, publishRefs: ['refs/heads/staging'] });
		expect(connection?.nodeId).toBe('runtime-broker');
	});
	it('uses explicit configured or topology identities when no runtime override exists', async () => {
		vi.stubEnv('TREESEED_TREEDX_NODE_ID', '');
		for (const authority of [store({ TREESEED_TREEDX_NODE_ID: 'broker' }), store({}, { nodeId: 'broker' })]) {
			expect((await resolveKnowledgeGatewayConnection(authority, { projectId: 'project', write: false }))?.nodeId).toBe('broker');
		}
	});
	it('rejects remote credential operations without an explicit broker identity', async () => {
		vi.stubEnv('TREESEED_TREEDX_NODE_ID', '');
		for (const refs of [{ publishRefs: ['refs/heads/staging'] }, { replicationRefs: ['refs/heads/staging'] }, { maintenanceRefs: ['refs/heads/staging'] }]) {
			await expect(resolveKnowledgeGatewayConnection(store(), { projectId: 'project', write: false, ...refs }))
				.rejects.toThrow('configured broker node identity');
		}
	});
});
