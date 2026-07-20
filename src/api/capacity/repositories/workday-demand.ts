import { randomUUID } from 'node:crypto';
import type {
	CapacityWorkdayDemandRecord,
	CapacityWorkdayDemandSource,
	CapacityWorkdayDemandStatus,
} from '@treeseed/sdk/agent-capacity';
import { decodeDurableJsonObject } from '../durable-json.ts';
import type { CapacityGovernanceDatabase } from '../database.ts';
import { CapacityGovernanceError } from '../database.ts';

type Row = Record<string, unknown>;
type JsonRecord = Record<string, unknown>;

const SOURCES = new Set<CapacityWorkdayDemandSource>([
	'objective', 'question', 'proposal', 'decision-review', 'knowledge-gap', 'release-readiness',
	'idle-intent', 'planning-input', 'capacity-plan', 'assignment-completion', 'assignment-blockage',
	'workday-summary', 'handoff',
	'research-workflow',
]);
const STATUSES = new Set<CapacityWorkdayDemandStatus>([
	'pending', 'claimed', 'admitted', 'completed', 'blocked', 'cancelled', 'superseded',
]);

function required(row: Row, column: string): string {
	const value = row[column];
	if (typeof value !== 'string' || !value) throw new CapacityGovernanceError(
		'capacity_workday_demand_corrupt', `Capacity workday demand has invalid ${column}.`, 500,
		{ demandId: typeof row.id === 'string' ? row.id : null, column },
	);
	return value;
}
function nullable(value: unknown): string | null { return typeof value === 'string' && value ? value : null; }
function finite(row: Row, column: string, integer = false): number {
	const value = Number(row[column]);
	if (!Number.isFinite(value) || (integer && !Number.isInteger(value))) throw new CapacityGovernanceError(
		'capacity_workday_demand_corrupt', `Capacity workday demand has invalid ${column}.`, 500,
		{ demandId: String(row.id ?? ''), column, value: row[column] ?? null },
	);
	return value;
}

export function serializeCapacityWorkdayDemandRow(row: Row | null): CapacityWorkdayDemandRecord | null {
	if (!row) return null;
	const sourceType = required(row, 'source_type') as CapacityWorkdayDemandSource;
	const status = required(row, 'status') as CapacityWorkdayDemandStatus;
	const mode = required(row, 'mode');
	if (!SOURCES.has(sourceType) || !STATUSES.has(status) || !['planning', 'acting'].includes(mode)) throw new CapacityGovernanceError(
		'capacity_workday_demand_corrupt', 'Capacity workday demand has an unknown source, status, or mode.', 500,
		{ demandId: String(row.id ?? ''), sourceType, status, mode },
	);
	const requestedCredits = finite(row, 'requested_credits');
	if (requestedCredits <= 0) throw new CapacityGovernanceError('capacity_workday_demand_corrupt', 'Demand credits must be positive.', 500, { demandId: String(row.id ?? '') });
	return {
		id: required(row, 'id'), teamId: required(row, 'team_id'), projectId: required(row, 'project_id'),
		workdayRunId: required(row, 'workday_run_id'), workdayId: required(row, 'workday_id'), sourceType,
		sourceId: required(row, 'source_id'), mode: mode as 'planning' | 'acting',
		projectAgentClassId: required(row, 'project_agent_class_id'), agentId: nullable(row.agent_id),
		handlerId: required(row, 'handler_id'), activityType: required(row, 'activity_type'),
		decisionId: nullable(row.decision_id), capacityPlanId: nullable(row.capacity_plan_id), status,
		priority: finite(row, 'priority', true), requestedCredits, idempotencyKey: required(row, 'idempotency_key'),
		claimToken: nullable(row.claim_token), assignmentId: nullable(row.assignment_id),
		payload: decodeDurableJsonObject(row.payload_json, { owner: 'capacity workday demand', ownerId: String(row.id ?? ''), column: 'payload_json' }),
		metadata: decodeDurableJsonObject(row.metadata_json, { owner: 'capacity workday demand', ownerId: String(row.id ?? ''), column: 'metadata_json' }),
		availableAt: required(row, 'available_at'), claimedAt: nullable(row.claimed_at), admittedAt: nullable(row.admitted_at),
		completedAt: nullable(row.completed_at), createdAt: required(row, 'created_at'), updatedAt: required(row, 'updated_at'),
	};
}

export interface CapacityWorkdayDemandWrite {
	id: string; teamId: string; projectId: string; workdayRunId: string; workdayId: string;
	sourceType: CapacityWorkdayDemandSource; sourceId: string; mode: 'planning' | 'acting';
	projectAgentClassId: string; agentId: string | null; handlerId: string; activityType: string;
	decisionId?: string | null; capacityPlanId?: string | null; priority: number; requestedCredits: number;
	idempotencyKey: string; payload: JsonRecord; metadata?: JsonRecord; availableAt: string; now: string;
}

export class CapacityWorkdayDemandRepository {
	constructor(private readonly database: CapacityGovernanceDatabase) {}

	async create(value: CapacityWorkdayDemandWrite): Promise<CapacityWorkdayDemandRecord> {
		await this.database.ensureInitialized();
		await this.database.run(
			`INSERT INTO capacity_workday_demands (id, team_id, project_id, workday_run_id, workday_id, source_type, source_id,
			 mode, project_agent_class_id, agent_id, handler_id, activity_type, decision_id, capacity_plan_id, status, priority,
			 requested_credits, idempotency_key, payload_json, metadata_json, available_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (team_id, idempotency_key) DO NOTHING`,
			[value.id, value.teamId, value.projectId, value.workdayRunId, value.workdayId, value.sourceType, value.sourceId,
				value.mode, value.projectAgentClassId, value.agentId, value.handlerId, value.activityType, value.decisionId ?? null,
				value.capacityPlanId ?? null, value.priority, value.requestedCredits, value.idempotencyKey,
				JSON.stringify(value.payload), JSON.stringify(value.metadata ?? {}), value.availableAt, value.now, value.now],
		);
		const result = serializeCapacityWorkdayDemandRow(await this.database.first(
			`SELECT * FROM capacity_workday_demands WHERE team_id = ? AND idempotency_key = ? LIMIT 1`,
			[value.teamId, value.idempotencyKey],
		));
		if (!result) throw new CapacityGovernanceError('capacity_workday_demand_persistence_failed', 'Demand was not durably persisted.', 500, { idempotencyKey: value.idempotencyKey });
		return result;
	}

	async claimNext(teamId: string, providerId: string, now: string): Promise<CapacityWorkdayDemandRecord | null> {
		await this.database.ensureInitialized();
		const candidate = await this.database.first(
			`SELECT demand.id FROM capacity_workday_demands demand
			 JOIN capacity_workday_runs run ON run.id = demand.workday_run_id
			 JOIN workday_capacity_envelopes workday ON workday.id = demand.workday_id
			 WHERE demand.team_id = ? AND run.capacity_provider_id = ? AND run.status = 'running'
			   AND workday.status = 'active' AND demand.status = 'pending' AND demand.available_at <= ?
			 ORDER BY demand.priority DESC, demand.available_at ASC, demand.created_at ASC, demand.id ASC LIMIT 1`,
			[teamId, providerId, now],
		);
		if (!candidate?.id) return null;
		const claimToken = randomUUID();
		await this.database.run(
			`UPDATE capacity_workday_demands SET status = 'claimed', claim_token = ?, claimed_at = ?, updated_at = ?
			 WHERE id = ? AND status = 'pending'`,
			[claimToken, now, now, candidate.id],
		);
		return serializeCapacityWorkdayDemandRow(await this.database.first(
			`SELECT * FROM capacity_workday_demands WHERE claim_token = ? LIMIT 1`, [claimToken],
		));
	}

	async markAdmitted(demandId: string, claimToken: string, assignmentId: string, now: string): Promise<CapacityWorkdayDemandRecord | null> {
		await this.database.run(
			`UPDATE capacity_workday_demands SET status = 'admitted', assignment_id = ?, admitted_at = ?, updated_at = ?
			 WHERE id = ? AND status = 'claimed' AND claim_token = ?`, [assignmentId, now, now, demandId, claimToken],
		);
		return serializeCapacityWorkdayDemandRow(await this.database.first(`SELECT * FROM capacity_workday_demands WHERE id = ? LIMIT 1`, [demandId]));
	}

	async releaseClaim(demandId: string, claimToken: string, now: string): Promise<void> {
		await this.database.run(
			`UPDATE capacity_workday_demands SET status = 'pending', claim_token = NULL, claimed_at = NULL, updated_at = ?
			 WHERE id = ? AND status = 'claimed' AND claim_token = ?`, [now, demandId, claimToken],
		);
	}

	async listProvisioning(teamId: string, providerId: string, limit = 25): Promise<CapacityWorkdayDemandRecord[]> {
		const rows = await this.database.all(
			`SELECT demand.* FROM capacity_workday_demands demand
			 JOIN capacity_workday_runs run ON run.id = demand.workday_run_id
			 JOIN treedx_proxy_handles handle ON handle.assignment_id = demand.assignment_id
			 WHERE demand.team_id = ? AND run.capacity_provider_id = ? AND demand.status = 'admitted' AND handle.status = 'provisioning'
			 ORDER BY demand.admitted_at ASC, demand.id ASC LIMIT ?`, [teamId, providerId, limit],
		);
		return rows.map((row) => serializeCapacityWorkdayDemandRow(row)!);
	}
}
