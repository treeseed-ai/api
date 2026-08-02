import { MAX_CAPACITY_PAGE_LIMIT,type CapacityPage } from '@treeseed/sdk/capacity-pagination';
import { workdayAgentSelectionActive, normalizeWorkdayAgentSelection } from '@treeseed/sdk/agent-capacity';
import { createHash } from 'node:crypto';
import type { CapacityGovernanceDatabase } from '../../database.ts';
import { CapacityGovernanceError } from '../../database.ts';
import { CapacityWorkdayDemandRepository } from '../../repositories/capacity/workdays/workday-demand.ts';
import { CapacityWorkdayParticipationRepository } from '../../repositories/capacity/workdays/workday-participation.ts';
import { CapacityWorkdayRunRepository,type DurableCapacityWorkdayRun } from '../../repositories/capacity/workdays/workday-run.ts';
import type { ProviderLeasePrincipal } from '../accounts/lease-authority-service.ts';
import { resolveCapacityWorkdayAssignmentIntent } from '../capacity/workdays/assignments/workday-assignment-context-service.ts';
import { capacityWorkdayAgentsFromClasses } from '../capacity/workdays/policy/workday-agent-policy.ts';
import {
capacityWorkdayContentRoot,
capacityWorkdayRepositoryId,
capacityWorkdayRequestedProjectSlugs,
resolveCapacityWorkdayProjects,
type WorkdayProject,
} from '../capacity/workdays/policy/workday-project-policy.ts';
import { listActingDemandSources } from '../support/acting-demand-source.ts';
import { resolvePlanningDemandSource } from '../support/planning-demand-source.ts';

interface DemandCompilerStore extends CapacityGovernanceDatabase {
	listTeamProjects(teamId: string): Promise<WorkdayProject[]>;
	listProjectAgentClassesPage(projectId: string, filters: { limit: number }): Promise<CapacityPage<unknown>>;
}

function id(prefix: string, value: string): string {
	return `${prefix}_${createHash('sha256').update(value).digest('base64url').slice(0, 32)}`;
}
function text(value: unknown): string {
	return typeof value === 'string' && value.trim() ? value.trim() : '';
}
function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function capacityWorkdayContentBaseRef(environment: string, branchPolicy: Record<string, unknown>): string {
	if (environment === 'local') return 'refs/heads/main';
	const base = text(branchPolicy.base);
	if (!base) return 'refs/heads/main';
	return base.startsWith('refs/') || /^[0-9a-f]{40}$/iu.test(base) ? base : `refs/heads/${base}`;
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
	const selectionSnapshot = record(record(run.parameters.resolvedAgentSelectionByProject)[project.id]);
	const pinnedAgents = Array.isArray(selectionSnapshot.agents) ? selectionSnapshot.agents.map(record) : [];
	const selection = pinnedAgents.length > 0 ? normalizeWorkdayAgentSelection({
		classIds: pinnedAgents.map((agent) => text(agent.agentClassId)).filter(Boolean),
		agentSlugs: pinnedAgents.map((agent) => text(agent.agentSlug)).filter(Boolean),
		mode: 'intersection',
	}) : normalizeWorkdayAgentSelection(run.parameters.agentSelection);
	const agents = capacityWorkdayAgentsFromClasses(page.items, selection);
	if (!agents.length && workdayAgentSelectionActive(selection)) {
		throw new CapacityGovernanceError('capacity_workday_agent_selection_empty', 'Workday agent selection resolved no eligible agents.', 409, { runId: run.id, projectId: project.id, selection });
	}
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
				contentRoot: capacityWorkdayContentRoot(project), agentContentPath: agent.contentPath,
				contentBaseRef: capacityWorkdayContentBaseRef(run.environment, agent.branchPolicy),
				contentBranchPolicy: agent.branchPolicy,
				contentAccess: agent.contentAccess,
				cycle: cycle.cycleNumber,
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
