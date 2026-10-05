import { allocateWorkdayCapacity, appliedWorkdaySchema, assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import type { createControlPlanePostgresDatabase } from '../../../../../../../src/api/support/control-plane-postgres.ts';
import { buildAssignmentAttempt } from '../../../../../../../src/api/capacity/services/capacity/assignments/planning/execution/assignment-attempt-builder.ts';
import { compileAssignmentTimeBudget } from '../../../../../../../src/api/capacity/services/capacity/assignments/planning/assignment-time-budget.ts';
import { candidate, provider, run, executionCapability } from '../../fixtures/assignment-attempt-fixtures.ts';

/** Use the ordinary allocator and graph records, not a partial attempt snapshot. */
export async function seedPlanningBoundary(db: ReturnType<typeof createControlPlanePostgresDatabase>, now: string, boundary: string) {
	const issuedAt = new Date(Date.parse(boundary) - 31_000).toISOString();
	const startsAt = new Date(Date.parse(boundary) - 1_200_000).toISOString();
	const endsAt = new Date(Date.parse(boundary) + 2_400_000).toISOString();
	const planning = structuredClone(candidate);
	planning.node.kind = 'planning' as never; planning.node.pairRole = null; planning.node.workspace = 'read-only';
	planning.node.estimate = { expectedSeconds: 180, maximumSeconds: 180 };
	planning.node.requestedPermissions = { content: { read: ['proposal'], write: [] }, tools: ['source.read'] } as never;
	planning.effectiveProfile = { ...planning.effectiveProfile, activity: 'planning', handler: 'planner',
		permissionCeiling: planning.node.requestedPermissions } as never;
	const parameters = { scheduledProjectIds: ['project'], appliedPlan: {
		...(run as { parameters: { appliedPlan: Record<string, unknown> } }).parameters.appliedPlan, startsAt, endsAt,
		policySnapshot: { durationSeconds: 3600, planningPercent: 100 / 3, allocationWeight: 1,
			planningTurnMaximumSeconds: 180, maximumConcurrency: 5, communicationConcurrency: 5,
			projectPercentages: { project: 100 }, agentClassPercentages: { project: { engineer: 100 } } },
	} };
	const observation = { ...provider.accountingObservation.modelUsage, day: issuedAt.slice(0, 10), observedAt: issuedAt };
	const plan = appliedWorkdaySchema.parse(parameters.appliedPlan);
	const opportunity = allocateWorkdayCapacity({ now: issuedAt, remainingSeconds: 31,
		workdays: [{ plan, committedSeconds: 0, planningCommittedSeconds: 0, maximumAdditionalSeconds: 31, actingReady: false }] })[plan.id];
	if (!opportunity) throw new Error('Original allocator planning opportunity required');
	const allocated = buildAssignmentAttempt({ candidate: planning as never,
		run: { ...structuredClone(run as Record<string, unknown>), parameters } as never, principal: { teamId: 'team', capacityProviderId: 'provider' } as never,
		allocationInputs: { codex: { measurements: [], constraints: [], opportunity } }, providerSessionId: 'session', attempt: 1, now: issuedAt,
		providers: [{ ...provider, accountingObservation: { modelUsage: observation, capabilityUsage: { [executionCapability]: observation } } }] as never });
	const attempt = assignmentAttemptSchema.parse({ ...allocated.assignment, id: 'assignment', idempotencyKey: 'assignment',
		reservationId: 'reservation', leaseId: 'lease', status: 'leased' });
	const budget = compileAssignmentTimeBudget({ now: issuedAt, requestedSeconds: 31,
		configuredBudget: { deadline: boundary } }).capacityBudget;
	await db.pool.query(`INSERT INTO capacity_workday_runs
		(id,team_id,capacity_provider_id,scenario_id,status,environment,execution_kind,trigger_kind,execution_mode,parameters_json,created_at,updated_at)
		VALUES ('workday','team','provider','profile:default','running','local','workday','manual','simulation',$1,$2,$2)`, [JSON.stringify(parameters), now]);
	await db.pool.query(`INSERT INTO execution_nodes
		(id,team_id,project_id,workday_id,work_item_id,kind,pair_role,source_ref_json,authority_refs_json,rule_revision,node_revision,
		agent_class,status,graph_revision_created,graph_revision_updated,created_at,updated_at,estimate_json,
		required_capabilities_json,requested_permissions_json,workspace,acceptance_criteria_json,maximum_review_cycles)
		VALUES ('approved-actor','team','project','workday',$3,'acting','actor',$1,$4,1,1,'engineer','ready',1,1,$2,$2,$5,$6,$7,'git',$8,2)`,
		[JSON.stringify(candidate.node.sourceRef), now, candidate.node.workItemId, JSON.stringify(candidate.node.authorityRefs),
			JSON.stringify(candidate.node.estimate), JSON.stringify(candidate.node.requiredCapabilities),
			JSON.stringify(candidate.node.requestedPermissions), JSON.stringify(candidate.node.acceptanceCriteria)]);
	await db.pool.query(`UPDATE capacity_provider_assignments SET work_day_id='workday',assignment_attempt_json=$1,
		capacity_envelope_json=$2,execution_provider_id=$3,execution_node_id=$4,execution_node_revision=$5,
		graph_revision=$6,attempt_count=$7,created_at=$8,mode='planning' WHERE id='assignment'`, [JSON.stringify(attempt),
		JSON.stringify({ teamId: 'team', projectId: 'project', workDayId: 'workday', mode: 'planning', projectAgentClassId: 'engineer',
			capacityProviderId: 'provider', executionProviderId: attempt.provider.executionProviderId, reservationId: 'reservation',
			budget: { ...budget, time: { ...budget.time, executionDeadlineAt: boundary } } }),
		attempt.provider.executionProviderId, attempt.nodeId, attempt.nodeRevision, attempt.graphRevision, attempt.attempt, issuedAt]);
}
