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

export async function resolveEngineeringNodeSourceRef(input: {
	database: CapacityGovernanceDatabase;
	graphId: string;
	graph: JsonRecord;
	node: JsonRecord;
}): Promise<string | null> {
	if (record(input.graph.metadata).workflowKind !== 'engineering-test-first') return null;
	const graphBaseRef = immutableRef(record(input.graph.metadata).exactBaseRef, { graphId: input.graphId, source: 'graph' });
	const nodes = Array.isArray(input.graph.nodes) ? input.graph.nodes.map(record) : [];
	const edges = Array.isArray(input.graph.edges) ? input.graph.edges.map(record) : [];
	const nodeId = text(input.node.id);
	const predecessors = edges.filter((edge) => text(edge.toNodeId) === nodeId)
		.map((edge) => nodes.find((node) => text(node.id) === text(edge.fromNodeId)))
		.filter((node): node is JsonRecord => Boolean(node));
	if (!predecessors.length) return graphBaseRef;

	const effectiveRefs: string[] = [];
	for (const predecessor of predecessors) {
		const contractId = text(record(predecessor.metadata).producesDeliverableContractId);
		if (!contractId) throw new CapacityGovernanceError('engineering_source_contract_missing', 'Completed predecessor has no source-owning deliverable contract.', 409, { graphId: input.graphId, nodeId, predecessorNodeId: predecessor.id });
		const contract = await input.database.first(`SELECT status, metadata_json FROM deliverable_contracts WHERE id = ? LIMIT 1`, [contractId]);
		if (!contract || !['approved', 'rejected'].includes(String(contract.status ?? ''))) {
			throw new CapacityGovernanceError('engineering_source_contract_unresolved', 'Predecessor source contract is not terminal.', 409, { graphId: input.graphId, nodeId, contractId });
		}
		const contractMetadata = decodeDurableJsonObject(contract.metadata_json, { owner: 'deliverable contract', ownerId: contractId, column: 'metadata_json' });
		const manifestId = text(contractMetadata.deliverableManifestId);
		if (!manifestId) throw new CapacityGovernanceError('engineering_source_manifest_missing', 'Terminal predecessor contract has no selected deliverable manifest.', 409, { graphId: input.graphId, nodeId, contractId });
		const manifestRow = await input.database.first(`SELECT manifest_json FROM deliverable_manifests WHERE id = ? AND deliverable_contract_id = ? LIMIT 1`, [manifestId, contractId]);
		if (!manifestRow) throw new CapacityGovernanceError('engineering_source_manifest_missing', 'Selected predecessor deliverable manifest does not exist.', 409, { graphId: input.graphId, nodeId, contractId, manifestId });
		const manifest = decodeDurableJsonObject(manifestRow.manifest_json, { owner: 'deliverable manifest', ownerId: manifestId, column: 'manifest_json' });
		const authority = record(manifest.sourceAuthority);
		if (text(manifest.projectId) !== text(input.graph.projectId) || text(manifest.decisionId) !== text(input.graph.decisionId)) {
			throw new CapacityGovernanceError('engineering_source_scope_mismatch', 'Predecessor source authority belongs to another project or decision.', 409, { graphId: input.graphId, nodeId, contractId, manifestId });
		}
		effectiveRefs.push(immutableRef(authority.effectiveRef, { graphId: input.graphId, nodeId, contractId, manifestId }));
	}
	const uniqueRefs = [...new Set(effectiveRefs)];
	if (uniqueRefs.length !== 1) throw new CapacityGovernanceError('engineering_source_ref_ambiguous', 'Engineering node predecessors do not converge on one exact source ref.', 409, { graphId: input.graphId, nodeId, effectiveRefs: uniqueRefs });
	return uniqueRefs[0]!;
}
