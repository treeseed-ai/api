import { createHash } from 'node:crypto';
import { MAX_CAPACITY_PAGE_LIMIT, type CapacityPage } from '@treeseed/sdk/capacity-pagination';
import type { CapacityGovernanceDatabase } from '../database.ts';
import { CapacityGovernanceError } from '../database.ts';
import { CapacityWorkdayDemandRepository } from '../repositories/workday-demand.ts';
import { CapacityWorkdayParticipationRepository } from '../repositories/workday-participation.ts';
import { CapacityWorkdayRunRepository, type DurableCapacityWorkdayRun } from '../repositories/workday-run.ts';
import { listActingDemandSources } from './acting-demand-source.ts';
import type { ProviderLeasePrincipal } from './lease-authority-service.ts';
import { resolvePlanningDemandSource } from './planning-demand-source.ts';
import { capacityWorkdayAgentsFromClasses } from './workday-agent-policy.ts';
import { resolveCapacityWorkdayAssignmentIntent } from './workday-assignment-context-service.ts';
import {
	capacityWorkdayContentRoot,
	capacityWorkdayRepositoryId,
	capacityWorkdayRequestedProjectSlugs,
	resolveCapacityWorkdayProjects,
	type WorkdayProject,
} from './workday-project-policy.ts';

interface DemandCompilerStore extends CapacityGovernanceDatabase {
	listTeamProjects(teamId: string): Promise<WorkdayProject[]>;
	listProjectAgentClassesPage(projectId: string, filters: { limit: number }): Promise<CapacityPage<unknown>>;
}

function id(prefix: string, value: string): string {
	return `${prefix}_${createHash('sha256').update(value).digest('base64url').slice(0, 32)}`;
}
function deadlineOpen(run: DurableCapacityWorkdayRun, now: string): boolean {
	const configured = run.parameters.deadlineAt;
	if (configured === null || configured === undefined || configured === '') return true;
	const parsed = Date.parse(String(configured));
	if (!Number.isFinite(parsed)) throw new CapacityGovernanceError('capacity_workday_synthesis_parameter_invalid', 'Capacity workday deadlineAt is invalid.', 500, { runId: run.id, deadlineAt: configured });
	return parsed > Date.parse(now);
}

async function activeEnvelope(database: CapacityGovernanceDatabase, run: DurableCapacityWorkdayRun, projectId: string) {
	const rows = await database.all(
		`SELECT id FROM workday_capacity_envelopes WHERE team_id = ? AND project_id = ? AND workday_run_id = ? AND status = 'active' ORDER BY id ASC LIMIT 2`,
		[run.teamId, projectId, run.id],
	);
	if (rows.length > 1) throw new CapacityGovernanceError('capacity_workday_envelope_ambiguous', 'A workday run has multiple active envelopes for one project.', 500, { runId: run.id, projectId });
	return rows[0]?.id ? String(rows[0].id) : null;
}

async function compilePlanningDemands(
	store: DemandCompilerStore,
	run: DurableCapacityWorkdayRun,
	project: WorkdayProject,
	workdayId: string,
	now: string,
) {
	const page = await store.listProjectAgentClassesPage(project.id, { limit: MAX_CAPACITY_PAGE_LIMIT });
	if (page.page.hasMore) throw new CapacityGovernanceError('capacity_internal_collection_bound_exceeded', 'Workday agent classes exceed the processing bound.', 409, { projectId: project.id, limit: MAX_CAPACITY_PAGE_LIMIT });
	const agents = capacityWorkdayAgentsFromClasses(page.items);
	if (!agents.length) return 0;
	const participation = new CapacityWorkdayParticipationRepository(store);
	const { cycle, entries } = await participation.ensureOpenCycle({
		teamId: run.teamId, projectId: project.id, workdayRunId: run.id, now,
		agents: agents.map((agent) => ({
			agentId: agent.slug, projectAgentClassId: agent.projectAgentClassId,
			eligible: Boolean(agent.projectAgentClassId && agent.handler),
			reasonCode: agent.projectAgentClassId && agent.handler ? null : 'agent_activity_profile_invalid',
			metadata: { activityType: agent.activityType, handlerId: agent.handler },
		})),
	});
	const demandRepository = new CapacityWorkdayDemandRepository(store);
	let created = 0;
	for (const entry of entries.filter((value) => value.status === 'pending' && !value.demandId)) {
		const agent = agents.find((candidate) => candidate.slug === entry.agentId);
		if (!agent) continue;
		const intent = await resolveCapacityWorkdayAssignmentIntent(store, run, project, agent);
		const source = await resolvePlanningDemandSource(store, run, project, agent, intent);
		const idempotencyKey = `workday:${run.id}:${project.id}:cycle:${cycle.cycleNumber}:agent:${agent.slug}`;
		const demand = await demandRepository.create({
			id: id('demand', idempotencyKey), teamId: run.teamId, projectId: project.id, workdayRunId: run.id, workdayId,
			sourceType: source.sourceType, sourceId: source.sourceId, mode: 'planning',
			projectAgentClassId: agent.projectAgentClassId, agentId: agent.slug, handlerId: agent.handler,
			activityType: agent.activityType, decisionId: source.decisionId, priority: source.priority,
			requestedCredits: source.requestedCredits, idempotencyKey,
			payload: {
				...source.payload, repositoryId: capacityWorkdayRepositoryId(project, run.parameters),
				contentRoot: capacityWorkdayContentRoot(project), cycle: cycle.cycleNumber,
			},
			metadata: { participationCycleId: cycle.id, participationEntryId: entry.id, environment: run.environment }, availableAt: now, now,
		});
		await participation.bindDemand(entry.id, demand.id, now);
		created += 1;
	}
	return created;
}

async function compileActingDemands(
	store: DemandCompilerStore,
	run: DurableCapacityWorkdayRun,
	project: WorkdayProject,
	workdayId: string,
	now: string,
) {
	const repository = new CapacityWorkdayDemandRepository(store);
	let created = 0;
	for (const source of await listActingDemandSources(store, run, project, workdayId)) {
		const idempotencyKey = `workday:${run.id}:capacity-plan:${source.capacityPlanId}:unit:${source.sourceId}`;
		await repository.create({
			id: id('demand', idempotencyKey), teamId: run.teamId, projectId: project.id, workdayRunId: run.id, workdayId,
			sourceType: source.sourceType, sourceId: source.sourceId, mode: 'acting',
			projectAgentClassId: source.projectAgentClassId, agentId: source.agentId, handlerId: source.handlerId,
			activityType: source.activityType, decisionId: source.decisionId, capacityPlanId: source.capacityPlanId,
			priority: source.priority, requestedCredits: source.requestedCredits, idempotencyKey,
			payload: {
				...source.payload, repositoryId: capacityWorkdayRepositoryId(project, run.parameters),
				contentRoot: capacityWorkdayContentRoot(project),
			},
			metadata: { requiredCapabilities: source.requiredCapabilities, environment: run.environment }, availableAt: now, now,
		});
		created += 1;
	}
	return created;
}

export async function compileProviderWorkdayDemand(
	store: DemandCompilerStore,
	principal: ProviderLeasePrincipal,
	now = new Date().toISOString(),
): Promise<{ consideredRuns: number; compiledDemands: number }> {
	await store.ensureInitialized();
	const runs = await new CapacityWorkdayRunRepository(store).listActiveForProvider(principal.teamId, principal.capacityProviderId);
	let compiledDemands = 0;
	for (const run of runs) {
		if (!deadlineOpen(run, now)) continue;
		const projects = resolveCapacityWorkdayProjects(capacityWorkdayRequestedProjectSlugs(run.parameters), await store.listTeamProjects(run.teamId));
		for (const project of projects) {
			const workdayId = await activeEnvelope(store, run, project.id);
			if (!workdayId) continue;
			compiledDemands += await compilePlanningDemands(store, run, project, workdayId, now);
			compiledDemands += await compileActingDemands(store, run, project, workdayId, now);
		}
	}
	return { consideredRuns: runs.length, compiledDemands };
}
