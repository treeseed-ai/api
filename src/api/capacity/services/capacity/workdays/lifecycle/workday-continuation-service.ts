import { evaluateWorkdayContinuation } from '@treeseed/sdk/agent-capacity';
import { decodeDurableJsonObject } from '../../../../durable-json.ts';
import type { CapacityGovernanceDatabase } from '../../../../database.ts';
import { CapacityGovernanceError } from '../../../../database.ts';

export interface DurableWorkdayContinuationDecision {
	continue: boolean;
	reason: 'workday_not_active' | 'duration_bound_reached' | 'budget_bound_reached' | 'no_useful_eligible_work' | 'within_duration_and_budget';
	totalCredits: number;
	committedCredits: number;
}

export async function evaluateDurableWorkdayContinuation(
	database: CapacityGovernanceDatabase,
	input: { teamId: string; workdayRunId: string; workdayId: string; usefulEligibleWork: boolean; now: string },
): Promise<DurableWorkdayContinuationDecision> {
	await database.ensureInitialized();
	const row = await database.first(
		`SELECT run.status AS run_status, run.parameters_json, workday.status AS workday_status, workday.envelope_json
		 FROM capacity_workday_runs run JOIN workday_capacity_envelopes workday ON workday.workday_run_id = run.id AND workday.team_id = run.team_id
		 WHERE run.id = ? AND run.team_id = ? AND workday.id = ? LIMIT 1`,
		[input.workdayRunId, input.teamId, input.workdayId],
	);
	if (!row) throw new CapacityGovernanceError('capacity_workday_continuation_state_missing', 'Workday continuation state is missing.', 409, input);
	const parameters = decodeDurableJsonObject(row.parameters_json, { owner: 'capacity workday run', ownerId: input.workdayRunId, column: 'parameters_json' });
	const envelope = decodeDurableJsonObject(row.envelope_json, { owner: 'workday capacity envelope', ownerId: input.workdayId, column: 'envelope_json' });
	const totalCredits = Number(envelope.availableCredits ?? parameters.availableCredits ?? parameters.creditBudget);
	if (!Number.isFinite(totalCredits) || totalCredits < 0) throw new CapacityGovernanceError(
		'capacity_workday_credit_budget_invalid', 'Workday continuation requires a non-negative finite credit budget.', 500,
		{ workdayId: input.workdayId, value: envelope.availableCredits ?? parameters.availableCredits ?? parameters.creditBudget ?? null },
	);
	const totals = await database.first<{ committed_credits?: unknown }>(
		`SELECT COALESCE(SUM(CASE WHEN state IN ('reserved','consuming') THEN reserved_credits ELSE consumed_credits END), 0) AS committed_credits
		 FROM capacity_reservations WHERE team_id = ? AND work_day_id = ?`, [input.teamId, input.workdayId],
	);
	const committedCredits = Number(totals?.committed_credits ?? 0);
	if (!Number.isFinite(committedCredits) || committedCredits < 0) throw new CapacityGovernanceError('capacity_workday_committed_budget_invalid', 'Workday committed credits are invalid.', 500, { workdayId: input.workdayId });
	const status = row.run_status === 'running' && row.workday_status === 'active' ? 'active' : String(row.workday_status ?? row.run_status ?? '');
	const decision = evaluateWorkdayContinuation({
		status, now: input.now, deadlineAt: typeof parameters.deadlineAt === 'string' ? parameters.deadlineAt : null,
		totalCredits, committedCredits, usefulEligibleWork: input.usefulEligibleWork,
	});
	return { ...decision, totalCredits, committedCredits };
}
