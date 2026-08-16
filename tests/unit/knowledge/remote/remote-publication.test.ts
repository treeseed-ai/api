import { afterEach, describe, expect, it, vi } from 'vitest';
import { publishRemoteRepository } from '../../../../src/operations-runner/knowledge/remote-publication.ts';

const reviewed = 'b'.repeat(40);
const base = 'a'.repeat(40);
const binding = {
	id: 'binding-1', project_id: 'project-1', authority_id: 'authority-1', grant_status: 'ready',
	publication_ref: 'refs/heads/staging', expected_head: null, owner: 'example', name: 'knowledge',
	clone_url: 'https://github.com/example/knowledge.git',
};

function storeFor(overrides: Record<string, unknown> = {}) {
	let delivery: { id: string; expires_at: string } | null = null;
	return {
		first: vi.fn(async (sql: string) => {
			if (sql.includes('project_remote_repository_bindings WHERE project_id')) return { ...binding, ...overrides };
			if (sql.includes('FROM provider_credential_authorities')) return { scheme: 'environment-reference',
				reference: 'TREESEED_GITHUB_TOKEN_EXAMPLE_KNOWLEDGE', capabilities_json: '["repository-hosting"]',
				provider_id: 'github', authority_id: 'authority-1', id: 'authority-1' };
			if (sql.includes('remote_git_operation_grants WHERE idempotency_key')) return { id: 'grant-1' };
			if (sql.includes('remote_credential_deliveries WHERE grant_id')) return delivery;
			return null;
		}),
		all: vi.fn(async () => []), run: vi.fn(async (sql: string, values: unknown[] = []) => {
			if (sql.includes('INSERT INTO remote_credential_deliveries')) {
				delivery = { id: String(values[0]), expires_at: String(values[6]) };
			}
			return { meta: { changes: 1 } };
		}),
	};
}

function connection() {
	let publicationHead = base;
	return { nodeId: 'node_local', repositoryId: 'repository-1', client: {
		push: vi.fn(async () => ({ status: 'pushed', beforeHead: null, afterHead: reviewed, rejectedRefs: [] })),
		fetchRemote: vi.fn(async () => ({ status: 'synced' })),
		promoteRef: vi.fn(async () => { publicationHead = reviewed; return { status: 'promoted', afterHead: reviewed }; }),
		listRepositoryRefs: vi.fn(async () => [
			{ name: 'refs/remotes/origin/staging', sha: reviewed, kind: 'remote' },
			{ name: 'refs/heads/staging', sha: publicationHead, kind: 'branch' },
		]),
	} };
}

afterEach(() => vi.unstubAllEnvs());

describe('recoverable remote knowledge publication', () => {
	it('creates a missing publication ref with an empty exact lease and verifies provider read-back', async () => {
		vi.stubEnv('TREESEED_GITHUB_TOKEN_EXAMPLE_KNOWLEDGE', 'scoped-token');
		let observations = 0;
		const fetchImpl = vi.fn(async () => {
			observations += 1;
			return observations === 1 ? new Response('{}', { status: 404 })
				: new Response(JSON.stringify({ object: { sha: reviewed } }), { status: 200 });
		});
		const store = storeFor(); const target = connection();
		const result = await publishRemoteRepository({ store, operationId: 'operation-1', actorId: 'user-1',
			projectId: 'project-1', teamId: 'team-1', connection: target, reviewedCommit: reviewed,
			baseCommit: base, publicationRef: 'refs/heads/staging', authoringRef: 'refs/heads/knowledge/reviewed', fetchImpl });
		expect(target.client.push).toHaveBeenCalledWith(expect.objectContaining({ expectedRemoteHead: '' }));
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(result.promotion.afterHead).toBe(reviewed);
		expect(store.run).toHaveBeenCalledWith(expect.stringContaining('UPDATE project_remote_repository_bindings'),
			[reviewed, reviewed, expect.any(String), 'binding-1']);
	});

	it('rejects an unreviewed remote head without issuing a TreeDX credential delivery', async () => {
		vi.stubEnv('TREESEED_GITHUB_TOKEN_EXAMPLE_KNOWLEDGE', 'scoped-token');
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ object: { sha: 'c'.repeat(40) } }), { status: 200 }));
		const store = storeFor({ expected_head: base }); const target = connection();
		await expect(publishRemoteRepository({ store, operationId: 'operation-2', actorId: 'user-1',
			projectId: 'project-1', teamId: 'team-1', connection: target, reviewedCommit: reviewed,
			baseCommit: base, publicationRef: 'refs/heads/staging', authoringRef: 'refs/heads/knowledge/reviewed', fetchImpl }))
			.rejects.toThrow(/changed after review/u);
		expect(target.client.push).not.toHaveBeenCalled();
		expect(store.run).not.toHaveBeenCalled();
	});

	it('rejects a TreeDX fetch that does not materialize the provider commit', async () => {
		vi.stubEnv('TREESEED_GITHUB_TOKEN_EXAMPLE_KNOWLEDGE', 'scoped-token');
		let observations = 0;
		const fetchImpl = vi.fn(async () => ++observations === 1
			? new Response('{}', { status: 404 })
			: new Response(JSON.stringify({ object: { sha: reviewed } }), { status: 200 }));
		const store = storeFor(); const target = connection();
		target.client.listRepositoryRefs.mockResolvedValueOnce([
			{ name: 'refs/remotes/origin/staging', sha: base, kind: 'remote' },
		]);
		await expect(publishRemoteRepository({ store, operationId: 'operation-3', actorId: 'user-1',
			projectId: 'project-1', teamId: 'team-1', connection: target, reviewedCommit: reviewed,
			baseCommit: base, publicationRef: 'refs/heads/staging', authoringRef: 'refs/heads/knowledge/reviewed', fetchImpl }))
			.rejects.toThrow(/TreeDX ref refs\/remotes\/origin\/staging/u);
		expect(target.client.promoteRef).not.toHaveBeenCalled();
	});

	it('resumes when the provider and TreeDX publication refs already contain the reviewed commit', async () => {
		vi.stubEnv('TREESEED_GITHUB_TOKEN_EXAMPLE_KNOWLEDGE', 'scoped-token');
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ object: { sha: reviewed } }), { status: 200 }));
		const store = storeFor({ expected_head: base }); const target = connection();
		target.client.listRepositoryRefs.mockResolvedValue([
			{ name: 'refs/remotes/origin/staging', sha: reviewed, kind: 'remote' },
			{ name: 'refs/heads/staging', sha: reviewed, kind: 'branch' },
		]);
		const result = await publishRemoteRepository({ store, operationId: 'operation-4', actorId: 'user-1',
			projectId: 'project-1', teamId: 'team-1', connection: target, reviewedCommit: reviewed,
			baseCommit: base, publicationRef: 'refs/heads/staging', authoringRef: 'refs/heads/knowledge/reviewed', fetchImpl });
		expect(target.client.push).not.toHaveBeenCalled();
		expect(target.client.promoteRef).not.toHaveBeenCalled();
		expect(result.promotion.status).toBe('already_current');
	});
});
