/** Governed example data, not a copy of the canonical schema or a readiness implementation. */
export function readyWorkItem() {
	return { id: 'verify-boundary', activity: 'acting', agentClass: 'boundary-author', workspace: 'read-only',
		review: 'required', objective: 'Independently verify the exact governed boundary.', dependsOn: [] as string[],
		requestedPermissions: { content: { read: ['proposal'], write: [] }, tools: [] },
		requiredCapabilities: ['verification'],
		acceptanceCriteria: ['Read back the exact source and record independent verification.'],
		estimate: { expectedSeconds: 30, maximumSeconds: 60 },
		reviewEstimate: { expectedSeconds: 10, maximumSeconds: 20 }, maximumReviewCycles: 2 };
}
export function readyProposal() {
	return { schemaVersion: 'treeseed.proposal/v1', id: 'proposal', projectId: 'project', title: 'Governed boundary',
		request: 'Verify the exact governed boundary.', summary: 'One bounded, independently reviewed work item.',
		status: 'draft', executionPlan: { workItems: [readyWorkItem()] } };
}
