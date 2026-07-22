import {
	validateAgentArtifactManifest,
	type AgentArtifactManifest,
	type DeliverableManifestRecord,
	type GovernedPredecessorEvidence,
	type GovernedReviewPolicy,
} from '@treeseed/sdk/agent-capacity';
import type { CapacityGovernanceDatabase } from '../database.ts';
import { CapacityGovernanceError } from '../database.ts';
import { decodeDurableJsonObject } from '../durable-json.ts';

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function text(value: unknown): string {
	return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function immutableRef(value: unknown, context: JsonRecord): string {
	const ref = text(value);
	if (!/^[0-9a-f]{7,64}$/iu.test(ref)) {
		throw new CapacityGovernanceError('engineering_source_ref_invalid', 'Engineering source authority must be an immutable hexadecimal commit id.', 409, context);
	}
	return ref;
}

function artifactManifestFromOutputs(outputs: JsonRecord): AgentArtifactManifest | null {
	const candidate = record(outputs.artifactManifest ?? record(outputs.metadata).artifactManifest);
	return candidate.schemaVersion === 1 ? candidate as unknown as AgentArtifactManifest : null;
}

async function selectedPredecessorEvidence(input: {
	database: CapacityGovernanceDatabase;
	graphId: string;
	graph: JsonRecord;
	node: JsonRecord;
}): Promise<{ exactBaseRef: string; predecessorEvidence: GovernedPredecessorEvidence[]; reviewPolicy: GovernedReviewPolicy | null }> {
	const graphProjectId = text(input.graph.projectId);
	const graphDecisionId = text(input.graph.decisionId);
	const graphBaseRef = immutableRef(record(input.graph.metadata).exactBaseRef, { graphId: input.graphId, source: 'graph' });
	const nodes = Array.isArray(input.graph.nodes) ? input.graph.nodes.map(record) : [];
	const edges = Array.isArray(input.graph.edges) ? input.graph.edges.map(record) : [];
	const nodeId = text(input.node.id);
	const projectPredecessorEvidence = text(record(input.node.metadata).stage) === 'review';
	const immediatePredecessorIds = edges.filter((edge) => text(edge.toNodeId) === nodeId).map((edge) => text(edge.fromNodeId));
	const ancestorIds = new Set<string>();
	const pending = [...immediatePredecessorIds];
	while (pending.length) {
		const ancestorId = pending.pop()!;
		if (!ancestorId || ancestorIds.has(ancestorId)) continue;
		ancestorIds.add(ancestorId);
		for (const edge of edges.filter((candidate) => text(candidate.toNodeId) === ancestorId)) {
			const predecessorId = text(edge.fromNodeId);
			if (predecessorId) pending.push(predecessorId);
		}
	}
	const ancestors = nodes.filter((candidate) => ancestorIds.has(text(candidate.id)));
	const completedRevisionCycles = Math.max(0, ...nodes
		.map((candidate) => Number(record(candidate.metadata).revisionCycle ?? 0))
		.filter(Number.isFinite));
	const requireRevisionCycle = record(input.graph.metadata).requireRevisionCycle === true;
	const reviewPolicy = projectPredecessorEvidence ? {
		requireRevisionCycle,
		completedRevisionCycles,
		requiredDisposition: requireRevisionCycle && completedRevisionCycles === 0 ? 'rejected' as const : null,
	} : null;
	if (!ancestors.length) return { exactBaseRef: graphBaseRef, predecessorEvidence: [], reviewPolicy };

	const evidence: GovernedPredecessorEvidence[] = [];
	const effectiveRefs = new Map<string, string>();
	for (const predecessor of ancestors) {
		const predecessorNodeId = text(predecessor.id);
		if (predecessor.status !== 'completed') {
			throw new CapacityGovernanceError('engineering_predecessor_incomplete', 'Engineering evidence projection requires completed graph ancestors.', 409, { graphId: input.graphId, nodeId, predecessorNodeId });
		}
		const contractId = text(record(predecessor.metadata).producesDeliverableContractId);
		if (!contractId) throw new CapacityGovernanceError('engineering_source_contract_missing', 'Completed predecessor has no source-owning deliverable contract.', 409, { graphId: input.graphId, nodeId, predecessorNodeId });
		const contract = await input.database.first(`SELECT status, deliverable_type, metadata_json FROM deliverable_contracts WHERE id = ? LIMIT 1`, [contractId]);
		const contractStatus = text(contract?.status);
		if (!contract || !['approved', 'rejected'].includes(contractStatus)) {
			throw new CapacityGovernanceError('engineering_source_contract_unresolved', 'Predecessor source contract is not terminal.', 409, { graphId: input.graphId, nodeId, contractId });
		}
		const contractMetadata = decodeDurableJsonObject(contract.metadata_json, { owner: 'deliverable contract', ownerId: contractId, column: 'metadata_json' });
		const manifestId = text(contractMetadata.deliverableManifestId);
		if (!manifestId) throw new CapacityGovernanceError('engineering_source_manifest_missing', 'Terminal predecessor contract has no selected deliverable manifest.', 409, { graphId: input.graphId, nodeId, contractId });
		const manifestRow = await input.database.first(`SELECT manifest_json FROM deliverable_manifests WHERE id = ? AND deliverable_contract_id = ? LIMIT 1`, [manifestId, contractId]);
		if (!manifestRow) throw new CapacityGovernanceError('engineering_source_manifest_missing', 'Selected predecessor deliverable manifest does not exist.', 409, { graphId: input.graphId, nodeId, contractId, manifestId });
		const manifest = decodeDurableJsonObject(manifestRow.manifest_json, { owner: 'deliverable manifest', ownerId: manifestId, column: 'manifest_json' }) as unknown as DeliverableManifestRecord;
		const authority = record(manifest.sourceAuthority);
		if (text(manifest.projectId) !== graphProjectId || text(manifest.decisionId) !== graphDecisionId) {
			throw new CapacityGovernanceError('engineering_source_scope_mismatch', 'Predecessor source authority belongs to another project or decision.', 409, { graphId: input.graphId, nodeId, contractId, manifestId });
		}
		const effectiveRef = immutableRef(authority.effectiveRef, { graphId: input.graphId, nodeId, contractId, manifestId });
		if (immediatePredecessorIds.includes(predecessorNodeId)) effectiveRefs.set(predecessorNodeId, effectiveRef);
		if (!projectPredecessorEvidence) continue;
		const assignmentId = text(authority.assignmentId);
		const modeRunId = text(authority.modeRunId);
		if (!assignmentId || !modeRunId) {
			throw new CapacityGovernanceError('engineering_artifact_manifest_missing', 'Selected predecessor deliverable has no mode-run artifact provenance.', 409, { graphId: input.graphId, nodeId, contractId, manifestId });
		}
		const modeRun = await input.database.first(
			`SELECT outputs_json FROM agent_mode_runs WHERE id = ? AND provider_assignment_id = ? AND project_id = ? AND status = 'succeeded' LIMIT 1`,
			[modeRunId, assignmentId, graphProjectId],
		);
		if (!modeRun) throw new CapacityGovernanceError('engineering_artifact_manifest_missing', 'Selected predecessor mode run is missing or not successful.', 409, { graphId: input.graphId, nodeId, contractId, manifestId, assignmentId, modeRunId });
		const outputs = decodeDurableJsonObject(modeRun.outputs_json, { owner: 'agent mode run', ownerId: modeRunId, column: 'outputs_json' });
		const artifactManifest = artifactManifestFromOutputs(outputs);
		const validation = artifactManifest ? validateAgentArtifactManifest(artifactManifest) : null;
		if (!artifactManifest || !validation?.ok
			|| artifactManifest.assignmentId !== assignmentId
			|| artifactManifest.modeRunId !== modeRunId
			|| artifactManifest.projectId !== graphProjectId
			|| artifactManifest.status !== 'completed') {
			throw new CapacityGovernanceError('engineering_artifact_manifest_invalid', validation?.reason ?? 'Selected predecessor artifact manifest is missing, incomplete, or outside graph scope.', 409, { graphId: input.graphId, nodeId, contractId, manifestId, assignmentId, modeRunId });
		}
		evidence.push({
			graphNodeId: predecessorNodeId,
			stage: text(record(predecessor.metadata).stage) || null,
			deliverableContractId: contractId,
			deliverableType: text(contract.deliverable_type),
			contractStatus: contractStatus as 'approved' | 'rejected',
			deliverableManifest: manifest,
			artifactManifest,
		});
	}
	const uniqueRefs = [...new Set(effectiveRefs.values())];
	if (uniqueRefs.length !== 1) throw new CapacityGovernanceError('engineering_source_ref_ambiguous', 'Engineering node predecessors do not converge on one exact source ref.', 409, { graphId: input.graphId, nodeId, effectiveRefs: uniqueRefs });
	return { exactBaseRef: uniqueRefs[0]!, predecessorEvidence: evidence, reviewPolicy };
}

export async function resolveEngineeringNodeAuthority(input: {
	database: CapacityGovernanceDatabase;
	graphId: string;
	graph: JsonRecord;
	node: JsonRecord;
}): Promise<{ exactBaseRef: string | null; predecessorEvidence: GovernedPredecessorEvidence[]; reviewPolicy: GovernedReviewPolicy | null }> {
	if (record(input.graph.metadata).workflowKind !== 'engineering-test-first') return { exactBaseRef: null, predecessorEvidence: [], reviewPolicy: null };
	return selectedPredecessorEvidence(input);
}

export async function resolveEngineeringNodeSourceRef(input: {
	database: CapacityGovernanceDatabase;
	graphId: string;
	graph: JsonRecord;
	node: JsonRecord;
}): Promise<string | null> {
	return (await resolveEngineeringNodeAuthority(input)).exactBaseRef;
}
