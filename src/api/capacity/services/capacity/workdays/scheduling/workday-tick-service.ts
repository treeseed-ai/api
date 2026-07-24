import type { CapacityGovernanceDatabase } from '../../../../database.ts';
import { CapacityGovernanceError } from '../../../../database.ts';
import { CapacityWorkdayRunRepository } from '../../../../repositories/capacity/workdays/workday-run.ts';
import { compileProviderWorkdayDemand } from '../../../build/demand-compiler.ts';
import { evaluateDurableWorkdayContinuation } from '../lifecycle/workday-continuation-service.ts';
import type { CapacityPage } from '@treeseed/sdk/capacity-pagination';
import type { WorkdayProject } from '../policy/workday-project-policy.ts';
import { createHash } from 'node:crypto';
import { decodeDurableJsonObject } from '../../../../durable-json.ts';
import { CapacityWorkdayEventService } from '../content/workday-event-service.ts';
import {
	promoteEngineeringWorkflows,
	type EngineeringWorkflowPromotionStore,
} from '../../../operations/engineering-workflow-promotion-service.ts';

interface WorkdayTickStore extends CapacityGovernanceDatabase, EngineeringWorkflowPromotionStore {
	listTeamProjects(teamId: string): Promise<WorkdayProject[]>;
	listProjectAgentClassesPage(projectId: string, filters: { limit: number }): Promise<CapacityPage<unknown>>;
}

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
	const engineeringWorkflowPromotions = await promoteEngineeringWorkflows(store, run);
	const compilation = await compileProviderWorkdayDemand(store, {
		teamId, capacityProviderId: run.capacityProviderId, membershipId: String(memberships[0]!.id),
	}, now);
	const envelopes = await store.all(`SELECT id FROM workday_capacity_envelopes WHERE team_id = ? AND workday_run_id = ? ORDER BY id ASC`, [teamId, runId]);
	const continuation = [];
	for (const row of envelopes) {
		const workdayId = String(row.id);
		const useful = await store.first(`SELECT id FROM capacity_workday_demands WHERE workday_id = ? AND status IN ('pending','claimed') LIMIT 1`, [workdayId]);
		continuation.push({ workdayId, ...await evaluateDurableWorkdayContinuation(store, {
			teamId, workdayRunId: runId, workdayId, usefulEligibleWork: Boolean(useful), now,
		}) });
	}
	const result = { runId, tickedAt: now, engineeringWorkflowPromotions, compilation, continuation };
	if (eventId) await new CapacityWorkdayEventService(store).create(teamId, runId, {
		id: eventId, eventType: 'workday.tick', status: 'recorded', title: 'Workday demand compilation tick',
		context: { result }, metadata: { idempotencyKey: operationKey }, createdAt: now,
	});
	return result;
}
