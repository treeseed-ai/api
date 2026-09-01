import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveCredential, resolveConnection, createDelivery, enqueueReplication } = vi.hoisted(() => ({
	resolveCredential: vi.fn(), resolveConnection: vi.fn(), createDelivery: vi.fn(), enqueueReplication: vi.fn(),
}));

vi.mock('../../../../src/security/provider-credential-authority.ts', () => ({
	resolveGitHubCredentialAuthority: resolveCredential,
}));
vi.mock('../../../../src/api/knowledge/gateway-treedx-connection.ts', () => ({
	resolveKnowledgeGatewayConnection: resolveConnection,
}));
vi.mock('../../../../src/security/remote-git-credential-delivery.ts', () => ({
	createRemoteGitCredentialDelivery: createDelivery,
}));
vi.mock('../../../../src/api/capacity/services/treedx/repositories/treedx-commit-replication.ts', () => ({
	enqueueTreeDxCommitReplication: enqueueReplication,
}));

import { TreeDxRemoteHeadReconciliationScheduler } from '../../../../src/operations-runner/treedx/remote-head-reconciliation-scheduler.ts';
import { createTreeDxRemoteHeadReconciliationExecutor } from '../../../../src/operations-runner/treedx/remote-head-reconciliation-executor.ts';

const oldHead = 'a'.repeat(40);
const newHead = 'b'.repeat(40);
const publicationRef = 'refs/heads/staging';

function githubFetch(head = newHead) {
	return vi.fn(async () => new Response(JSON.stringify({ object: { sha: head } }), {
		status: 200, headers: { 'content-type': 'application/json' },
	})) as unknown as typeof fetch;
}

beforeEach(() => {
	vi.clearAllMocks();
	resolveCredential.mockResolvedValue({ token: 'token' });
	createDelivery.mockResolvedValue({ deliveryId: 'delivery' });
	enqueueReplication.mockResolvedValue({ id: 'replication' });
});

describe('TreeDX protected branch reconciliation', () => {
	it('queues one idempotent operation when GitHub is newer than the current TreeDX view', async () => {
		const operations: any[] = [];
		const store: any = {
			config: {},
			async all() { return [{ id: 'binding', team_id: 'team', project_id: 'project', authority_id: 'authority',
				owner: 'treeseed-ai', name: 'sdk-library', publication_ref: publicationRef,
				expected_head: newHead, observed_head: newHead, content_repository_ref: oldHead,
				metadata_json: JSON.stringify({ resolvedRef: oldHead }) }]; },
			async createPlatformOperation(value: any) { operations.push(value); },
		};
		const scheduler = new TreeDxRemoteHeadReconciliationScheduler(store, 1, githubFetch());
		const first = await scheduler.runIfDue(Date.parse('2026-08-31T12:00:00.000Z'));
		expect(first).toMatchObject({ scheduled: true, observed: 1, queued: 1, failed: 0 });
		expect(operations[0]).toMatchObject({ namespace: 'treedx', operation: 'reconcile_remote_head',
			input: { teamId: 'team', projectId: 'project', publicationRef, remoteHead: newHead } });
		expect(operations[0].idempotencyKey).toMatch(/^treedx-remote-head:[a-f0-9]{64}$/u);
	});

	it('does not queue when the logical view, binding, and remote are already converged', async () => {
		const operations: any[] = [];
		const store: any = { config: {}, async all() { return [{ id: 'binding', team_id: 'team', project_id: 'project',
			authority_id: 'authority', owner: 'treeseed-ai', name: 'sdk-library', publication_ref: publicationRef,
			expected_head: newHead, observed_head: newHead, content_repository_ref: publicationRef,
			metadata_json: JSON.stringify({ resolvedRef: newHead }) }]; },
			async createPlatformOperation(value: any) { operations.push(value); } };
		const result = await new TreeDxRemoteHeadReconciliationScheduler(store, 1, githubFetch())
			.runIfDue(Date.parse('2026-08-31T12:00:00.000Z'));
		expect(result).toMatchObject({ queued: 0, failed: 0 });
		expect(operations).toHaveLength(0);
	});

	it('fetches, promotes, indexes, advances the logical binding, and queues the exact R2 mirror', async () => {
		const runs: Array<{ query: string; params: unknown[] }> = [];
		const upserts: any[] = [];
		let refs = [{ name: publicationRef, target: oldHead }, { name: 'refs/remotes/origin/staging', target: newHead }];
		const client: any = {
			fetchRemote: vi.fn(async () => ({})),
			upstream: { repositories: { refs: vi.fn(async () => ({ refs })) },
				searchIndex: { status: vi.fn(async () => ({ index: { ready: true, stale: false,
					resolvedRef: newHead, segmentCount: 4 } })) } },
			promoteRef: vi.fn(async () => { refs = [{ name: publicationRef, target: newHead },
				{ name: 'refs/remotes/origin/staging', target: newHead }]; return { beforeHead: oldHead, afterHead: newHead }; }),
			refreshGraph: vi.fn(async () => ({ graph: { status: 'completed', resolvedRef: newHead, graphVersion: 'graph-1' } })),
			refreshSearchIndex: vi.fn(async () => ({ index: { status: 'completed' } })),
			getPlacement: vi.fn(async () => ({ primaryNodeId: 'node' })),
		};
		resolveConnection.mockResolvedValue({ client, repositoryId: 'repository', nodeId: 'node' });
		const library = { contentPath: '.', contentRepositoryUrl: 'https://github.com/treeseed-ai/sdk-library.git',
			contentRepositoryDefaultBranch: 'main', metadata: { retained: true, upstreamHeads: {} } };
		const store: any = {
			async first() { return { id: 'binding', provider_id: 'github', grant_status: 'ready',
				publication_ref: publicationRef, authority_id: 'authority', owner: 'treeseed-ai', name: 'sdk-library',
				clone_url: library.contentRepositoryUrl }; },
			async getProjectTreeDxLibrary() { return library; },
			async upsertProjectTreeDxLibrary(_projectId: string, value: any) { upserts.push(value); return value; },
			async run(query: string, params: unknown[]) { runs.push({ query, params }); },
		};
		const checkpoints: any[] = [];
		const executor = createTreeDxRemoteHeadReconciliationExecutor({ controlPlaneStore: store, fetchImpl: githubFetch() });
		const result = await executor.run({ teamId: 'team', projectId: 'project', publicationRef, remoteHead: newHead },
			{ operation: { id: 'operation' }, checkpoint: async (...values: any[]) => checkpoints.push(values) });
		expect(client.fetchRemote).toHaveBeenCalledWith(expect.objectContaining({ refspecs: [`+${publicationRef}:refs/remotes/origin/staging`] }));
		expect(client.promoteRef).toHaveBeenCalledWith(expect.objectContaining({ expectedDestinationHead: oldHead }));
		expect(client.refreshGraph).toHaveBeenCalledWith(expect.objectContaining({ ref: publicationRef, forceFull: true }));
		expect(client.refreshSearchIndex).toHaveBeenCalledWith(expect.objectContaining({ ref: publicationRef, incremental: false }));
		expect(upserts[0]).toMatchObject({ contentRepositoryRef: publicationRef,
			metadata: { retained: true, resolvedRef: newHead } });
		expect(runs.some((entry) => entry.query.includes('UPDATE project_remote_repository_bindings'))).toBe(true);
		expect(enqueueReplication).toHaveBeenCalledWith(store, expect.objectContaining({
			teamId: 'team', projectId: 'project', commitSha: newHead, sourceRef: publicationRef,
		}));
		expect(checkpoints).toHaveLength(1);
		expect(result).toMatchObject({ projectId: 'project', remoteHead: newHead,
			replication: { id: 'replication' } });
	});
});
