export function simulationEvidence(input: unknown, operatorPrincipalId?: string | null): Record<string, unknown> {
	if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
	const value = (input as Record<string, unknown>).simulation;
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
	const simulation = value as Record<string, unknown>;
	if (simulation.interactionMode !== 'ai_operator_simulation') return {};
	return {
		interactionMode: 'ai_operator_simulation',
		operatorPrincipalId: operatorPrincipalId ?? simulation.operatorPrincipalId ?? null,
		modelProvider: simulation.modelProvider,
		clientSurface: simulation.clientSurface,
		workdayId: simulation.workdayId,
		assignmentId: simulation.assignmentId ?? null,
		reason: simulation.reason,
		simulationPurpose: simulation.simulationPurpose,
		productionAuthorityRequested: simulation.productionAuthorityRequested === true,
	};
}

export function assertExpectedProposalVersion(input: unknown, actualVersion: number) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) return;
	const expected = Number((input as Record<string, unknown>).expectedProposalVersion);
	if (!Number.isFinite(expected) || expected <= 0 || expected === actualVersion) return;
	const error: Error & { status?: number } = new Error('Proposal changed after it was inspected. Reinspect the current version before acting.');
	error.status = 409;
	throw error;
}
