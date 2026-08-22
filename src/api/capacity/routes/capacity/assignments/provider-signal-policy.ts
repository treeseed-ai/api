import { type AgentSignalContract } from '@treeseed/sdk/agent-capacity';
import { validateArtifactMutationReceipt } from '../../../policy/artifact-mutation-receipt.ts';
import { CapacityGovernanceError } from '../../../database.ts';

type Row = Record<string, unknown>;

function record(value: unknown): Row {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
}

function normalized(value: unknown) {
	return typeof value === 'string' ? value.trim().replace(/_/gu, '-') : '';
}

function producerProfiles(assignment: Row) {
	const metadata = record(assignment.metadata);
	return new Set([
		normalized(metadata.activityProfile), normalized(metadata.activityType), normalized(assignment.mode),
	].filter(Boolean));
}

function validateRequiredPayload(contract: AgentSignalContract, payload: Row) {
	const required = Array.isArray(contract.payloadSchema.required) ? contract.payloadSchema.required.map(String) : [];
	const missing = required.filter((field) => payload[field] === undefined || payload[field] === null || payload[field] === '');
	if (missing.length) throw new CapacityGovernanceError('assignment_signal_payload_invalid', 'Signal payload is missing contract-required fields.', 422, { contractId: contract.id, missing });
}

export function enforceProviderSignalContract(assignment: Row, body: Row, contract: AgentSignalContract) {
	if (!contract.allowedOrigins.includes('agent-tool')) throw new CapacityGovernanceError('assignment_signal_origin_forbidden', 'This signal contract cannot be published by an agent tool.', 403, { contractId: contract.id });
	const subjectKind = normalized(body.subjectKind);
	if (!contract.subjectKinds.map(normalized).includes(subjectKind)) throw new CapacityGovernanceError('assignment_signal_subject_forbidden', 'Signal subject kind is outside the contract.', 422, { contractId: contract.id, subjectKind });
	const producers = producerProfiles(assignment);
	if (contract.allowedProducerProfiles?.length && !contract.allowedProducerProfiles.some((producer) => producers.has(normalized(producer)))) {
		throw new CapacityGovernanceError('assignment_signal_producer_forbidden', 'The selected activity profile may not publish this signal.', 403, { contractId: contract.id });
	}
	const evidence = record(body.evidence);
	const hasCommit = typeof evidence.commitSha === 'string' && /^[a-f0-9]{40}$/u.test(evidence.commitSha.trim());
	const receiptValidation = evidence.mutationReceipt == null ? null : validateArtifactMutationReceipt(evidence.mutationReceipt);
	if (receiptValidation && !receiptValidation.ok) throw new CapacityGovernanceError('assignment_signal_mutation_receipt_invalid', receiptValidation.reason, 422, { contractId: contract.id });
	const receipt = receiptValidation?.ok ? receiptValidation.value : null;
	if (hasCommit && !receipt) throw new CapacityGovernanceError('assignment_signal_mutation_receipt_required', 'Artifact-trigger signals require a versioned mutation receipt.', 422, { contractId: contract.id });
	if (receipt && (receipt.assignmentId !== assignment.id || receipt.projectId !== assignment.projectId
		|| receipt.teamId !== assignment.teamId || receipt.effectiveRef !== String(evidence.commitSha ?? '')
		|| receipt.effectiveRef !== String(evidence.immutableRef ?? ''))) {
		throw new CapacityGovernanceError('assignment_signal_mutation_receipt_scope_invalid', 'Signal evidence does not match the assignment-scoped mutation receipt.', 422, { contractId: contract.id, receiptId: receipt.id });
	}
	if (contract.commitEvidence === 'required' && !hasCommit) throw new CapacityGovernanceError('assignment_signal_commit_required', 'This signal requires an immutable commit SHA.', 422, { contractId: contract.id });
	if (contract.commitEvidence === 'forbidden' && hasCommit) throw new CapacityGovernanceError('assignment_signal_commit_forbidden', 'This signal contract does not permit commit evidence.', 422, { contractId: contract.id });
	const payload = record(body.payload);
	validateRequiredPayload(contract, payload);
	const causationId = normalized(body.causationId);
	const subjectId = normalized(body.subjectId);
	let key = causationId;
	if (contract.idempotency === 'commit-subject') key = `${String(evidence.commitSha ?? '')}:${subjectId}`;
	if (contract.idempotency === 'explicit-key') key = normalized(body.idempotencyKey);
	if (!key) throw new CapacityGovernanceError('assignment_signal_idempotency_required', 'Signal publication requires the contract-specific idempotency identity.', 422, { contractId: contract.id, policy: contract.idempotency });
	return key;
}

export function resolveSignalSubjectGroups(body: Row, knownGroupIds: Set<string>) {
	const requested = Array.isArray(body.subjectGroupIds) ? [...new Set(body.subjectGroupIds.map(String).map((value) => value.trim()).filter(Boolean))] : [];
	const unknownGroupIds = requested.filter((groupId) => !knownGroupIds.has(groupId));
	if (unknownGroupIds.length) throw new CapacityGovernanceError('assignment_signal_subject_groups_invalid', 'Signal subject groups are outside the frozen workday topology. Use only the returned allowedGroupIds, or omit subjectGroupIds to use the frozen primary-group fallback.', 422, {
		unknownGroupIds, allowedGroupIds: [...knownGroupIds].sort(),
	});
	if (requested.length) return { directGroupIds: requested, source: 'subject' as const };
	return { directGroupIds: [], source: 'unscoped' as const };
}
