import type {
	DecisionAssignmentGraphRecord,
	DecisionPlanningStatus,
	DeliverableContractRecord,
	DeliverableManifestRecord,
} from '@treeseed/sdk/agent-capacity';
import { validateDecisionAssignmentGraph, validateDeliverableContract, validateDeliverableManifest } from '@treeseed/sdk/agent-capacity';
import { decodeDurableJsonObject } from '../durable-json.ts';
import type { CapacityDatabaseOperation, CapacityGovernanceDatabase } from '../database.ts';
import { CapacityGovernanceError } from '../database.ts';
import { decisionPlanningStatusOperation } from './planning-state.ts';

type Row = Record<string, unknown>;
type JsonRecord = Record<string, unknown>;
const GRAPH_STATUSES = new Set(['draft', 'compiled', 'ready', 'executing', 'completed', 'blocked']);
const CONTRACT_STATUSES = new Set(['required', 'draft', 'submitted', 'approved', 'rejected']);

function corrupt(owner: string, row: Row, column: string): never {
	throw new CapacityGovernanceError(`${owner}_corrupt`, `${owner.replaceAll('_', ' ')} has invalid ${column}.`, 500, { id: typeof row.id === 'string' ? row.id : null, column });
}
function text(owner: string, row: Row, column: string): string { const value = row[column]; return typeof value === 'string' && value ? value : corrupt(owner, row, column); }
function nullable(owner: string, row: Row, column: string): string | null { return row[column] == null ? null : text(owner, row, column); }
function metadata(owner: string, row: Row): JsonRecord { return decodeDurableJsonObject(row.metadata_json, { owner: owner.replaceAll('_', ' '), ownerId: text(owner, row, 'id'), column: 'metadata_json' }); }

export function serializeDecisionAssignmentGraphRow(row: Row | null): DecisionAssignmentGraphRecord | null {
	if (!row) return null;
	const owner = 'decision_assignment_graph';
	const id = text(owner, row, 'id');
	const stored = decodeDurableJsonObject(row.graph_json, { owner: 'decision assignment graph', ownerId: id, column: 'graph_json' }) as unknown as DecisionAssignmentGraphRecord;
	const status = text(owner, row, 'status') as DecisionAssignmentGraphRecord['status'];
	if (!GRAPH_STATUSES.has(status)) corrupt(owner, row, 'status');
	const version = Number(row.version);
	if (!Number.isInteger(version) || version < 1) corrupt(owner, row, 'version');
	if (row.active !== 0 && row.active !== 1 && row.active !== false && row.active !== true) corrupt(owner, row, 'active');
	const graph: DecisionAssignmentGraphRecord = {
		...stored, id, teamId: text(owner, row, 'team_id'), projectId: text(owner, row, 'project_id'), decisionId: text(owner, row, 'decision_id'),
		version, status, active: row.active === 1 || row.active === true, metadata: { ...(stored.metadata ?? {}), ...metadata(owner, row) },
		compiledAt: nullable(owner, row, 'compiled_at'), createdAt: text(owner, row, 'created_at'), updatedAt: text(owner, row, 'updated_at'),
	};
	const validation = validateDecisionAssignmentGraph(graph);
	if (!validation.ok) throw new CapacityGovernanceError('decision_assignment_graph_corrupt', 'Stored decision assignment graph violates the SDK contract.', 500, { graphId: id, diagnostics: validation.diagnostics });
	return graph;
}

export function serializeDeliverableContractRow(row: Row | null): DeliverableContractRecord | null {
	if (!row) return null;
	const owner = 'deliverable_contract';
	const id = text(owner, row, 'id');
	const stored = decodeDurableJsonObject(row.contract_json, { owner: 'deliverable contract', ownerId: id, column: 'contract_json' }) as unknown as DeliverableContractRecord;
	const status = text(owner, row, 'status') as DeliverableContractRecord['status'];
	if (!CONTRACT_STATUSES.has(status)) corrupt(owner, row, 'status');
	const contract: DeliverableContractRecord = {
		...stored, id, teamId: text(owner, row, 'team_id'), projectId: text(owner, row, 'project_id'), decisionId: text(owner, row, 'decision_id'),
		deliverableType: text(owner, row, 'deliverable_type'), status, metadata: { ...(stored.metadata ?? {}), ...metadata(owner, row) },
		createdAt: text(owner, row, 'created_at'), updatedAt: text(owner, row, 'updated_at'),
	};
	const validation = validateDeliverableContract(contract);
	if (!validation.ok) throw new CapacityGovernanceError('deliverable_contract_corrupt', 'Stored deliverable contract violates the SDK contract.', 500, { contractId: id, diagnostics: validation.diagnostics });
	return contract;
}

export function serializeDeliverableManifestRow(row: Row | null): DeliverableManifestRecord | null {
	if (!row) return null;
	const owner = 'deliverable_manifest';
	const id = text(owner, row, 'id');
	const stored = decodeDurableJsonObject(row.manifest_json, { owner: 'deliverable manifest', ownerId: id, column: 'manifest_json' }) as unknown as DeliverableManifestRecord;
	if (row.ready_for_review !== 0 && row.ready_for_review !== 1 && row.ready_for_review !== false && row.ready_for_review !== true) corrupt(owner, row, 'ready_for_review');
	const manifest: DeliverableManifestRecord = {
		...stored, id, deliverableContractId: text(owner, row, 'deliverable_contract_id'), projectId: text(owner, row, 'project_id'),
		decisionId: text(owner, row, 'decision_id'), readyForReview: row.ready_for_review === 1 || row.ready_for_review === true,
		metadata: { ...(stored.metadata ?? {}), ...metadata(owner, row) }, submittedAt: nullable(owner, row, 'submitted_at'), createdAt: text(owner, row, 'created_at'),
	};
	const validation = validateDeliverableManifest(manifest);
	if (!validation.ok) throw new CapacityGovernanceError('deliverable_manifest_corrupt', 'Stored deliverable manifest violates the SDK contract.', 500, { manifestId: id, diagnostics: validation.diagnostics });
	return manifest;
}

function contractInsert(contract: DeliverableContractRecord, idempotent = false): CapacityDatabaseOperation {
	return {
		query: `INSERT INTO deliverable_contracts (id, team_id, project_id, decision_id, deliverable_type, status, contract_json, metadata_json, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)${idempotent ? ' ON CONFLICT (id) DO NOTHING' : ''}`,
		params: [contract.id, contract.teamId, contract.projectId, contract.decisionId, contract.deliverableType, contract.status, JSON.stringify(contract), JSON.stringify(contract.metadata ?? {}), contract.createdAt, contract.updatedAt],
	};
}

function graphBusinessFingerprint(graph: DecisionAssignmentGraphRecord) {
	const { active: _active, compiledAt: _compiledAt, createdAt: _createdAt, updatedAt: _updatedAt, status: _status, ...business } = graph;
	return JSON.stringify(business);
}

export class DecisionWorkGraphRepository {
	constructor(private readonly database: CapacityGovernanceDatabase) {}
	async getGraph(id: string) { await this.database.ensureInitialized(); return serializeDecisionAssignmentGraphRow(await this.database.first(`SELECT * FROM decision_assignment_graphs WHERE id = ? LIMIT 1`, [id])); }
	async listGraphs(decisionId: string, active?: boolean) {
		await this.database.ensureInitialized();
		const rows = await this.database.all(`SELECT * FROM decision_assignment_graphs WHERE decision_id = ?${active === undefined ? '' : ' AND active = ?'} ORDER BY version DESC, created_at DESC LIMIT 100`, active === undefined ? [decisionId] : [decisionId, active ? 1 : 0]);
		return rows.map((row) => serializeDecisionAssignmentGraphRow(row)!);
	}
	async nextVersion(decisionId: string) { await this.database.ensureInitialized(); const row = await this.database.first(`SELECT COALESCE(MAX(version), 0) AS version FROM decision_assignment_graphs WHERE decision_id = ?`, [decisionId]); return Number(row?.version ?? 0) + 1; }
	async createGraph(graph: DecisionAssignmentGraphRecord, contracts: DeliverableContractRecord[]) {
		await this.database.ensureInitialized();
		await this.database.batch([
			{ query: `INSERT INTO decision_assignment_graphs (id, team_id, project_id, decision_id, version, status, active, graph_json, metadata_json, compiled_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`, params: [graph.id, graph.teamId, graph.projectId, graph.decisionId, graph.version, graph.status, JSON.stringify(graph), JSON.stringify(graph.metadata ?? {}), graph.compiledAt ?? null, graph.createdAt, graph.updatedAt] },
			...contracts.map((contract) => contractInsert(contract, true)),
		]);
		const persisted = await this.getGraph(graph.id);
		if (!persisted || graphBusinessFingerprint(persisted) !== graphBusinessFingerprint(graph)) {
			throw new CapacityGovernanceError('decision_assignment_graph_idempotency_conflict', 'Decision assignment graph id is already owned by different graph content.', 409, { graphId: graph.id });
		}
		return persisted;
	}
	async activate(graph: DecisionAssignmentGraphRecord, planning: DecisionPlanningStatus, now: string, expectedStatus: DecisionAssignmentGraphRecord['status']) {
		await this.database.batch([
			decisionPlanningStatusOperation(planning),
			{ query: `UPDATE decision_assignment_graphs SET active = 0, updated_at = ? WHERE decision_id = ? AND active = 1`, params: [now, graph.decisionId] },
			{ query: `UPDATE decision_assignment_graphs SET active = 1, status = 'ready', graph_json = ?, updated_at = ? WHERE id = ? AND status = ? RETURNING id, active, status`, params: [JSON.stringify(graph), now, graph.id, expectedStatus] },
			{ query: `SELECT 1 / CASE WHEN EXISTS (SELECT 1 FROM decision_assignment_graphs WHERE id = ? AND decision_id = ? AND active = 1 AND status = 'ready') THEN 1 ELSE 0 END AS activation_guard`, params: [graph.id, graph.decisionId] },
		]);
		const updated = await this.getGraph(graph.id);
		if (!updated?.active || updated.status !== 'ready') throw new CapacityGovernanceError('decision_assignment_graph_activation_conflict', 'Decision assignment graph changed concurrently or is not activatable.', 409, { graphId: graph.id });
		return updated;
	}
	async getContract(id: string) { await this.database.ensureInitialized(); return serializeDeliverableContractRow(await this.database.first(`SELECT * FROM deliverable_contracts WHERE id = ? LIMIT 1`, [id])); }
	async getManifest(id: string) { await this.database.ensureInitialized(); return serializeDeliverableManifestRow(await this.database.first(`SELECT * FROM deliverable_manifests WHERE id = ? LIMIT 1`, [id])); }
	async submitManifest(contract: DeliverableContractRecord, manifest: DeliverableManifestRecord) {
		await this.database.batch([
			{ query: `UPDATE deliverable_contracts SET status = CASE WHEN ? = 1 THEN 'submitted' ELSE status END, updated_at = ? WHERE id = ? AND status IN ('required','draft','rejected')`, params: [manifest.readyForReview ? 1 : 0, manifest.createdAt, contract.id] },
			{ query: `INSERT INTO deliverable_manifests (id, deliverable_contract_id, project_id, decision_id, ready_for_review, manifest_json, metadata_json, submitted_at, created_at)
				SELECT ?, ?, ?, ?, CAST(? AS integer), ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM deliverable_contracts WHERE id = ? AND status IN ('required','draft','submitted','rejected')) ON CONFLICT (id) DO NOTHING`,
				params: [manifest.id, manifest.deliverableContractId, manifest.projectId, manifest.decisionId, manifest.readyForReview ? 1 : 0, JSON.stringify(manifest), JSON.stringify(manifest.metadata ?? {}), manifest.submittedAt ?? null, manifest.createdAt, contract.id] },
			{ query: `SELECT 1 / CASE WHEN EXISTS (SELECT 1 FROM deliverable_manifests WHERE id = ? AND deliverable_contract_id = ?) THEN 1 ELSE 0 END AS manifest_guard`, params: [manifest.id, contract.id] },
		]);
		return this.getManifest(manifest.id);
	}
	async transitionContract(
		contract: DeliverableContractRecord,
		to: 'approved' | 'rejected',
		metadataValue: JsonRecord,
		graph: DecisionAssignmentGraphRecord,
		expectedGraphUpdatedAt: string,
		newContracts: DeliverableContractRecord[],
		now: string,
	) {
		if (contract.status !== 'submitted') throw new CapacityGovernanceError('deliverable_contract_transition_conflict', `Cannot transition deliverable contract from ${contract.status} to ${to}.`, 409, { contractId: contract.id });
		await this.database.batch([
			{ query: `UPDATE deliverable_contracts SET status = ?, metadata_json = ?, updated_at = ? WHERE id = ? AND status = 'submitted'`, params: [to, JSON.stringify(metadataValue), now, contract.id] },
			{ query: `UPDATE decision_assignment_graphs SET status = ?, graph_json = ?, metadata_json = ?, updated_at = ? WHERE id = ? AND version = ? AND updated_at = ?`, params: [graph.status, JSON.stringify(graph), JSON.stringify(graph.metadata ?? {}), now, graph.id, graph.version, expectedGraphUpdatedAt] },
			...newContracts.map(contractInsert),
			{ query: `SELECT 1 / CASE WHEN EXISTS (SELECT 1 FROM deliverable_contracts WHERE id = ? AND status = ?) THEN 1 ELSE 0 END AS transition_guard`, params: [contract.id, to] },
			{ query: `SELECT 1 / CASE WHEN EXISTS (SELECT 1 FROM decision_assignment_graphs WHERE id = ? AND updated_at = ?) THEN 1 ELSE 0 END AS graph_transition_guard`, params: [graph.id, now] },
		]);
		const updated = await this.getContract(contract.id);
		if (updated?.status !== to) throw new CapacityGovernanceError('deliverable_contract_transition_conflict', 'Deliverable contract changed concurrently.', 409, { contractId: contract.id });
		return updated;
	}
}
