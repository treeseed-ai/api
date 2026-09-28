import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveCredential, observeHead, createDelivery } = vi.hoisted(() => ({
	resolveCredential: vi.fn(), observeHead: vi.fn(), createDelivery: vi.fn(),
}));
vi.mock('../../../../../src/security/provider-credential-authority.ts', () => ({
	resolveGitHubCredentialAuthority: resolveCredential,
}));
vi.mock('../../../../../src/providers/github/repository-client.ts', () => ({
	githubRepositoryHead: observeHead,
}));
vi.mock('../../../../../src/security/remote-git-credential-delivery.ts', () => ({
	createRemoteGitCredentialDelivery: createDelivery,
}));

import { publishRemoteRepository } from '../../../../../src/operations-runner/knowledge/remote-publication.ts';
import { createKnowledgePublicationExecutor } from '../../../../../src/operations-runner/knowledge/publication-executor.ts';

const base = 'a'.repeat(40), reviewed = 'b'.repeat(40);
const remoteRef = 'refs/remotes/origin/staging';

beforeEach(() => {
	vi.clearAllMocks();
	resolveCredential.mockResolvedValue({ token: 'opaque' });
	createDelivery.mockResolvedValue({ deliveryId: 'delivery' });
});

describe('external publication closeout', () => {
	it('cleans the exact authoring ref without replacing divergent local staging after remote publication', async () => {
		const publication = { id: 'publication', status: 'queued', commit_sha: reviewed, published_ref: 'refs/heads/staging' };
		const workspace = { id: 'workspace', status: 'approved', projectId: 'sdk', teamId: 'team', repositoryId: 'repository',
			branchName: 'refs/heads/knowledge/workspace', baseCommitSha: base, treeDxWorkspaceId: 'treedx-workspace' };
		const store = { first: vi.fn(async (sql: string) => sql.includes('knowledge_publications') ? publication
			: { clone_url: 'https://github.com/treeseed-ai/sdk-library.git', grant_status: 'ready' }),
			getKnowledgeWorkspace: vi.fn(async () => workspace),
			getKnowledgeReview: vi.fn(async () => ({ status: 'approved', commitSha: reviewed })),
			completeKnowledgePublication: vi.fn(async () => { throw new Error('after-closeout'); }) };
		const client = { getRepository: vi.fn(async () => ({ storageKind: 'managed' })),
			closeWorkspace: vi.fn(async () => ({})), promoteRef: vi.fn(), retireRef: vi.fn() };
		const maintenanceClient = { discardOrphanRef: vi.fn(async () => ({ status: 'discarded' })) };
		const resolveConnection = vi.fn(async (_store: unknown, options: { maintenanceRefs?: string[] }) => options.maintenanceRefs
			? { client: maintenanceClient, repositoryId: 'repository' }
			: { client, repositoryId: 'repository', publicationRef: 'refs/heads/staging', nodeId: 'broker' });
		const manifest = { revision: 'revision', projects: [{ projectId: 'sdk', repositoryId: 'repository',
			ref: 'refs/heads/staging', commitSha: reviewed }] };
		const executor = createKnowledgePublicationExecutor({ environment: 'local', controlPlaneStore: store,
			knowledgePublicationStorage: { readCurrent: vi.fn(async () => manifest) },
			resolveKnowledgeGatewayConnection: resolveConnection });
		await expect(executor.run({ publicationId: 'publication' }, { operation: { id: 'operation' }, checkpoint: vi.fn() }))
			.rejects.toThrow('after-closeout');
		expect(resolveConnection).toHaveBeenCalledWith(store, expect.objectContaining({
			maintenanceRefs: [workspace.branchName, reviewed],
		}));
		expect(maintenanceClient.discardOrphanRef).toHaveBeenCalledWith({ repoId: 'repository', ref: workspace.branchName,
			expectedHead: reviewed, reason: expect.stringContaining(reviewed) });
		expect(client.promoteRef).not.toHaveBeenCalled();
		expect(client.retireRef).not.toHaveBeenCalled();
		expect(client.closeWorkspace).toHaveBeenCalledWith('treedx-workspace');
	});
});

describe('remote TreeDX publication', () => {
	it.each([false, true])('uses the verified remote-tracking ref without promoting divergent local staging (already pushed=%s)', async alreadyPushed => {
		observeHead.mockResolvedValue(reviewed);
		if (!alreadyPushed) observeHead.mockResolvedValueOnce(base);
		const binding = { id: 'binding', grant_status: 'ready', publication_ref: 'refs/heads/staging',
			expected_head: base, authority_id: 'authority', owner: 'treeseed-ai', name: 'sdk-library', clone_url: 'https://github.com/treeseed-ai/sdk-library.git' };
		const store = { first: vi.fn(async () => binding), run: vi.fn(async () => ({})) };
		const client = { push: vi.fn(async () => ({ afterHead: reviewed })),
			fetchRemote: vi.fn(async () => ({})),
			listRepositoryRefs: vi.fn(async () => [{ name: 'refs/heads/staging', target: 'c'.repeat(40) },
				{ name: remoteRef, target: reviewed }]),
			promoteRef: vi.fn(), retireRef: vi.fn() };
		const result = await publishRemoteRepository({ store, operationId: 'operation', actorId: 'actor',
			projectId: 'sdk', teamId: 'team', connection: { client, repositoryId: 'repository', nodeId: 'node' },
			reviewedCommit: reviewed, baseCommit: base, publicationRef: 'refs/heads/staging', authoringRef: 'refs/heads/knowledge/workspace' });
		expect(result.fetch).toEqual({ ref: remoteRef });
		expect(client.fetchRemote).toHaveBeenCalledWith(expect.objectContaining({
			refspecs: [`+refs/heads/staging:${remoteRef}`],
		}));
		expect(client.push).toHaveBeenCalledTimes(alreadyPushed ? 0 : 1);
		expect(client.promoteRef).not.toHaveBeenCalled();
		expect(client.retireRef).not.toHaveBeenCalled();
		expect(store.run).toHaveBeenCalledWith(expect.stringContaining('UPDATE project_remote_repository_bindings'),
			expect.arrayContaining([reviewed, reviewed]));
	});
});
