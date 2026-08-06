import { createHash } from 'node:crypto';
import { createUnifiedChangeset,type TextFileChange } from '@treeseed/sdk/treedx';

export async function applyTextChangeset(input: {
	client: any;
	workspace: { workspaceId: string; baseCommitSha: string; baseRef: string };
	changes: TextFileChange[];
	idempotencyKey?: string;
}) {
	const patch = createUnifiedChangeset(input.changes);
	const patchSha256 = createHash('sha256').update(patch).digest('hex');
	return input.client.applyChangeset({
		workspaceId: input.workspace.workspaceId,
		contract: 'treedx.changeset/v1',
		baseCommitSha: input.workspace.baseCommitSha,
		baseRef: input.workspace.baseRef,
		patch,
		patchSha256,
		idempotencyKey: input.idempotencyKey
			?? createHash('sha256').update(`${input.workspace.workspaceId}:${patchSha256}`).digest('hex'),
		expectedDestinationRefHead: input.workspace.baseCommitSha,
	});
}
