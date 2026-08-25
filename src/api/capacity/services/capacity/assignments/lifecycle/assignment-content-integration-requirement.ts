type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

export const CONTENT_INTEGRATION_REQUIRED_EVENT = 'assignment.content.integration_required';
export const CONTENT_INTEGRATED_EVENT = 'assignment.content.integrated';

export function provisionalMutationReceipts(lifecycleOutput: unknown) {
	const manifest = record(record(lifecycleOutput).artifactManifest);
	const receipts = Array.isArray(manifest.mutationReceipts) ? manifest.mutationReceipts.map(record) : [];
	return receipts.filter((receipt) => receipt.phase === 'provisional' && typeof receipt.id === 'string' && typeof receipt.effectiveRef === 'string');
}

export function assignmentContentIntegrationReadySql() {
	return `(integration_required.id IS NULL AND assignment.execution_kind <> 'conversation') OR integrated_assignment.id IS NOT NULL`;
}

export function contentIntegrationRequirementOperation(input: {
	assignmentId: string;
	capacityProviderId: string;
	stateVersion: number;
	lifecycleOutput: unknown;
	now: string;
}) {
	const receipts = provisionalMutationReceipts(input.lifecycleOutput);
	if (!receipts.length) return null;
	return {
		query: `INSERT INTO audit_events (id, actor_type, actor_id, event_type, target_type, target_id, data_json, created_at)
		 SELECT ?, 'capacity_provider', ?, ?, 'capacity_provider_assignment', ?, ?, ?
		 WHERE EXISTS (SELECT 1 FROM capacity_provider_assignments WHERE id = ? AND status = 'completed' AND state_version = ?)
		 ON CONFLICT (id) DO NOTHING`,
		params: [
			`assignment-content-integration-required:${input.assignmentId}:${input.stateVersion}`,
			input.capacityProviderId,
			CONTENT_INTEGRATION_REQUIRED_EVENT,
			input.assignmentId,
			JSON.stringify({ receipts: receipts.map((receipt) => ({ id: receipt.id, effectiveRef: receipt.effectiveRef })) }),
			input.now,
			input.assignmentId,
			input.stateVersion,
		],
	};
}
