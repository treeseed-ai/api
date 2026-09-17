import { appliedWorkdaySchema, compilePlanningRounds, workdayPhase, type AppliedWorkday } from '@treeseed/sdk/agent-capacity';
import type { CapacityGovernanceDatabase } from '../../../../database.ts';
import type { DurableCapacityWorkdayRun } from '../../../../repositories/capacity/workdays/workday-run.ts';

type Row = Record<string, unknown>;
const terminalNodeStates = new Set(['completed', 'failed', 'cancelled', 'stale']);
const terminalReservationStates = new Set(['consumed', 'released', 'expired', 'failed']);
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function advanceRounds(plan: AppliedWorkday, states: Map<string, string>, now: string): AppliedWorkday {
	const rounds = plan.planningRounds.map((round, index) => {
		const complete = round.assignmentIds.every((id) => terminalNodeStates.has(states.get(id) ?? ''));
		const previousComplete = index === 0 || plan.planningRounds[index - 1]?.state === 'complete'
			|| plan.planningRounds[index - 1]?.assignmentIds.every((id) => terminalNodeStates.has(states.get(id) ?? ''));
		if (complete) return { ...round, state: 'complete' as const,
			startedAt: round.startedAt ?? now, completedAt: round.completedAt ?? now };
		if (plan.state === 'active' && previousComplete) return { ...round, state: 'active' as const, startedAt: round.startedAt ?? now };
		return round;
	});
	return { ...plan, planningRounds: rounds as AppliedWorkday['planningRounds'] };
}

/** Derive lifecycle exclusively from the applied plan, normalized graph, and reservations. */
export async function advanceLivingWorkday(store: CapacityGovernanceDatabase & {
	updateCapacityWorkdayRun(teamId: string, runId: string, input: Row): Promise<DurableCapacityWorkdayRun | null>;
}, run: DurableCapacityWorkdayRun, now: string, requestClose = false) {
	const plan = appliedWorkdaySchema.parse(run.parameters.appliedPlan);
	const nodeRows = await store.all('SELECT id,kind,status FROM execution_nodes WHERE team_id=? AND workday_id=? ORDER BY id',
		[run.teamId, run.id]);
	const states = new Map(nodeRows.map((row) => [String(row.id), String(row.status)]));
	let next = advanceRounds(plan, states, now);
	if (next.state === 'planned') next = { ...next, state: 'active', activatedAt: next.activatedAt ?? now };
	if (!requestClose && next.state === 'active' && workdayPhase(next, now) === 'planning'
		&& next.planningRounds.length && next.planningRounds.every((round) => round.state === 'complete')) {
		const first = next.planningRounds[0]!;
		const prefix = `planning:${next.id}:${first.round}:`;
		const agentIds = first.assignmentIds.map((id) => id.slice(prefix.length));
		const round = next.planningRounds.at(-1)!.round + 1;
		const turns = compilePlanningRounds(next.id, agentIds, next.policySnapshot.planningTurnMaximumSeconds, round);
		next = { ...next, planningRounds: [...next.planningRounds, { round, state: 'active',
			assignmentIds: turns.map((turn) => turn.id), startedAt: now }] };
	}
	if (next.state === 'active' && (requestClose || Date.parse(now) >= Date.parse(next.endsAt))) {
		next = { ...next, state: 'closing', closingAt: next.closingAt ?? now };
	}
	let status = run.status, completedAt = run.completedAt;
	if (requestClose && run.executionKind === 'conversation') {
		// Conversations settle through their durable response, not a Reporter.
		// Explicit stop is cancellation and must not fabricate successful output.
		next = { ...next, state: 'ended', endedAt: next.endedAt ?? now };
		status = 'cancelled'; completedAt = completedAt ?? now;
	}
	if (next.state === 'closing') {
		const reports = nodeRows.filter((row) => row.kind === 'reporting');
		const reservations = await store.all('SELECT state FROM capacity_reservations WHERE team_id=? AND work_day_id=?',
			[run.teamId, run.id]);
		if (reports.length > 0 && reports.every((row) => row.status === 'completed')
			&& reservations.every((row) => terminalReservationStates.has(String(row.state)))) {
			next = { ...next, state: 'ended', endedAt: next.endedAt ?? now };
			status = 'completed'; completedAt = completedAt ?? now;
		}
	}
	if (same(next, plan) && status === run.status) return { changed: false, plan: next, status };
	const updated = await store.updateCapacityWorkdayRun(run.teamId, run.id, {
		status, completedAt, parameters: { ...run.parameters, appliedPlan: next },
	});
	if (!updated) throw new Error('living_workday_update_failed');
	return { changed: true, plan: next, status };
}
