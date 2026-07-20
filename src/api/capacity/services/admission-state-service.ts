import type { CapacityAdmissionInput, CapacityAllocationSetV2, CapacityGrantV2 } from '@treeseed/sdk/agent-capacity/allocation';
import type { CapacityGovernanceDatabase } from '../database.ts';
import { CapacityGovernanceError } from '../database.ts';
import { decodeDurableJsonArray, decodeDurableJsonObject } from '../durable-json.ts';
import { serializeCapacityGrantRow } from '../repositories/grant.ts';
import { serializeCapacityAllocationSetRow } from '../repositories/allocation-set.ts';
import { resolveCapacityAllocationPath } from '../domain/allocation-path.ts';

export interface CapacityAdmissionStateRequest {
	teamId: string;
	providerId: string;
	membershipId: string;
	projectId: string;
	environment: string;
	projectAgentClassId: string;
	mode: 'planning' | 'acting';
	workDayId: string;
	requestedCredits: number;
	executionProviderId?: string | null;
	laneId?: string | null;
	providerSessionId?: string | null;
	decisionId?: string | null;
	requiredCapabilities?: string[];
}

function numeric(...values: unknown[]) {
	for (const value of values) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

async function counterAmount(database: CapacityGovernanceDatabase, id: string) {
	const row = await database.first(`SELECT committed_amount FROM capacity_admission_counters WHERE id = ? LIMIT 1`, [id]);
	return Number(row?.committed_amount ?? 0);
}

export async function loadCapacityAdmissionState(database: CapacityGovernanceDatabase, request: CapacityAdmissionStateRequest): Promise<CapacityAdmissionInput> {
	await database.ensureInitialized();
	const now = new Date().toISOString();
	const [membership, project, agentClass, workday] = await Promise.all([
		database.first(`SELECT * FROM capacity_provider_team_memberships WHERE id = ? AND team_id = ? AND capacity_provider_id = ? LIMIT 1`, [request.membershipId, request.teamId, request.providerId]),
		database.first(`SELECT id FROM projects WHERE id = ? AND team_id = ? LIMIT 1`, [request.projectId, request.teamId]),
		database.first(`SELECT * FROM project_agent_classes WHERE id = ? AND project_id = ? AND team_id = ? LIMIT 1`, [request.projectAgentClassId, request.projectId, request.teamId]),
		database.first(`SELECT * FROM workday_capacity_envelopes WHERE id = ? AND project_id = ? AND team_id = ? LIMIT 1`, [request.workDayId, request.projectId, request.teamId]),
	]);
	if (!membership) throw new CapacityGovernanceError('capacity_membership_not_found', 'Provider membership does not exist for this team.', 404);
	if (!project) throw new CapacityGovernanceError('capacity_project_not_found', 'Project does not exist for this team.', 404);
	if (!agentClass || agentClass.status !== 'active') throw new CapacityGovernanceError('capacity_agent_class_not_active', 'Project agent class is not active.', 409);
	if (!workday) throw new CapacityGovernanceError('capacity_workday_not_found', 'Capacity workday does not exist.', 404);
	const allocationSetId = String(workday.allocation_set_id ?? '');
	const workdayContext = (column: string) => ({ owner: 'workday capacity envelope', ownerId: request.workDayId, column });
	const workdayMetadata = decodeDurableJsonObject(workday.metadata_json, workdayContext('metadata_json'));
	const grantId = typeof workdayMetadata.grantId === 'string' ? workdayMetadata.grantId.trim() : '';
	if (!grantId) throw new CapacityGovernanceError('capacity_workday_grant_missing', 'Capacity workday is missing its governed grant provenance.', 409, { workDayId: request.workDayId });
	const [sessionRow, grantRow, allocationRow] = await Promise.all([
		request.providerSessionId
			? database.first(`SELECT * FROM capacity_provider_availability_sessions WHERE id = ? AND membership_id = ? AND team_id = ? LIMIT 1`, [request.providerSessionId, request.membershipId, request.teamId])
			: database.first(`SELECT * FROM capacity_provider_availability_sessions WHERE membership_id = ? AND team_id = ? AND status = 'open' ORDER BY refreshed_at DESC, updated_at DESC LIMIT 1`, [request.membershipId, request.teamId]),
		database.first(`SELECT * FROM capacity_grants WHERE id = ? AND membership_id = ? AND team_id = ? AND project_id = ? AND environment = ? AND status = 'active' LIMIT 1`, [grantId, request.membershipId, request.teamId, request.projectId, request.environment]),
		allocationSetId ? database.first(`SELECT * FROM capacity_allocation_sets WHERE id = ? AND team_id = ? LIMIT 1`, [allocationSetId, request.teamId]) : database.first(`SELECT * FROM capacity_allocation_sets WHERE team_id = ? AND status = 'active' AND effective_from <= ? AND (effective_until IS NULL OR effective_until > ?) ORDER BY effective_from DESC, version DESC LIMIT 1`, [request.teamId, now, now]),
	]);
	const selectedGrant = grantRow ? serializeCapacityGrantRow(grantRow) : null;
	if (!selectedGrant) throw new CapacityGovernanceError('capacity_workday_grant_invalid', 'Capacity workday grant provenance is not active for this membership, project, and environment.', 409, { workDayId: request.workDayId, grantId });
	const selectedAllocation = serializeCapacityAllocationSetRow(allocationRow);
	const workdayEnvelope = decodeDurableJsonObject(workday.envelope_json, workdayContext('envelope_json'));
	const totalCredits = numeric(workdayEnvelope.totalCredits, workdayEnvelope.availableCredits);
	if (totalCredits == null || totalCredits <= 0) throw new CapacityGovernanceError('capacity_workday_budget_invalid', 'Capacity workday must declare a positive total credit budget.', 409);
	if (!selectedAllocation) throw new CapacityGovernanceError('capacity_allocation_not_found', 'Capacity workday does not reference an available allocation set.', 409, { workDayId: request.workDayId, allocationSetId: allocationSetId || null });
	const allocationSliceIds = resolveCapacityAllocationPath(selectedAllocation, request);
	const dailyKey = selectedGrant ? `grant-daily:${selectedGrant.id}:${now.slice(0, 10)}` : '';
	const monthlyKey = selectedGrant ? `grant-monthly:${selectedGrant.id}:${now.slice(0, 7)}` : '';
	const concurrencyKey = selectedGrant ? `grant-concurrency:${selectedGrant.id}:active` : '';
	const workdayKey = `workday:${request.workDayId}:lifetime`;
	const allSliceIds = selectedAllocation.slices.map((slice) => slice.id);
	const borrowingRuleIds = selectedAllocation.borrowingRules.map((rule) => rule.id);
	const [dailyCredits, monthlyCredits, activeAssignments, workdayCredits, reserveCommittedCredits, ...allocationCounters] = await Promise.all([
		counterAmount(database, dailyKey), counterAmount(database, monthlyKey), counterAmount(database, concurrencyKey), counterAmount(database, workdayKey),
		counterAmount(database, `allocation-reserve:${selectedAllocation.id}:${request.workDayId}`),
		...allSliceIds.map((sliceId) => counterAmount(database, `allocation-slice:${selectedAllocation.id}:${sliceId}:${request.workDayId}`)),
		...borrowingRuleIds.map((ruleId) => counterAmount(database, `allocation-borrow:${selectedAllocation.id}:${ruleId}:${request.workDayId}`)),
	]);
	const sliceCredits = allocationCounters.slice(0, allSliceIds.length);
	const borrowedCredits = allocationCounters.slice(allSliceIds.length);
	const committedCreditsBySlice = Object.fromEntries(allSliceIds.map((sliceId, index) => [sliceId, sliceCredits[index] ?? 0]));
	const committedBorrowedCreditsByRule = Object.fromEntries(borrowingRuleIds.map((ruleId, index) => [ruleId, borrowedCredits[index] ?? 0]));
	const sessionContext = (column: string) => ({ owner: 'provider availability session', ownerId: sessionRow ? String(sessionRow.id ?? '') : null, column });
	const nativeLimits = sessionRow ? decodeDurableJsonObject(sessionRow.native_limits_json, sessionContext('native_limits_json')) : {};
	const providerCapabilities = sessionRow ? decodeDurableJsonArray<string>(sessionRow.capabilities_json, sessionContext('capabilities_json')) : [];
	const runnerPressure = sessionRow ? decodeDurableJsonObject(sessionRow.runner_pressure_json, sessionContext('runner_pressure_json')) : {};
	const constraints = sessionRow ? decodeDurableJsonObject(sessionRow.constraints_json, sessionContext('constraints_json')) : {};
	const maxConcurrent = numeric(runnerPressure.maxConcurrentRunners, nativeLimits.maxConcurrentRunners) ?? 0;
	const activeRunners = numeric(runnerPressure.activeRunners, runnerPressure.activeAssignments) ?? 0;
	const availableCredits = numeric(nativeLimits.availableCredits, nativeLimits.creditLimit) ?? 0;
	const localMaxConcurrent = numeric(constraints.maxConcurrentRunners, maxConcurrent) ?? 0;
	const localActive = numeric(constraints.activeRunners, activeRunners) ?? 0;
	const localCredits = numeric(constraints.availableCredits, availableCredits) ?? 0;
	let acting: CapacityAdmissionInput['acting'];
	if (request.mode === 'acting') {
		const [readiness, capacityPlan] = request.decisionId ? await Promise.all([
			database.first(`SELECT * FROM decision_planning_statuses WHERE decision_id = ? AND project_id = ? LIMIT 1`, [request.decisionId, request.projectId]),
			database.first(`SELECT * FROM agent_capacity_plans WHERE decision_id = ? AND project_id = ? AND status IN ('accepted','scheduled','active') ORDER BY created_at DESC LIMIT 1`, [request.decisionId, request.projectId]),
		]) : [null, null];
		acting = { decisionApproved: readiness?.human_approval_state === 'approved', readinessReady: readiness?.execution_readiness === 'ready' && readiness?.planning_inputs_status === 'complete', capacityPlanAccepted: Boolean(capacityPlan) };
	}
	return {
		now,
		request: { teamId: request.teamId, providerId: request.providerId, membershipId: request.membershipId, projectId: request.projectId, environment: request.environment, agentClassId: request.projectAgentClassId, mode: request.mode, executionProviderId: request.executionProviderId ?? null, laneId: request.laneId ?? null, requiredCapabilities: [...new Set([...decodeDurableJsonArray<string>(agentClass.required_capabilities_json, { owner: 'project agent class', ownerId: request.projectAgentClassId, column: 'required_capabilities_json' }), ...(request.requiredCapabilities ?? [])])], requestedCredits: request.requestedCredits },
		membership: { id: String(membership.id), teamId: String(membership.team_id), providerId: String(membership.capacity_provider_id), status: String(membership.status) as CapacityAdmissionInput['membership']['status'] },
		availability: { status: String(sessionRow?.status ?? 'closed') as CapacityAdmissionInput['availability']['status'], availableFrom: String(sessionRow?.available_from ?? sessionRow?.opened_at ?? now), availableUntil: sessionRow?.available_until || sessionRow?.expires_at ? String(sessionRow.available_until ?? sessionRow.expires_at) : null },
		grant: selectedGrant,
		workday: { id: request.workDayId, status: String(workday.status) as CapacityAdmissionInput['workday']['status'], totalCredits, committedCredits: workdayCredits },
		allocationSet: selectedAllocation,
		allocationSliceIds,
		committedCreditsBySlice,
		committedBorrowedCreditsByRule,
		reserveCommittedCredits,
		approvedBorrowingRuleIds: Array.isArray(workdayMetadata.approvedBorrowingRuleIds) ? workdayMetadata.approvedBorrowingRuleIds.map(String) : [],
		providerCapacity: { availableCredits, availableConcurrentAssignments: Math.max(0, maxConcurrent - activeRunners), capabilities: providerCapabilities },
		providerLocalLimits: { availableCredits: localCredits, availableConcurrentAssignments: Math.max(0, localMaxConcurrent - localActive) },
		grantCommitted: { dailyCredits, monthlyCredits, activeAssignments },
		acting,
	};
}
