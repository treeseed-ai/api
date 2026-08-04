import { MAX_CAPACITY_PAGE_LIMIT,type CapacityPage } from '@treeseed/sdk/capacity-pagination';
import { workdayAgentSelectionActive, normalizeWorkdayAgentSelection } from '@treeseed/sdk/agent-capacity';
import { createHash } from 'node:crypto';
import type { CapacityGovernanceDatabase } from '../../database.ts';
import { CapacityGovernanceError } from '../../database.ts';
import { CapacityWorkdayDemandRepository } from '../../repositories/capacity/workdays/workday-demand.ts';
import { CapacityWorkdayParticipationRepository } from '../../repositories/capacity/workdays/workday-participation.ts';
import { CapacityWorkdayRunRepository,type DurableCapacityWorkdayRun } from '../../repositories/capacity/workdays/workday-run.ts';
import type { ProviderLeasePrincipal } from '../accounts/lease-authority-service.ts';
import { listCapacityWorkdayProducedArtifactKinds,listCapacityWorkdaySignalCodes,resolveCapacityWorkdayAssignmentIntent } from '../capacity/workdays/assignments/workday-assignment-context-service.ts';
import { capacityWorkdayAgentsFromClasses,capacityWorkdayPlanningStage,capacityWorkdayRequiredArtifacts,capacityWorkdayRequiredSignals,type CapacityWorkdayPlanningStage } from '../capacity/workdays/policy/workday-agent-policy.ts';
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
const PROFILE_ORDER = ['planning', 'estimating', 'reviewing', 'reporting'];
const PLANNING_STAGE_ORDER: CapacityWorkdayPlanningStage[] = ['discovery', 'synthesis', 'evaluation', 'closeout'];
export function workdayProfileStageReady(activityType: string, configured: string[], completed: string[]) {
	const position = PROFILE_ORDER.indexOf(activityType);
	if (position < 1) return true;
	const prior = [...configured].filter((profile) => PROFILE_ORDER.indexOf(profile) < position).sort((left, right) => PROFILE_ORDER.indexOf(right) - PROFILE_ORDER.indexOf(left))[0];
	return !prior || completed.includes(prior);
}
export function workdayPlanningStageReady(stage: CapacityWorkdayPlanningStage, entries: Array<{ status: string; metadata: unknown }>) {
	const position = PLANNING_STAGE_ORDER.indexOf(stage);
	if (position < 1) return true;
	return entries.filter((entry) => {
		const candidate = PLANNING_STAGE_ORDER.indexOf(text(record(entry.metadata).planningStage) as CapacityWorkdayPlanningStage);
		return candidate >= 0 && candidate < position;
	}).every((entry) => entry.status === 'completed');
}
export function workdayReportingStageReady(activityType: string, entries: Array<{ status: string; metadata: unknown }>, actingActive: boolean) {
	if (activityType !== 'reporting') return true;
	const otherProfilesComplete = entries
		.filter((entry) => text(record(entry.metadata).activityType) !== 'reporting')
		.every((entry) => entry.status === 'completed');
	return otherProfilesComplete && !actingActive;
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

async function completedEquivalentPlanningDemand(
	store: CapacityGovernanceDatabase,
	input: { runId: string; projectId: string; agentId: string; activityType: string; sourceType: string; sourceId: string },
) {
	return Boolean(await store.first(
		`SELECT id FROM capacity_workday_demands
		 WHERE workday_run_id = ? AND project_id = ? AND agent_id = ? AND activity_type = ?
		   AND source_type = ? AND source_id = ? AND status = 'completed'
		 LIMIT 1`,
		[input.runId, input.projectId, input.agentId, input.activityType, input.sourceType, input.sourceId],
	));
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
			agentId: `${agent.slug}:${agent.activityType}`, projectAgentClassId: agent.projectAgentClassId,
			eligible: Boolean(agent.projectAgentClassId && agent.handler),
			reasonCode: agent.projectAgentClassId && agent.handler ? null : 'agent_activity_profile_invalid',
			metadata: { agentId: agent.slug, activityType: agent.activityType, handlerId: agent.handler, planningStage: capacityWorkdayPlanningStage(agent) },
		})),
	});
	const demandRepository = new CapacityWorkdayDemandRepository(store);
	let created = 0;
	let actingActive: boolean | null = null;
	let artifactKinds: Set<string> | null = null;
	let signalCodes: Set<string> | null = null;
	for (const entry of entries.filter((value) => value.status === 'pending' && !value.demandId)) {
		const participationAgentId = text(record(entry.metadata).agentId) || entry.agentId;
		const participationActivity = text(record(entry.metadata).activityType);
		const agent = agents.find((candidate) => candidate.slug === participationAgentId && candidate.activityType === participationActivity);
		if (!agent) continue;
		const planningStage = capacityWorkdayPlanningStage(agent);
		const configured = agents.filter((candidate) => candidate.slug === agent.slug).map((candidate) => candidate.activityType);
		const completed = entries.filter((candidate) => candidate.status === 'completed' && text(record(candidate.metadata).agentId) === agent.slug).map((candidate) => text(record(candidate.metadata).activityType));
		if (!workdayPlanningStageReady(planningStage, entries)) continue;
		if (!workdayProfileStageReady(agent.activityType, configured, completed)) continue;
		const requiredArtifacts = capacityWorkdayRequiredArtifacts(agent);
		if (requiredArtifacts.length) {
			artifactKinds ??= new Set(await listCapacityWorkdayProducedArtifactKinds(store,run,project.id));
			if (requiredArtifacts.some((kind) => !artifactKinds?.has(kind))) continue;
		}
		const requiredSignals = capacityWorkdayRequiredSignals(agent);
		if (requiredSignals.length) {
			signalCodes ??= new Set(await listCapacityWorkdaySignalCodes(store,run,project.id));
			if (requiredSignals.some((code) => !signalCodes?.has(code))) continue;
		}
		if (agent.activityType === 'reporting') {
			if (actingActive === null) {
				const row = await store.first(`SELECT COUNT(*) AS total FROM capacity_workday_demands WHERE workday_id = ? AND mode = 'acting' AND status NOT IN ('completed', 'failed', 'cancelled', 'blocked')`, [workdayId]);
				actingActive = Number(row?.total ?? 0) > 0;
			}
			if (!workdayReportingStageReady(agent.activityType, entries, actingActive)) continue;
		}
		const intent = await resolveCapacityWorkdayAssignmentIntent(store, run, project, agent);
		const source = await resolvePlanningDemandSource(store, run, project, agent, intent);
		if (await completedEquivalentPlanningDemand(store, {
			runId: run.id,
			projectId: project.id,
			agentId: agent.slug,
			activityType: agent.activityType,
			sourceType: source.sourceType,
			sourceId: source.sourceId,
		})) continue;
		const idempotencyKey = `workday:${run.id}:${project.id}:cycle:${cycle.cycleNumber}:agent:${agent.slug}:profile:${agent.activityType}`;
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
				inputContract: agent.inputContract,
				outputContract: agent.outputContract,
				cycle: cycle.cycleNumber,
			},
			metadata: { participationCycleId: cycle.id, participationEntryId: entry.id, environment: run.environment, planningStage }, availableAt: now, now,
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
			if (run.parameters.planningOnly !== true) compiledDemands += await compileActingDemands(store, run, project, workdayId, now);
		}
	}
	return { consideredRuns: runs.length, compiledDemands };
}
