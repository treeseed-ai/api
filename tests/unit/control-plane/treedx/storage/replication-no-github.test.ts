import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveKnowledgeGatewayConnection } from '../../../../../src/api/knowledge/gateway-treedx-connection.ts';
import { withLibraryStorage } from '../../../../../src/security/library-storage.ts';
import { mirrorTreeDxCommit } from '../../../../../src/operations-runner/treedx/r2-file-mirror.ts';
import { createTreeDxCommitReplicationExecutor } from '../../../../../src/operations-runner/treedx/commit-replication-executor.ts';

vi.mock('../../../../../src/api/knowledge/gateway-treedx-connection.ts', () => ({ resolveKnowledgeGatewayConnection: vi.fn() }));
vi.mock('../../../../../src/security/library-storage.ts', () => ({ withLibraryStorage: vi.fn() }));
vi.mock('../../../../../src/api/teams/managed-team-library-service.ts', () => ({ markManagedTeamLibraryMirrorKnownGood: vi.fn() }));
vi.mock('../../../../../src/operations-runner/treedx/r2-file-mirror.ts', async (original) => ({
	...await original<any>(), mirrorTreeDxCommit: vi.fn(),
}));

describe('replication cannot publish GitHub branches', () => {
	beforeEach(() => vi.clearAllMocks());
	it.each([
		{ githubStatus: 'pending', canonical: false }, { githubStatus: 'failed', canonical: false },
		{ githubStatus: 'verified', canonical: false }, { githubStatus: undefined, canonical: true },
	])('replicates without GitHub writes: %j', async ({ githubStatus, canonical }) => {
		const sha = 'a'.repeat(40), preserved = `refs/treedx/commits/${sha}`;
		const row = { id: 'replication', team_id: 'team', project_id: 'project', repository_id: 'repo',
			commit_sha: sha, source_ref: preserved, status: 'pending', r2_status: 'pending',
			github_ref: `refs/heads/treedx-backups/${sha}`, github_status: githubStatus };
		const push = vi.fn(() => { throw new Error('Replication must never push'); });
		const connection = { repositoryId: 'repo', client: { push, upstream: { repositories: {
			refs: vi.fn(async () => ({ refs: [{ name: preserved, target: sha }, { name: 'refs/heads/staging', target: canonical ? sha : 'b'.repeat(40) }] })),
		} } } };
		vi.mocked(resolveKnowledgeGatewayConnection).mockResolvedValue(connection as any);
		vi.mocked(withLibraryStorage).mockImplementation(async (_store, _config, run) => run({ branch: 'staging' } as any));
		vi.mocked(mirrorTreeDxCommit).mockResolvedValue({ commitSha: sha, manifestKey: 'manifest' } as any);
		const store = { first: vi.fn(async (query: string) => query.includes('treedx_commit_replications') ? row
			: query.includes('FROM projects') ? { id: 'project', team_id: 'team', slug: 'project' }
			: { content_repository_ref: 'refs/heads/staging' }), run: vi.fn() };
		const fetchImpl = vi.fn(() => { throw new Error('No provider credentials needed'); });
		const result = await createTreeDxCommitReplicationExecutor({ controlPlaneStore: store, fetchImpl }).run(
			{ replicationId: row.id }, { operation: { id: 'op' }, checkpoint: vi.fn() });
		expect(result.r2).toMatchObject(canonical ? { commitSha: sha, manifestKey: 'manifest' }
			: { reason: 'non-canonical-commit', commitSha: sha });
		expect(result).not.toHaveProperty('github');
		expect(push).not.toHaveBeenCalled();
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(mirrorTreeDxCommit).toHaveBeenCalledTimes(canonical ? 1 : 0);
		expect(resolveKnowledgeGatewayConnection).toHaveBeenCalledWith(store, { projectId: 'project', write: false,
			replicationRefs: [preserved, preserved, sha] });
		expect(store.run.mock.calls.every(([query]) => !query.includes('github_'))).toBe(true);
	});
	it('removes obsolete columns without deleting authoring work or queued commits', () => {
		const migration = readFileSync(new URL('../../../../../drizzle/control-plane/0017_remove_git_backup_replication.sql', import.meta.url), 'utf8');
		for (const column of ['github_ref', 'github_status', 'github_receipt_json']) expect(migration).toContain(`DROP COLUMN IF EXISTS "${column}"`);
		expect(migration).not.toMatch(/DELETE FROM|DROP TABLE|TRUNCATE/i);
	});
});
