import type {
	DecisionPlanningStatus,
	StructuredAgentEstimate,
	StructuredAgentEstimateRecord,
	StructuredAgentEstimateStatus,
} from '@treeseed/sdk/agent-capacity';
import { validateStructuredAgentEstimate } from '@treeseed/sdk/agent-capacity';
import { decodeDurableJsonObject } from '../../durable-json.ts';
import type { CapacityGovernanceDatabase } from '../../database.ts';
import { CapacityGovernanceError } from '../../database.ts';
import { decisionPlanningStatusOperation } from './planning-state.ts';

type Row = Record<string, unknown>;
const STATUSES = new Set<StructuredAgentEstimateStatus>(['submitted', 'accepted', 'rejected', 'superseded']);

function required(row: Row, column: string): string {
	const value = row[column];
	if (typeof value !== 'string' || !value) throw new CapacityGovernanceError('structured_agent_estimate_corrupt', `Structured estimate has invalid ${column}.`, 500, { estimateId: typeof row.id === 'string' ? row.id : null, column });
	return value;
}
function nullable(row: Row, column: string): string | null { const value = row[column]; return value == null ? null : required(row, column); }
function status(value: unknown, errorStatus = 500): StructuredAgentEstimateStatus {
	const candidate = String(value ?? '') as StructuredAgentEstimateStatus;
	if (!STATUSES.has(candidate)) throw new CapacityGovernanceError('structured_agent_estimate_status_invalid', `Unknown structured estimate status ${candidate || '(empty)'}.`, errorStatus);
	return candidate;
}

export function serializeStructuredAgentEstimateRow(row: Row | null): StructuredAgentEstimateRecord | null {
	if (!row) return null;
	const id = required(row, 'id');
	const stored = decodeDurableJsonObject(row.estimate_json, { owner: 'structured agent estimate', ownerId: id, column: 'estimate_json' }) as unknown as StructuredAgentEstimate;
	const metadata = decodeDurableJsonObject(row.metadata_json, { owner: 'structured agent estimate', ownerId: id, column: 'metadata_json' });
	const estimate: StructuredAgentEstimateRecord = {
		...stored,
		id,
		teamId: required(row, 'team_id'),
		projectId: required(row, 'project_id'),
		decisionId: nullable(row, 'decision_id'),
		proposalId: nullable(row, 'proposal_id'),
		workUnitId: nullable(row, 'work_unit_id'),
		agentClass: required(row, 'agent_class'),
		agentId: nullable(row, 'agent_id'),
		status: status(row.status),
		metadata: { ...(stored.metadata ?? {}), ...metadata },
		createdAt: required(row, 'created_at'),
		acceptedAt: nullable(row, 'accepted_at'),
		rejectedAt: nullable(row, 'rejected_at'),
	};
	const validation = validateStructuredAgentEstimate(estimate);
	if (!validation.ok) throw new CapacityGovernanceError('structured_agent_estimate_corrupt', 'Stored structured estimate violates the SDK contract.', 500, { estimateId: id, diagnostics: validation.diagnostics });
	return estimate;
}

export class StructuredAgentEstimateRepository {
	constructor(private readonly database: CapacityGovernanceDatabase) {}

	async get(id: string) {
		await this.database.ensureInitialized();
		return serializeStructuredAgentEstimateRow(await this.database.first(`SELECT * FROM structured_agent_estimates WHERE id = ? LIMIT 1`, [id]));
	}

	async listDecision(decisionId: string, filterStatus?: StructuredAgentEstimateStatus | null) {
		await this.database.ensureInitialized();
		const selectedStatus = filterStatus ? status(filterStatus, 400) : null;
		const rows = await this.database.all(`SELECT * FROM structured_agent_estimates WHERE decision_id = ?${selectedStatus ? ' AND status = ?' : ''} ORDER BY created_at ASC, agent_class ASC, id ASC LIMIT 500`, selectedStatus ? [decisionId, selectedStatus] : [decisionId]);
		return rows.map((row) => serializeStructuredAgentEstimateRow(row)!);
	}

	async create(value: StructuredAgentEstimateRecord, recordMetadata: Record<string, unknown>, planning: DecisionPlanningStatus) {
		await this.database.ensureInitialized();
		await this.database.batch([
			decisionPlanningStatusOperation(planning),
			{
				query: `INSERT INTO structured_agent_estimates (
					id, team_id, project_id, decision_id, proposal_id, work_unit_id, agent_class, agent_id, status,
					estimate_json, metadata_json, created_at, accepted_at, rejected_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				params: [value.id, value.teamId, value.projectId, value.decisionId ?? null, value.proposalId ?? null, value.workUnitId ?? null,
					value.agentClass, value.agentId ?? null, value.status, JSON.stringify(value), JSON.stringify(recordMetadata), value.createdAt,
					value.acceptedAt, value.rejectedAt],
			},
		]);
		return this.get(value.id);
	}

	async transition(id: string, from: StructuredAgentEstimateStatus[], to: StructuredAgentEstimateStatus, metadata: Record<string, unknown>, now: string) {
		const next = status(to, 400);
		const existing = await this.get(id);
		if (!existing) return null;
		if (!from.includes(existing.status)) throw new CapacityGovernanceError('structured_agent_estimate_transition_conflict', `Cannot transition structured estimate from ${existing.status} to ${next}.`, 409, { estimateId: id, from: existing.status, to: next });
		await this.database.run(`UPDATE structured_agent_estimates SET status = ?, metadata_json = ?, accepted_at = CASE WHEN ? = 'accepted' THEN COALESCE(accepted_at, ?) ELSE accepted_at END, rejected_at = CASE WHEN ? = 'rejected' THEN COALESCE(rejected_at, ?) ELSE rejected_at END WHERE id = ? AND status = ?`,
			[next, JSON.stringify(metadata), next, now, next, now, id, existing.status]);
		const updated = await this.get(id);
		if (updated?.status !== next) throw new CapacityGovernanceError('structured_agent_estimate_transition_conflict', 'Structured estimate changed concurrently.', 409, { estimateId: id });
		return updated;
	}
}
