export async function reconcileUnchangedAuthoringReplay(input: {
	closeWorkspace(): Promise<unknown>;
	reconcileProjection(): Promise<unknown>;
	workspaceId: string;
	baseRef: string;
	baseCommitSha: string;
}) {
	await input.closeWorkspace().catch(() => undefined);
	await input.reconcileProjection();
	return {
		commit: input.baseCommitSha,
		branch: input.baseRef,
		changedPaths: [] as string[],
		changeset: {
			contract: 'treedx.changeset/v1',
			workspaceId: input.workspaceId,
			baseRef: input.baseRef,
			baseCommitSha: input.baseCommitSha,
			resultCommitSha: input.baseCommitSha,
			changedPaths: [] as string[],
			idempotentReplay: true,
		},
		publication: { status: 'not-required', reason: 'unchanged' },
	};
}
