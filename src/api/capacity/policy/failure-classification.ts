import type { CapacityFailureClassification,CapacityFailureDisposition } from '@treeseed/sdk/agent-capacity';

const OPERATOR_ACTION_CODES = new Set([
	'capacity_settlement_overrun_requires_approval',
	'capacity_settlement_idempotency_conflict',
	'capacity_settlement_usage_conflict',
	'capacity_usage_idempotency_conflict',
	'workday_assignment_admission_provenance_missing',
]);

const RETRYABLE_CODES = new Set([
	'control_plane_unavailable',
	'execution_provider_rate_limited',
	'execution_provider_unavailable',
	'lease_expired',
	'provider_restart_recovery',
	'treedx_unavailable',
]);

export function classifyCapacityFailure(input: {
	code?: string | null;
	reason?: string | null;
	retryable?: boolean | null;
}): CapacityFailureClassification {
	const code = input.code?.trim() || 'capacity_failure_unclassified';
	let disposition: CapacityFailureDisposition = 'terminal';
	if (input.retryable === true || RETRYABLE_CODES.has(code)) disposition = 'retryable';
	if (OPERATOR_ACTION_CODES.has(code)) disposition = 'operator-action';
	return {
		schemaVersion: 1,
		code,
		disposition,
		reason: input.reason?.trim() || code.replaceAll('_', ' '),
		retryable: disposition === 'retryable',
		requiresOperatorAction: disposition === 'operator-action',
	};
}
