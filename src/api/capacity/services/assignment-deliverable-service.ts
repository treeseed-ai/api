import type { AgentArtifactManifest, DecisionAssignmentGraphRecord, DeliverableContractRecord, DeliverableManifestRecord } from '@treeseed/sdk/agent-capacity';
import { validateAgentArtifactManifest } from '@treeseed/sdk/agent-capacity';
import { CapacityGovernanceError } from '../database.ts';
import type { DurableProviderAssignment } from '../repositories/assignment.ts';

type JsonRecord = Record<string, unknown>;

export interface AssignmentDeliverableStore {
	getDecisionAssignmentGraph(graphId: string): Promise<DecisionAssignmentGraphRecord | null>;
	getDeliverableContract(contractId: string): Promise<DeliverableContractRecord | null>;
	submitDeliverableManifest(contractId: string, input: JsonRecord): Promise<DeliverableManifestRecord | null>;
	markDeliverableContractApproved(contractId: string, input: JsonRecord): Promise<DeliverableContractRecord | null>;
	markDeliverableContractRejected(contractId: string, input: JsonRecord): Promise<DeliverableContractRecord | null>;
}

function record(value: unknown): JsonRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}; }
function records(value: unknown): JsonRecord[] { return Array.isArray(value) ? value.map(record).filter((entry) => Object.keys(entry).length > 0) : []; }
function text(...values: unknown[]): string { for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim(); return ''; }

function executionProvenance(assignment: DurableProviderAssignment) {
	const decisionInput = record(assignment.decisionInput);
	const payload = record(decisionInput.input);
	return {
		graphId: text(payload.workGraphId, record(decisionInput.metadata).graphId),
		nodeId: text(decisionInput.workGraphNodeId, payload.workGraphNodeId),
	};
}

function assignmentBaseRef(assignment: DurableProviderAssignment) {
	return text(record(record(assignment.decisionInput).input).exactBaseRef);
}

export function assignmentArtifactManifest(input: JsonRecord): AgentArtifactManifest | null {
	const output = record(input.output);
	const candidate = record(output.artifactManifest ?? record(output.metadata).artifactManifest ?? input.artifactManifest);
	return candidate.schemaVersion === 1 ? candidate as unknown as AgentArtifactManifest : null;
}

function reviewDisposition(manifest: AgentArtifactManifest) {
	const signals = records(manifest.signals);
	if (signals.some((signal) => ['review_rejected', 'revision_required'].includes(text(signal.type, signal.code)))) return 'rejected' as const;
	if (signals.some((signal) => ['review_approved', 'approved'].includes(text(signal.type, signal.code)))) return 'approved' as const;
	return null;
}

export async function projectCompletedAssignmentDeliverable(
	store: AssignmentDeliverableStore,
	assignment: DurableProviderAssignment,
	input: JsonRecord,
) {
	if (assignment.mode !== 'acting') return null;
	const { graphId, nodeId } = executionProvenance(assignment);
	if (!graphId || !nodeId) throw new CapacityGovernanceError('assignment_deliverable_provenance_missing', 'Acting assignment completion requires graph and node provenance.', 409, { assignmentId: assignment.id });
	const graph = await store.getDecisionAssignmentGraph(graphId);
	const node = graph?.nodes.find((candidate) => candidate.id === nodeId);
	const contractId = text(node?.metadata?.producesDeliverableContractId);
	if (!graph?.active || !node || !contractId) throw new CapacityGovernanceError('assignment_deliverable_graph_not_ready', 'Acting assignment completion does not reference an active deliverable-producing graph node.', 409, { assignmentId: assignment.id, graphId, nodeId });
	let contract = await store.getDeliverableContract(contractId);
	if (!contract) throw new CapacityGovernanceError('assignment_deliverable_contract_missing', 'Acting assignment deliverable contract is missing.', 500, { assignmentId: assignment.id, contractId });
	if (contract.status === 'approved') return contract;
	const manifest = assignmentArtifactManifest(input);
	if (!manifest) throw new CapacityGovernanceError('assignment_artifact_manifest_required', 'Acting assignment completion requires the canonical artifact manifest.', 409, { assignmentId: assignment.id, contractId });
	const validation = validateAgentArtifactManifest(manifest);
	if (!validation.ok) throw new CapacityGovernanceError('assignment_artifact_manifest_invalid', validation.reason ?? 'Acting assignment artifact manifest is invalid.', 409, { assignmentId: assignment.id, contractId });
	if (manifest.assignmentId !== assignment.id || manifest.projectId !== assignment.projectId || manifest.teamId !== assignment.teamId
		|| manifest.mode !== 'acting' || manifest.agentClassId !== assignment.projectAgentClassId
		|| (assignment.agentId && manifest.agentId !== assignment.agentId)) {
		throw new CapacityGovernanceError('assignment_artifact_manifest_scope_invalid', 'Artifact manifest scope does not match the completing assignment.', 409, { assignmentId: assignment.id, contractId });
	}
	const requiredTypes = node.outputRequirements.filter((requirement) => requirement.required !== false).map((requirement) => requirement.outputType);
	const producedRefs = manifest.contentReferences.filter((reference) => requiredTypes.includes(reference.artifactKind ?? ''))
		.map((reference) => ({
			model: reference.model as never,
			collection: reference.contentPath.split('/')[0] ?? reference.model,
			slug: reference.contentPath.split('/').at(-1)?.replace(/\.(?:md|mdx)$/iu, '') ?? reference.contentPath,
			path: reference.contentPath,
			subjectId: reference.subjectId ?? undefined,
			subjectField: reference.subjectField ?? undefined,
		}));
	if (!producedRefs.length) throw new CapacityGovernanceError('assignment_deliverable_output_missing', 'Artifact manifest does not satisfy the graph node output contract.', 409, { assignmentId: assignment.id, contractId, requiredTypes });
	const stage = text(node.metadata?.stage);
	if (['test', 'implementation'].includes(stage) && !manifest.commit?.sha) throw new CapacityGovernanceError('assignment_source_commit_required', `${stage} completion requires an assignment checkpoint commit.`, 409, { assignmentId: assignment.id, contractId });
	if (stage === 'verification' && !manifest.verification.some((entry) => entry.status === 'passed')) throw new CapacityGovernanceError('assignment_verification_evidence_required', 'Verification completion requires passing verification evidence.', 409, { assignmentId: assignment.id, contractId });
	const disposition = stage === 'review' ? reviewDisposition(manifest) : 'approved';
	if (stage === 'review' && !disposition) throw new CapacityGovernanceError('assignment_review_disposition_required', 'Review completion requires an explicit approved or rejected signal.', 409, { assignmentId: assignment.id, contractId });
	if (contract.status !== 'submitted') {
		const baseRef = assignmentBaseRef(assignment);
		if (!baseRef) throw new CapacityGovernanceError('assignment_source_base_ref_required', 'Engineering assignment completion requires immutable source authority.', 409, { assignmentId: assignment.id, contractId });
		const checkpointCommit = text(manifest.commit?.sha) || null;
		const deliverableManifestId = `deliverable:${assignment.id}`;
		await store.submitDeliverableManifest(contractId, {
			id: deliverableManifestId, producedRefs, summary: manifest.summary, readyForReview: true,
			submittedByAgentId: assignment.agentId, metadata: { assignmentId: assignment.id, modeRunId: manifest.modeRunId, graphId, nodeId, artifactManifestId: `${manifest.assignmentId}:${manifest.modeRunId}` },
			sourceAuthority: { assignmentId: assignment.id, modeRunId: manifest.modeRunId, baseRef, effectiveRef: checkpointCommit ?? baseRef, checkpointCommit },
		});
		contract = await store.getDeliverableContract(contractId);
	}
	if (contract?.status === 'approved') return contract;
	try {
		return disposition === 'rejected'
			? await store.markDeliverableContractRejected(contractId, { reason: 'Reviewer requested revision.', metadata: { assignmentId: assignment.id, modeRunId: manifest.modeRunId, deliverableManifestId: `deliverable:${assignment.id}` } })
			: await store.markDeliverableContractApproved(contractId, { approvedBy: assignment.agentId, metadata: { assignmentId: assignment.id, modeRunId: manifest.modeRunId, deliverableManifestId: `deliverable:${assignment.id}`, source: 'validated_assignment_completion' } });
	} catch (error) {
		const observed = await store.getDeliverableContract(contractId);
		if (observed?.status === disposition) return observed;
		throw error;
	}
}
