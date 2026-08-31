import { CapacityGovernanceError } from '../../../../../database.ts';

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

export function assertAssignmentCompletionEvidence(input: { completion?: unknown }) {
	const completion = record(input.completion);
	if (completion.disposition !== 'completed_early') return;
	const checks = Array.isArray(completion.acceptanceChecks) ? completion.acceptanceChecks.map(record) : [];
	const artifacts = Array.isArray(completion.durableArtifactRefs) ? completion.durableArtifactRefs.map(String).filter(Boolean) : [];
	if (completion.noUsefulScopedWorkRemaining !== true || !String(completion.completionReason ?? '').trim() || !checks.length || checks.some((check) => check.passed !== true) || !artifacts.length || !Object.keys(record(completion.remainingBudget)).length) {
		throw new CapacityGovernanceError('provider_assignment_early_completion_evidence_invalid', 'Early completion requires passed acceptance checks, durable artifacts, remaining budget, a reason, and noUsefulScopedWorkRemaining.', 409);
	}
}
