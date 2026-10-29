import { afterEach, describe, expect, it, vi } from 'vitest';

const { mint } = vi.hoisted(() => ({ mint: vi.fn((_input: Record<string, any>) => ({ token: 'test-delegation' })) }));
vi.mock('../../../../../src/api/control-plane/treedx/delegation-authority.ts', () => ({
	treeDxDelegationAuthority: () => ({ mint }),
}));

import { projectKnowledgeAuthoringBaseRef, resolveKnowledgeGatewayConnection } from '../../../../../src/api/knowledge/gateway-treedx-connection.ts';

function store(config: Record<string, string> = {}, treeDx: Record<string, string> = {}) {
	return { config, getProjectTreeDxLibrary: async () => ({
		instanceId: 'database-instance-not-broker', repositoryId: 'repository', contentPath: '.',
		topology: { contentRepository: { treeDx } },
	}) };
}

afterEach(() => vi.unstubAllEnvs());

describe('knowledge gateway broker identity', () => {
	it('authors against the configured protected content ref after a private discussion advances the project cursor', async () => {
		const privateDiscussion = 'c'.repeat(40);
		const authority = { config: {}, getProjectTreeDxLibrary: async () => ({
			instanceId: 'instance', repositoryId: 'repository', contentPath: '.',
			contentRepositoryRef: privateDiscussion, contentRepositoryUrl: 'https://github.com/example/library.git',
			topology: { contentRepository: { ref: privateDiscussion } },
		}) };
		const connection = await resolveKnowledgeGatewayConnection(authority,
			{ projectId: 'project', write: true, authoringPaths: true });
		expect(connection?.baseRef).toBe(privateDiscussion);
		if (!connection) throw new Error('Configured connection required');
		expect(projectKnowledgeAuthoringBaseRef(connection)).toBe('refs/remotes/origin/staging');
		expect(mint.mock.calls.at(-1)![0].scope.refs).toContain('refs/remotes/origin/staging');
		// Reading private authoring history remains a distinct exact source.
		expect((await resolveKnowledgeGatewayConnection(authority, { projectId: 'project', write: false }))?.baseRef)
			.toBe(privateDiscussion);
	});
	it('authors against the existing local publication branch for a managed library without an upstream', async () => {
		const authority = { config: {}, getProjectTreeDxLibrary: async () => ({
			instanceId: 'instance', repositoryId: 'repository', contentPath: '.', contentRepositoryRef: 'b'.repeat(40),
		}) };
		const connection = await resolveKnowledgeGatewayConnection(authority,
			{ projectId: 'project', write: true, authoringPaths: true });
		if (!connection) throw new Error('Managed connection required');
		expect(connection.baseRef).toBe('b'.repeat(40));
		expect(projectKnowledgeAuthoringBaseRef(connection)).toBe('refs/heads/staging');
	});
	it('grants exact-snapshot indexing without content writes or remote publication only when requested', async () => {
		const input = { projectId: 'project', write: false, relationPaths: true, readRefs: ['a'.repeat(40)] };
		await resolveKnowledgeGatewayConnection(store(), input);
		const ordinary = mint.mock.calls.at(-1)![0].scope;
		expect(ordinary.capabilities).not.toContain('graph:refresh');
		await resolveKnowledgeGatewayConnection(store(), { ...input, refreshGraph: true });
		const indexed = mint.mock.calls.at(-1)![0].scope;
		expect(indexed).toEqual({ ...ordinary, capabilities: [...ordinary.capabilities, 'graph:refresh'] });
		for (const denied of ['files:write', 'files:delete', 'workspace:create', 'git:commit', 'git:push', 'policy:write'])
			expect(indexed.capabilities).not.toContain(denied);
	});
	it.each([[], ['staging'], ['a'.repeat(40), 'b'.repeat(40)]])('rejects refresh grants without one exact snapshot: %j', async (readRefs) => {
		await expect(resolveKnowledgeGatewayConnection(store(), { projectId: 'project', write: false, refreshGraph: true, readRefs }))
			.rejects.toThrow('one exact commit');
	});
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
