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
});
