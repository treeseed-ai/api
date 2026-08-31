import { describe, expect, it } from 'vitest';
import { isR2ReplicationReceipt, mirrorTreeDxCommit, resolveCanonicalTreeDxRef, TREE_DX_MIRROR_SCHEMA } from '../../../../src/operations-runner/treedx/r2-file-mirror.ts';

class MemoryR2 {
	objects = new Map<string, Uint8Array>();
	deleted: string[] = [];
	async get(key: string) {
		const value = this.objects.get(key);
		return value ? { body: Buffer.from(value).toString('utf8'), etag: null } : null;
	}
	async getBytes(key: string) { const body = this.objects.get(key); return body ? { body, etag: null, sha256: null } : null; }
	async put(key: string, body: string) { this.objects.set(key, new Uint8Array(Buffer.from(body))); }
	async putBytes(key: string, body: Uint8Array) { this.objects.set(key, body); return { byteLength: body.byteLength }; }
	async delete(key: string) { this.objects.delete(key); this.deleted.push(key); }
	async exists(key: string) { return this.objects.has(key); }
	async list(prefix: string) { return [...this.objects.keys()].filter((key) => key.startsWith(prefix)); }
}

function connection(files: Record<string, { body: string; type: string }>) {
	const paths = Object.keys(files).sort();
	return { repositoryId: 'repo_sdk', client: {
		async listRepositoryPaths(input: any) {
			const offset = input.cursor ? Number(Buffer.from(input.cursor, 'base64url').toString('utf8')) : 0;
			const entries = paths.slice(offset, offset + 1).map((path) => ({ path, kind: 'blob' }));
			const next = offset + entries.length;
			return { entries, page: { hasMore: next < paths.length,
				nextCursor: next < paths.length ? Buffer.from(String(next)).toString('base64url') : null } };
		},
		async readRepositoryBlob(input: any) {
			const file = files[input.path]!;
			return { blob: { path: input.path, encoding: 'base64', contentBase64: Buffer.from(file.body).toString('base64'),
				byteLength: Buffer.byteLength(file.body), contentType: file.type, contentHash: `hash:${input.path}`, objectId: `object:${input.path}` } };
		},
	} };
}

describe('TreeDX R2 file mirror', () => {
	it('honors a project canonical binding while remaining inside the environment branch', () => {
		const refs = [{ name: 'refs/heads/staging', target: 'a'.repeat(40) },
			{ name: 'refs/remotes/origin/staging', target: 'b'.repeat(40) },
			{ name: 'refs/remotes/origin/main', target: 'c'.repeat(40) }];
		expect(resolveCanonicalTreeDxRef(refs, 'staging', 'refs/remotes/origin/staging')).toEqual({
			name: 'refs/remotes/origin/staging', commit: 'b'.repeat(40) });
		expect(resolveCanonicalTreeDxRef(refs, 'staging', 'a'.repeat(40))).toEqual({
			name: 'refs/heads/staging', commit: 'a'.repeat(40) });
		expect(resolveCanonicalTreeDxRef(refs, 'main', 'refs/remotes/origin/staging')).toEqual({
			name: 'refs/remotes/origin/main', commit: 'c'.repeat(40) });
	});

	it('writes the exact repository directory structure at the team/project root', async () => {
		const client = new MemoryR2(), commitSha = 'a'.repeat(40);
		const receipt = await mirrorTreeDxCommit({ client: client as any,
			connection: connection({ 'objectives/core.mdx': { body: '# Objective', type: 'text/mdx' },
				'assets/logo.bin': { body: '\u0000binary', type: 'application/octet-stream' } }),
			teamId: 'team-1', projectId: 'project-1', projectSlug: 'sdk', repositoryId: 'repo_sdk',
			commitSha, sourceRef: 'refs/heads/staging' });
		const root = 'teams/team-1/projects/project-1';
		expect([...client.objects.keys()]).toContain(`${root}/objectives/core.mdx`);
		expect([...client.objects.keys()]).toContain(`${root}/assets/logo.bin`);
		expect([...client.objects.keys()].some((key) => key.includes('/commits/') || key.includes('/current/'))).toBe(false);
		expect(receipt).toMatchObject({ schemaVersion: TREE_DX_MIRROR_SCHEMA, fileCount: 2, uploadedFiles: 2 });
		expect(isR2ReplicationReceipt(receipt, commitSha)).toBe(true);
		expect(isR2ReplicationReceipt({ objectKey: 'old.tar.zst' }, commitSha)).toBe(false);
	});

	it('updates changed files in place, retains unchanged files, and deletes removed files', async () => {
		const client = new MemoryR2(), first = 'a'.repeat(40), second = 'b'.repeat(40);
		const common = { client: client as any, teamId: 'team', projectId: 'project', projectSlug: 'sdk', repositoryId: 'repo_sdk' };
		client.objects.set('teams/team/projects/project/library/commits/legacy/archive.tar.zst', new Uint8Array([1]));
		await mirrorTreeDxCommit({ ...common, connection: connection({ 'keep.mdx': { body: 'one', type: 'text/mdx' },
			'delete.mdx': { body: 'old', type: 'text/mdx' } }), commitSha: first, sourceRef: 'refs/heads/staging' });
		const secondReceipt = await mirrorTreeDxCommit({ ...common, connection: connection({ 'keep.mdx': { body: 'two', type: 'text/mdx' } }),
			commitSha: second, sourceRef: 'refs/heads/staging' });
		expect(client.objects.has('teams/team/projects/project/delete.mdx')).toBe(false);
		expect(client.deleted).toContain('teams/team/projects/project/delete.mdx');
		expect(client.deleted).toContain('teams/team/projects/project/library/commits/legacy/archive.tar.zst');
		expect(client.objects.has('teams/team/projects/project/keep.mdx')).toBe(true);
		expect(secondReceipt).toMatchObject({ uploadedFiles: 1, deletedFiles: 1, unchangedFiles: 0 });
	});

	it('does not upload unchanged files again when TreeDX path listings omit hashes', async () => {
		const client = new MemoryR2(), common = { client: client as any, teamId: 'team', projectId: 'project',
			projectSlug: 'sdk', repositoryId: 'repo_sdk', sourceRef: 'refs/heads/staging' };
		await mirrorTreeDxCommit({ ...common, connection: connection({ 'same.mdx': { body: 'same', type: 'text/mdx' } }), commitSha: 'a'.repeat(40) });
		const receipt = await mirrorTreeDxCommit({ ...common, connection: connection({ 'same.mdx': { body: 'same', type: 'text/mdx' } }), commitSha: 'b'.repeat(40) });
		expect(receipt).toMatchObject({ uploadedFiles: 0, unchangedFiles: 1, deletedFiles: 0 });
	});
});
