import { describe, expect, it, vi } from 'vitest';
import { TreeDxInfrastructureClient } from '../../../../src/api/control-plane/treedx/infrastructure-client.ts';

describe('TreeDX infrastructure client', () => {
	it('adapts semantic changeset input to the official workspace files client', async () => {
		const changeset = vi.fn(async () => ({ changedPaths: ['discussions/topic.mdx'] }));
		const client = new TreeDxInfrastructureClient({ files: { changeset } } as never);
		const result = await client.applyChangeset({
			workspaceId: 'ws_one',
			contract: 'treedx.changeset/v1',
			patch: 'patch body',
		});

		expect(changeset).toHaveBeenCalledWith('ws_one', {
			contract: 'treedx.changeset/v1',
			patch: 'patch body',
		});
		expect(result).toEqual({ changedPaths: ['discussions/topic.mdx'] });
	});

	it('routes bulk repository reads through the files read operation', async () => {
		const readFile = vi.fn(async () => ({ files: [{ path: 'discussions/topic.mdx' }] }));
		const client = new TreeDxInfrastructureClient({ query: { readFile } } as never, 'repo_one');
		const result = await client.readRepositoryFiles({
			ref: '0123456789012345678901234567890123456789',
			paths: ['discussions/topic.mdx'],
		});

		expect(readFile).toHaveBeenCalledWith('repo_one', {
			ref: '0123456789012345678901234567890123456789',
			paths: ['discussions/topic.mdx'],
		});
		expect(result).toEqual({ files: [{ path: 'discussions/topic.mdx' }] });
	});
});
