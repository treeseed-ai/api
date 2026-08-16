import { describe, expect, it, vi } from 'vitest';
import { reconcileUnchangedAuthoringReplay } from '../../../../../src/api/capacity/routes/support/agent-lab/deployment-support/unchanged-authoring-replay.ts';

describe('unchanged agent authoring replay', () => {
	it('refreshes the durable projection without claiming or invoking publication', async () => {
		const closeWorkspace = vi.fn().mockResolvedValue(undefined);
		const reconcileProjection = vi.fn().mockResolvedValue(undefined);
		const result = await reconcileUnchangedAuthoringReplay({
			closeWorkspace,
			reconcileProjection,
			workspaceId: 'workspace-a',
			baseRef: 'refs/heads/staging',
			baseCommitSha: 'a'.repeat(40),
		});

		expect(closeWorkspace).toHaveBeenCalledOnce();
		expect(reconcileProjection).toHaveBeenCalledOnce();
		expect(result).toMatchObject({
			changedPaths: [],
			publication: { status: 'not-required', reason: 'unchanged' },
			changeset: { idempotentReplay: true, resultCommitSha: 'a'.repeat(40) },
		});
	});
});
