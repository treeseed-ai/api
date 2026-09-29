import { appliedWorkdaySchema, assignmentResultSchema, compilePlanningRounds, type AppliedWorkday } from '@treeseed/sdk/agent-capacity';
import type { CapacityGovernanceDatabase } from '../../../../database.ts';
import type { DurableCapacityWorkdayRun } from '../../../../repositories/capacity/workdays/workday-run.ts';
import { workdayParticipants } from '../../../../policy/execution/workday-participants.ts';
import { hasCompleteExecutablePlan, readExactProposal } from '../../../../../governance/executable-proposal.ts';
import { reconcileAssignmentContent } from '../../assignments/lifecycle/assignment-content-readback.ts';
import { runtimeWorkdayPhase } from '../../../build/ready-execution-node.ts';

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
	const sources = { ...record(run.parameters.planningSourceByProposalId) };
	const proposalsByProjectId: Record<string, Row[]> = {};
	const first = plan.planningRounds[0]!;
	const prefix = `planning:${plan.id}:${first.round}:`;
	const initialAgentIds = first.assignmentIds.map((id) => id.slice(prefix.length));
	const planningAgentIds = initialAgentIds.filter((id) => id.endsWith(':planning'));
	const projectIds = Array.isArray(run.parameters.scheduledProjectIds) ? run.parameters.scheduledProjectIds : [];
	for (const projectId of projectIds) {
		if (typeof projectId !== 'string') continue;
		const candidates = await store.all(`SELECT * FROM governance_proposals WHERE team_id=? AND project_id=?
			AND status IN ('draft','submitted','open','voting') ORDER BY id LIMIT 101`, [run.teamId, projectId]);
		if (candidates.length > 100) throw new Error(`planning_proposal_inventory_too_large:${projectId}`);
		proposalsByProjectId[projectId] = [];
		for (const proposal of candidates) {
			try {
				const exact = await readExactProposal(store, proposal);
				const proposalId = String(exact.definition.id);
				sources[proposalId] = exact.ref;
				proposalsByProjectId[projectId].push(exact.definition);
			}
			catch (error) {
				if ((error as { code?: unknown })?.code !== 'proposal_execution_plan_invalid') throw error;
			}
		}
	}
	const proposalsNeedingEstimates = Object.fromEntries(Object.entries(proposalsByProjectId)
		.map(([projectId, proposals]) => [projectId, proposals.filter((proposal) =>
			!hasCompleteExecutablePlan(proposal) && proposal.status !== 'withdrawn')]));
	const estimators = Object.values(proposalsNeedingEstimates).some((proposals) => proposals.length)
		? workdayParticipants({ ...run.parameters, proposalsByProjectId: proposalsNeedingEstimates })
			.filter((participant) => participant.activity === 'estimating' && projectIds.includes(participant.projectId))
			.map((participant) => participant.id) : [];
	return { sources, proposalIds: Object.keys(sources).sort(),
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
	if (!requestClose && next.state === 'active' && await runtimeWorkdayPhase(store, run, now) === 'planning'
		&& next.planningRounds.length && next.planningRounds.every((round) => round.state === 'complete')) {
		const { sources, proposalIds, agentIds } = await nextPlanningParticipants(store, run, next);
		const round = next.planningRounds.at(-1)!.round + 1;
		const turns = compilePlanningRounds(next.id, agentIds, next.policySnapshot.planningTurnMaximumSeconds, round);
		next = { ...next, planningRounds: [...next.planningRounds, { round, state: 'active',
			assignmentIds: turns.map((turn) => turn.id), startedAt: now }] };
		run = { ...run, parameters: { ...run.parameters, planningSourceByProposalId: sources, proposalIds } };
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
		const reservations = await store.all('SELECT state FROM capacity_reservations WHERE team_id=? AND work_day_id=?', [run.teamId, run.id]);
		const reservationsSettled = reservations.every((row) => terminalReservationStates.has(String(row.state)));
		if (reports.length > 0 && reports.every((row) => terminalNodeStates.has(String(row.status)))
			&& reservationsSettled) {
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
