import { describe, expect, it, vi } from 'vitest';
import { readProjectProposalTypes } from '../../../../src/control-plane/seeds/apply-support/projects/projects-core/project-proposal-types.ts';

const ref = 'a'.repeat(40);
const path = '.treeseed/governance/proposal-types/implementation.yaml';
const contract = { schemaVersion: 'treeseed.proposal-type/v1', id: 'implementation', label: 'Implementation', description: 'A bounded change.' };
function fixture() {
	const listing = { resolvedRef: ref, entries: [{ path }], page: { hasMore: false } };
	const read = { resolvedRef: ref, files: [{ path, content: JSON.stringify(contract) }] };
	const query = { listPaths: vi.fn(async () => listing), readFile: vi.fn(async () => read) };
	return { listing, read, query, client: { query } as unknown as Parameters<typeof readProjectProposalTypes>[0] };
}
describe('project proposal contracts', () => {
	it('reads and validates every contract at the exact agent-definition commit', async () => {
		const f = fixture();
		expect(await readProjectProposalTypes(f.client, 'repo-1', ref)).toEqual({ implementation: contract });
		expect(f.query.readFile).toHaveBeenCalledWith('repo-1', expect.objectContaining({ ref, paths: [path], allowProtected: true }));
	});
	it('allows a verified empty catalog, never inventing proposal types', async () => {
		const f = fixture(); f.listing.entries = [];
		expect(await readProjectProposalTypes(f.client, 'repo-1', ref)).toEqual({});
		expect(f.query.readFile).not.toHaveBeenCalled();
	});
	it.each(['moving-ref', 'truncated', 'duplicate-path', 'wrong-path', 'moved-read', 'missing-file', 'invalid-contract', 'wrong-id'])('rejects %s', async (kind) => {
		const f = fixture();
		if (kind === 'moving-ref') f.listing.resolvedRef = 'b'.repeat(40);
		if (kind === 'truncated') f.listing.page.hasMore = true;
		if (kind === 'duplicate-path') f.listing.entries.push({ path });
		if (kind === 'wrong-path') f.listing.entries[0]!.path = '../escape.yaml';
		if (kind === 'moved-read') f.read.resolvedRef = 'b'.repeat(40);
		if (kind === 'missing-file') f.read.files = [];
		if (kind === 'invalid-contract') f.read.files[0]!.content = '{}';
		if (kind === 'wrong-id') f.read.files[0]!.content = JSON.stringify({ ...contract, id: 'other' });
		await expect(readProjectProposalTypes(f.client, 'repo-1', ref)).rejects.toThrow();
	});
	it('rejects moving refs before any request', async () => {
		const f = fixture();
		await expect(readProjectProposalTypes(f.client, 'repo-1', 'staging')).rejects.toThrow('immutable');
		expect(f.query.listPaths).not.toHaveBeenCalled();
	});
});
