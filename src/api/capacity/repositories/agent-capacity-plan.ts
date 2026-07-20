import type {
	AgentCapacityPlanRecord,
	AgentCapacityPlanWorkUnit,
	DurableAgentCapacityPlanStatus,
} from '@treeseed/sdk/agent-capacity';
import { decodeDurableJsonArray, decodeDurableJsonObject } from '../durable-json.ts';
import type { CapacityGovernanceDatabase } from '../database.ts';
import { CapacityGovernanceError } from '../database.ts';

type Row = Record<string, unknown>;
type JsonRecord = Record<string, unknown>;

const STATUSES = new Set<DurableAgentCapacityPlanStatus>([
	'draft', 'accepted', 'revision_requested', 'deferred', 'scheduled', 'active', 'completed', 'superseded',
]);

export interface AgentCapacityPlanTransitionInput {
	workDayId?: string | null;
	allocationSetId?: string | null;
	reason?: string | null;
	review?: JsonRecord;
	metadata?: JsonRecord;
}

function text(value: unknown): string {
	return value == null ? '' : String(value);
}

function nullableText(value: unknown): string | null {
	return value == null ? null : String(value);
}

function status(value: unknown): DurableAgentCapacityPlanStatus {
	const candidate = text(value) as DurableAgentCapacityPlanStatus;
	if (!STATUSES.has(candidate)) {
		throw new CapacityGovernanceError('agent_capacity_plan_status_invalid', `Unknown agent capacity plan status ${candidate || '(empty)'}.`, 500);
	}
	return candidate;
}

function finiteAmount(value: unknown, field: string, planId: string): number {
	const amount = Number(value);
	if (!Number.isFinite(amount) || amount < 0) {
		throw new CapacityGovernanceError('agent_capacity_plan_amount_invalid', `Agent capacity plan ${planId} has invalid ${field}.`, 500, { planId, field });
	}
	return amount;
}

function context(id: string, column: string) {
	return { owner: 'agent capacity plan', ownerId: id, column };
}

export function serializeAgentCapacityPlanRow(row: Row | null): AgentCapacityPlanRecord | null {
	if (!row) return null;
	const id = text(row.id);
	const expectedCredits = finiteAmount(row.expected_credits, 'expected_credits', id);
	const highCredits = finiteAmount(row.high_credits, 'high_credits', id);
	if (highCredits < expectedCredits) {
		throw new CapacityGovernanceError('agent_capacity_plan_amount_invalid', `Agent capacity plan ${id} high credits are below expected credits.`, 500, { planId: id });
	}
	for (const [field, value] of [['teamId', row.team_id], ['projectId', row.project_id], ['decisionId', row.decision_id], ['scopeHash', row.scope_hash]] as const) {
		if (!text(value)) throw new CapacityGovernanceError('agent_capacity_plan_field_invalid', `Agent capacity plan ${id || '(unknown)'} requires ${field}.`, 500, { planId: id || null, field });
	}
	return {
		id,
		teamId: text(row.team_id),
		projectId: text(row.project_id),
		decisionId: text(row.decision_id),
		status: status(row.status),
		scopeHash: text(row.scope_hash),
		allocationSetId: nullableText(row.allocation_set_id),
		workDayId: nullableText(row.work_day_id),
		expectedCredits,
		highCredits,
		workUnits: decodeDurableJsonArray<AgentCapacityPlanWorkUnit>(row.work_units_json, context(id, 'work_units_json')),
		capabilityNeeds: decodeDurableJsonArray<string>(row.capability_needs_json, context(id, 'capability_needs_json')),
		environmentNeeds: decodeDurableJsonArray<string>(row.environment_needs_json, context(id, 'environment_needs_json')),
		reserves: decodeDurableJsonObject(row.reserves_json, context(id, 'reserves_json')),
		blockers: decodeDurableJsonArray<string>(row.blockers_json, context(id, 'blockers_json')),
		priorityRationale: nullableText(row.priority_rationale),
		review: decodeDurableJsonObject(row.review_json, context(id, 'review_json')),
		metadata: decodeDurableJsonObject(row.metadata_json, context(id, 'metadata_json')),
		acceptedAt: nullableText(row.accepted_at),
		scheduledAt: nullableText(row.scheduled_at),
		supersededAt: nullableText(row.superseded_at),
		createdAt: text(row.created_at),
		updatedAt: text(row.updated_at),
	};
}

export class AgentCapacityPlanRepository {
	constructor(private readonly database: CapacityGovernanceDatabase) {}

	async upsert(plan: AgentCapacityPlanRecord, review: JsonRecord = {}) {
		await this.database.ensureInitialized();
		const now = plan.updatedAt ?? new Date().toISOString();
		await this.database.run(
			`INSERT INTO agent_capacity_plans (
				id, team_id, project_id, decision_id, status, scope_hash, allocation_set_id, work_day_id,
				expected_credits, high_credits, work_units_json, capability_needs_json, environment_needs_json,
				reserves_json, blockers_json, priority_rationale, review_json, metadata_json,
				accepted_at, scheduled_at, superseded_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET
				team_id = EXCLUDED.team_id, project_id = EXCLUDED.project_id, decision_id = EXCLUDED.decision_id,
				status = EXCLUDED.status, scope_hash = EXCLUDED.scope_hash,
				allocation_set_id = EXCLUDED.allocation_set_id, work_day_id = EXCLUDED.work_day_id,
				expected_credits = EXCLUDED.expected_credits, high_credits = EXCLUDED.high_credits,
				work_units_json = EXCLUDED.work_units_json, capability_needs_json = EXCLUDED.capability_needs_json,
				environment_needs_json = EXCLUDED.environment_needs_json, reserves_json = EXCLUDED.reserves_json,
				blockers_json = EXCLUDED.blockers_json, priority_rationale = EXCLUDED.priority_rationale,
				review_json = EXCLUDED.review_json, metadata_json = EXCLUDED.metadata_json,
				accepted_at = EXCLUDED.accepted_at, scheduled_at = EXCLUDED.scheduled_at,
				superseded_at = EXCLUDED.superseded_at, updated_at = EXCLUDED.updated_at`,
			[
				plan.id, plan.teamId, plan.projectId, plan.decisionId, status(plan.status), plan.scopeHash,
				plan.allocationSetId ?? null, plan.workDayId ?? null, plan.expectedCredits, plan.highCredits,
				JSON.stringify(plan.workUnits), JSON.stringify(plan.capabilityNeeds), JSON.stringify(plan.environmentNeeds),
				JSON.stringify(plan.reserves), JSON.stringify(plan.blockers), plan.priorityRationale ?? null,
				JSON.stringify(review), JSON.stringify(plan.metadata ?? {}), plan.acceptedAt ?? null,
				plan.scheduledAt ?? null, plan.supersededAt ?? null, plan.createdAt ?? now, now,
			],
		);
		return this.get(plan.id);
	}

	async get(planId: string) {
		await this.database.ensureInitialized();
		return serializeAgentCapacityPlanRow(await this.database.first(`SELECT * FROM agent_capacity_plans WHERE id = ? LIMIT 1`, [planId]));
	}

	async list(decisionId: string, filters: { status?: DurableAgentCapacityPlanStatus | null } = {}) {
		await this.database.ensureInitialized();
		const values: unknown[] = [decisionId];
		const statusClause = filters.status ? ' AND status = ?' : '';
		if (filters.status) values.push(status(filters.status));
		const rows = await this.database.all(
			`SELECT * FROM agent_capacity_plans WHERE decision_id = ?${statusClause} ORDER BY created_at DESC, id DESC LIMIT 200`, values,
		);
		return rows.map((row) => serializeAgentCapacityPlanRow(row) as AgentCapacityPlanRecord);
	}

	async transition(planId: string, nextStatus: DurableAgentCapacityPlanStatus, input: AgentCapacityPlanTransitionInput = {}) {
		const existing = await this.get(planId);
		if (!existing) return null;
		const next = status(nextStatus);
		const now = new Date().toISOString();
		await this.database.run(
			`UPDATE agent_capacity_plans SET
				status = ?, work_day_id = COALESCE(?, work_day_id), allocation_set_id = COALESCE(?, allocation_set_id),
				accepted_at = CASE WHEN ? = 'accepted' THEN COALESCE(accepted_at, ?) ELSE accepted_at END,
				scheduled_at = CASE WHEN ? = 'scheduled' THEN COALESCE(scheduled_at, ?) ELSE scheduled_at END,
				superseded_at = CASE WHEN ? = 'superseded' THEN COALESCE(superseded_at, ?) ELSE superseded_at END,
				review_json = ?, metadata_json = ?, updated_at = ? WHERE id = ?`,
			[
				next, input.workDayId ?? null, input.allocationSetId ?? null,
				next, now, next, now, next, now,
				JSON.stringify({ ...(existing.review ?? {}), ...(input.review ?? {}) }),
				JSON.stringify({ ...(existing.metadata ?? {}), ...(input.metadata ?? {}), statusReason: input.reason ?? null }),
				now, planId,
			],
		);
		return this.get(planId);
	}
}
