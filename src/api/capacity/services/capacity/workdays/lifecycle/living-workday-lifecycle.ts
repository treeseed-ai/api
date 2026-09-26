import { appliedWorkdaySchema, assignmentResultSchema, compilePlanningRounds, workdayPhase, type AppliedWorkday } from '@treeseed/sdk/agent-capacity';
import type { CapacityGovernanceDatabase } from '../../../../database.ts';
import type { DurableCapacityWorkdayRun } from '../../../../repositories/capacity/workdays/workday-run.ts';
import { workdayParticipants } from '../../../../policy/execution/workday-participants.ts';
import { hasCompleteExecutablePlan, readExactProposal } from '../../../../../governance/executable-proposal.ts';
import { reconcileAssignmentContent } from '../../assignments/lifecycle/assignment-content-readback.ts';

type Row = Record<string, unknown>;
const terminalNodeStates = new Set(['completed', 'failed', 'cancelled', 'stale']);
const terminalReservationStates = new Set(['consumed', 'released', 'expired', 'failed']);
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};

async function completedReportRefs(store: CapacityGovernanceDatabase, run: DurableCapacityWorkdayRun, reports: Row[]): Promise<Row | null> {
	if (reports.length !== 1 || reports[0]!.status !== 'completed') return null;
	const rows = await store.all(`SELECT id,assignment_result_json FROM capacity_provider_assignments
		WHERE team_id=? AND work_day_id=? AND execution_node_id=? AND status='completed'
		ORDER BY completed_at DESC,id DESC`, [run.teamId, run.id, reports[0]!.id]);
	if (rows.length !== 1) return null;
	let value: unknown = rows[0]!.assignment_result_json;
	if (typeof value === 'string') try { value = JSON.parse(value); } catch { return null; }
	const parsed = assignmentResultSchema.safeParse(value);
	if (!parsed.success || parsed.data.status !== 'completed' || parsed.data.assignmentId !== rows[0]!.id) return null;
	const references = parsed.data.references;
	if (references.length !== 1 || references[0]!.kind !== 'treedx') return null;
	return { [String(reports[0]!.id)]: references[0] };
}

async function nextPlanningParticipants(store: CapacityGovernanceDatabase, run: DurableCapacityWorkdayRun, plan: AppliedWorkday) {
	const sources = { ...record(run.parameters.planningSourceByProjectId) };
	const proposalsByProjectId: Record<string, Row> = {};
	const first = plan.planningRounds[0]!;
	const prefix = `planning:${plan.id}:${first.round}:`;
	const initialAgentIds = first.assignmentIds.map((id) => id.slice(prefix.length));
	const planningAgentIds = initialAgentIds.filter((id) => id.endsWith(':planning'));
	const projectIds = Array.isArray(run.parameters.scheduledProjectIds) ? run.parameters.scheduledProjectIds : [];
	for (const projectId of projectIds) {
		if (typeof projectId !== 'string') continue;
		const existing = record(sources[projectId]);
		if (typeof existing.id === 'string') {
			const proposal = await store.getGovernanceProposal(existing.id);
			if (!proposal) throw new Error(`planning_proposal_missing:${projectId}`);
			// The persisted source is the exact authority for the round that just
			// finished. Successive rounds must advance to the proposal's newly
			// committed exact ref so completed estimates are not regenerated from
			// the original draft.
			const current = await readExactProposal(store, proposal);
			sources[projectId] = current.ref;
			proposalsByProjectId[projectId] = current.definition;
			continue;
		}
		const candidates = await store.all(`SELECT * FROM governance_proposals WHERE team_id=? AND project_id=?
			AND status IN ('draft','submitted','open','voting') ORDER BY id LIMIT 101`, [run.teamId, projectId]);
		if (candidates.length > 100) throw new Error(`planning_proposal_inventory_too_large:${projectId}`);
		const executable: Array<Awaited<ReturnType<typeof readExactProposal>>> = [];
		for (const proposal of candidates) {
			try { executable.push(await readExactProposal(store, proposal)); }
			catch (error) {
				if ((error as { code?: unknown })?.code !== 'proposal_execution_plan_invalid') throw error;
			}
		}
		if (executable.length > 1) throw new Error(`planning_proposal_ambiguous:${projectId}`);
		const exact = executable[0];
		if (!exact) continue;
		sources[projectId] = exact.ref;
		proposalsByProjectId[projectId] = exact.definition;
	}
	const proposalsNeedingEstimates = Object.fromEntries(Object.entries(proposalsByProjectId)
		.filter(([, proposal]) => !hasCompleteExecutablePlan(proposal) && proposal.status !== 'withdrawn'));
	const estimators = Object.keys(proposalsNeedingEstimates).length
		? workdayParticipants({ ...run.parameters, proposalsByProjectId: proposalsNeedingEstimates })
			.filter((participant) => participant.activity === 'estimating' && projectIds.includes(participant.projectId))
			.map((participant) => participant.id) : [];
	const proposalsReady = Object.keys(proposalsByProjectId).length > 0
		&& Object.values(proposalsByProjectId).every((proposal) => hasCompleteExecutablePlan(proposal)
			|| proposal.status === 'withdrawn');
	return { sources, proposalsReady,
		agentIds: [...new Set([...(planningAgentIds.length ? planningAgentIds : initialAgentIds), ...estimators])].sort() };
}

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
	await reconcileAssignmentContent(store, run.teamId, run.id);
	const nodeRows = await store.all('SELECT id,kind,status FROM execution_nodes WHERE team_id=? AND workday_id=? ORDER BY id',
		[run.teamId, run.id]);
	const states = new Map(nodeRows.map((row) => [String(row.id), String(row.status)]));
	let next = advanceRounds(plan, states, now);
	if (next.state === 'planned') next = { ...next, state: 'active', activatedAt: next.activatedAt ?? now };
	if (!requestClose && next.state === 'active' && workdayPhase(next, now) === 'planning'
		&& next.planningRounds.length && next.planningRounds.every((round) => round.state === 'complete')) {
		const { sources, proposalsReady, agentIds } = await nextPlanningParticipants(store, run, next);
		// Two complete cycles prove that every participant saw and could respond to the
		// first round. Once selected proposals are content-ready, governance review is
		// the next graph work; opening more planning rounds would compete with that gate.
		if (next.planningRounds.length < 2 || !proposalsReady) {
			const round = next.planningRounds.at(-1)!.round + 1;
			const turns = compilePlanningRounds(next.id, agentIds, next.policySnapshot.planningTurnMaximumSeconds, round);
			next = { ...next, planningRounds: [...next.planningRounds, { round, state: 'active',
				assignmentIds: turns.map((turn) => turn.id), startedAt: now }] };
		}
		run = { ...run, parameters: { ...run.parameters, planningSourceByProjectId: sources } };
	}
	if (next.state === 'active' && (requestClose || Date.parse(now) >= Date.parse(next.endsAt))) {
		next = { ...next, state: 'closing', closingAt: next.closingAt ?? now };
	}
	let status = run.status, completedAt = run.completedAt;
	let reportRefs = run.reportRefs;
	if (requestClose && run.executionKind === 'conversation') {
		// Conversations settle through their durable response, not a Reporter.
		// Explicit stop is cancellation and must not fabricate successful output.
		next = { ...next, state: 'ended', endedAt: next.endedAt ?? now };
		status = 'cancelled'; completedAt = completedAt ?? now;
	}
	if (next.state === 'closing') {
		const reports = nodeRows.filter((row) => row.kind === 'reporting');
		const [reservations, completionPredecessors] = await Promise.all([
			store.all('SELECT state FROM capacity_reservations WHERE team_id=? AND work_day_id=?', [run.teamId, run.id]),
			store.all(`SELECT predecessor.status FROM execution_nodes condition
				JOIN execution_edges edge ON edge.team_id=condition.team_id AND edge.to_node_id=condition.id
					AND edge.graph_revision_removed IS NULL
				JOIN execution_nodes predecessor ON predecessor.team_id=edge.team_id AND predecessor.id=edge.from_node_id
				WHERE condition.team_id=? AND condition.workday_id=? AND condition.kind='condition'`, [run.teamId, run.id]),
		]);
		const reservationsSettled = reservations.every((row) => terminalReservationStates.has(String(row.state)));
		const completionIncomplete = completionPredecessors.some((row) => String(row.status) !== 'completed');
		if (completionIncomplete && reservationsSettled) {
			next = { ...next, state: 'ended', endedAt: next.endedAt ?? now };
			status = 'failed'; completedAt = completedAt ?? now;
		}
		if (reports.length > 0 && reports.every((row) => terminalNodeStates.has(String(row.status)))
			&& reservationsSettled && !completionIncomplete) {
			next = { ...next, state: 'ended', endedAt: next.endedAt ?? now };
			const references = await completedReportRefs(store, run, reports);
			status = references ? 'completed' : 'failed';
			if (references) reportRefs = references;
			completedAt = completedAt ?? now;
		}
	}
	if (same(next, plan) && status === run.status && same(reportRefs, run.reportRefs)) return { changed: false, plan: next, status };
	const updated = await store.updateCapacityWorkdayRun(run.teamId, run.id, {
		status, completedAt, reportRefs, parameters: { ...run.parameters, appliedPlan: next },
	});
	if (!updated) throw new Error('living_workday_update_failed');
	return { changed: true, plan: next, status };
}
