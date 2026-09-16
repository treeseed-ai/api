import { createHash } from 'node:crypto';
import { CapacityGovernanceError } from '../../../../database.ts';
import { decodeDurableJsonObject } from '../../../../durable-json.ts';
import { CapacityWorkdayRunRepository } from '../../../../repositories/capacity/workdays/workday-run.ts';
import { reconcileExecutionGraph } from '../../../../../control-plane/repositories/capacity/execution/execution-graph-service.ts';
import { CapacityWorkdayEventService } from '../content/workday-event-service.ts';
import { advanceLivingWorkday } from '../lifecycle/living-workday-lifecycle.ts';
import { appliedWorkdaySchema, workdayPhase } from '@treeseed/sdk/agent-capacity';
import { OperatorAssignmentService } from '../../assignments/observability/operator-assignment-service.ts';
import { closeTerminalAssignmentWorkspace } from '../../assignments/observability/assignment-terminal-workspace.ts';
import type { WorkdayTreeDxConnectionStore } from '../treedx/workday-treedx-connection.ts';

type WorkdayTickStore = Parameters<typeof advanceLivingWorkday>[0] & WorkdayTreeDxConnectionStore;

export async function tickCapacityWorkdayRun(
	store: WorkdayTickStore,
	teamId: string,
	runId: string,
	now = new Date().toISOString(),
	idempotencyKey?: string,
) {
	const operationKey = idempotencyKey?.trim() || null;
	const eventId = operationKey ? `workday_tick_${createHash('sha256').update(`${teamId}:${runId}:${operationKey}`).digest('base64url').slice(0, 32)}` : null;
	if (eventId) {
		const existing = await store.first(`SELECT context_json FROM capacity_workday_events WHERE id = ? AND team_id = ? AND run_id = ? LIMIT 1`, [eventId, teamId, runId]);
		if (existing) return decodeDurableJsonObject(existing.context_json, { owner: 'capacity workday tick event', ownerId: eventId, column: 'context_json' }).result as Record<string, unknown>;
	}
	const run = await new CapacityWorkdayRunRepository(store).get(teamId, runId);
	if (!run) throw new CapacityGovernanceError('capacity_workday_run_not_found', 'Capacity workday run does not exist.', 404, { runId });
	if (run.status !== 'running' || !run.capacityProviderId) throw new CapacityGovernanceError(
		'capacity_workday_run_not_active', 'Only a running provider-bound workday may be ticked.', 409, { runId, status: run.status },
	);
	const memberships = await store.all(
		`SELECT id FROM capacity_provider_team_memberships WHERE team_id = ? AND capacity_provider_id = ? AND status = 'approved' ORDER BY id ASC LIMIT 2`,
		[teamId, run.capacityProviderId],
	);
	if (memberships.length !== 1) throw new CapacityGovernanceError(
		'capacity_workday_membership_not_approved', 'Workday tick requires one approved provider membership.', 409,
		{ runId, providerId: run.capacityProviderId, matchCount: memberships.length },
	);
	if (workdayPhase(appliedWorkdaySchema.parse(run.parameters.appliedPlan), now) !== 'planning') {
		const turns = await store.all(`SELECT assignment.id FROM capacity_provider_assignments assignment
			JOIN execution_nodes node ON node.team_id=assignment.team_id AND node.id=assignment.execution_node_id
			WHERE node.team_id=? AND node.workday_id=? AND node.kind IN ('planning','estimating')
			AND assignment.status IN ('pending','returned','leased') ORDER BY assignment.id`, [teamId, runId]);
		const cancellation = new OperatorAssignmentService(store, assignment => closeTerminalAssignmentWorkspace(store, assignment));
		for (const turn of turns) await cancellation.cancel(teamId, String(turn.id), {
			idempotencyKey: `planning-boundary:${runId}:${turn.id}`, reason: 'Planning window ended; unused capacity returns to acting and review.',
		});
		await store.run(`UPDATE execution_nodes SET status='cancelled',updated_at=?
			WHERE team_id=? AND workday_id=? AND kind IN ('planning','estimating') AND status IN ('ready','blocked')`, [now, teamId, runId]);
	}
	const lifecycle = await advanceLivingWorkday(store, run, now);
	const executionGraph = await reconcileExecutionGraph(store, teamId, {}, `workday-tick:${runId}:${eventId ?? now}`);
	const result = { runId, tickedAt: now, lifecycle, executionGraph };
	if (eventId) await new CapacityWorkdayEventService(store).create(teamId, runId, {
		id: eventId, eventType: 'workday.tick', status: 'recorded', title: 'Workday execution-graph tick',
		context: { result }, metadata: { idempotencyKey: operationKey }, createdAt: now,
	});
	return result;
}
