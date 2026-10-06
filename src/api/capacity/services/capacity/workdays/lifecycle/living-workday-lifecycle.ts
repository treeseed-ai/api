import { appliedWorkdaySchema, assignmentResultSchema, compilePlanningRounds, workdayPlanningEndsAt, type AppliedWorkday, type AssignmentResult } from '@treeseed/sdk/agent-capacity';
import type { CapacityGovernanceDatabase } from '../../../../database.ts';
import type { DurableCapacityWorkdayRun } from '../../../../repositories/capacity/workdays/workday-run.ts';
import { workdayParticipants } from '../../../../policy/execution/workday-participants.ts';
import { hasCompleteExecutablePlan, readExactProposal } from '../../../../../governance/executable-proposal.ts';
import { reconcileAssignmentContent } from '../../assignments/lifecycle/assignment-content-readback.ts';
import { runtimeWorkdayPhase } from '../../../build/ready-execution-node.ts';
import { CapacityGovernanceError } from '../../../../database.ts';

type Row = Record<string, unknown>;
const terminalNodeStates = new Set(['completed', 'failed', 'cancelled', 'stale']);
const terminalReservationStates = new Set(['consumed', 'released', 'expired', 'failed']);
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};

async function completedReportRef(store: CapacityGovernanceDatabase, run: DurableCapacityWorkdayRun, reports: Row[], now: string): Promise<Extract<AssignmentResult['references'][number], { kind: 'treedx' }> | null> {
	if (reports.length !== 1 || reports[0]!.status !== 'completed') return null;
	const rows = await store.all(`SELECT id,assignment_result_json FROM capacity_provider_assignments
		WHERE team_id=? AND work_day_id=? AND execution_node_id=? AND status='completed'
		ORDER BY completed_at DESC,id DESC`, [run.teamId, run.id, reports[0]!.id]);
	if (rows.length !== 1) return null;
	let value: unknown = rows[0]!.assignment_result_json;
	if (typeof value === 'string') try { value = JSON.parse(value); } catch { return null; }
	const parsed = assignmentResultSchema.safeParse(value);
	if (!parsed.success || parsed.data.status !== 'completed' || parsed.data.assignmentId !== rows[0]!.id
		|| !Number.isFinite(Date.parse(now)) || Date.parse(parsed.data.completedAt) > Date.parse(now)) return null;
	const references = parsed.data.references;
	if (references.length !== 1 || references[0]!.kind !== 'treedx') return null;
	return references[0]!;
}

async function nextPlanningParticipants(store: CapacityGovernanceDatabase, run: DurableCapacityWorkdayRun, plan: AppliedWorkday) {
	const selectedProposalIds = [...new Set(Array.isArray(run.parameters.proposalIds)
		? run.parameters.proposalIds.filter((id): id is string => typeof id === 'string' && Boolean(id)) : [])];
	const decisionIds = [...new Set(Array.isArray(run.parameters.decisionIds)
		? run.parameters.decisionIds.filter((id): id is string => typeof id === 'string' && Boolean(id)) : [])];
	const decisions = decisionIds.length ? await store.all(`SELECT id,proposal_id FROM governance_decisions
		WHERE team_id=? AND id IN (${decisionIds.map(() => '?').join(',')})`, [run.teamId, ...decisionIds]) : [];
	if (decisions.length !== decisionIds.length || decisions.some(decision => !decision.proposal_id)) {
		throw new CapacityGovernanceError('workday_planning_decision_scope_invalid',
			'Every selected decision must resolve to a proposal in this team.', 409);
	}
	// Derive scope from the existing decision records, never widen an explicit
	// decision-only workday into autonomous discovery or copy another authority.
	const scopedProposalIds = [...new Set([...selectedProposalIds, ...decisions.map(decision => String(decision.proposal_id))])];
	const selected = new Set(scopedProposalIds);
	const sources = Object.fromEntries(Object.entries(record(run.parameters.planningSourceByProposalId))
		.filter(([id]) => !selected.size || selected.has(id)));
	const proposalsByProjectId: Record<string, Row[]> = {};
	let hasPlanningProposals = false;
	const first = plan.planningRounds[0]!;
	const prefix = `planning:${plan.id}:${first.round}:`;
	const initialAgentIds = first.assignmentIds.map((id) => id.slice(prefix.length));
	const planningAgentIds = initialAgentIds.filter((id) => id.endsWith(':planning'));
	const projectIds = Array.isArray(run.parameters.scheduledProjectIds) ? run.parameters.scheduledProjectIds : [];
	for (const projectId of projectIds) {
		if (typeof projectId !== 'string') continue;
		const candidates = await store.all(`SELECT * FROM governance_proposals WHERE team_id=? AND project_id=?
			AND status IN ('draft','submitted','open','voting')
			${selected.size ? `AND id IN (${scopedProposalIds.map(() => '?').join(',')})` : ''}
			ORDER BY id LIMIT 101`, [run.teamId, projectId, ...scopedProposalIds]);
		if (candidates.length > 100) throw new Error(`planning_proposal_inventory_too_large:${projectId}`);
		hasPlanningProposals ||= candidates.length > 0;
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
	return { sources, proposalIds: selectedProposalIds.sort(),
		// Terminal explicit scope is not autonomous proposal discovery. Keep the
		// initial phase window, but do not repeat already-decided planning work.
		agentIds: selected.size && !hasPlanningProposals ? []
			: [...new Set([...(planningAgentIds.length ? planningAgentIds : initialAgentIds), ...estimators])].sort() };
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
	// Do not create another full planning turn in the tail of its authority.
	// After the initial phase, fluid planning uses the unchanged workday end.
	const planningEnd = Date.parse(workdayPlanningEndsAt(next));
	const planningWindowEnd = Date.parse(now) < planningEnd ? planningEnd : Date.parse(next.endsAt);
	if (!requestClose && next.state === 'active' && await runtimeWorkdayPhase(store, run, now) === 'planning'
		&& planningWindowEnd - Date.parse(now) >= next.policySnapshot.planningTurnMaximumSeconds * 1_000
		&& next.planningRounds.length && next.planningRounds.every((round) => round.state === 'complete')) {
		const { sources, proposalIds, agentIds } = await nextPlanningParticipants(store, run, next);
		if (agentIds.length) {
			const round = next.planningRounds.at(-1)!.round + 1;
			const turns = compilePlanningRounds(next.id, agentIds, next.policySnapshot.planningTurnMaximumSeconds, round);
			next = { ...next, planningRounds: [...next.planningRounds, { round, state: 'active',
				assignmentIds: turns.map((turn) => turn.id), startedAt: now }] };
		}
		run = { ...run, parameters: { ...run.parameters, planningSourceByProposalId: sources, proposalIds } };
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
		const reservations = await store.all('SELECT state FROM capacity_reservations WHERE team_id=? AND work_day_id=?', [run.teamId, run.id]);
		const reservationsSettled = reservations.every((row) => terminalReservationStates.has(String(row.state)));
		if (reports.length > 0 && reports.every((row) => terminalNodeStates.has(String(row.status)))
			&& reservationsSettled) {
			const reference = await completedReportRef(store, run, reports, now);
			status = reference ? 'completed' : 'failed';
			if (reference) next = { ...next, state: 'ended', endedAt: next.endedAt ?? now, reportRef: reference };
			completedAt = completedAt ?? now;
		}
	}
	if (same(next, plan) && status === run.status) return { changed: false, plan: next, status };
	const updated = await store.updateCapacityWorkdayRun(run.teamId, run.id, {
		status, completedAt, parameters: { ...run.parameters, appliedPlan: next },
	});
	if (!updated) throw new Error('living_workday_update_failed');
	return { changed: true, plan: next, status };
}
