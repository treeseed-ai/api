import { createHash } from 'node:crypto';
import { compileWorkday } from '@treeseed/sdk/agent-capacity';
import type { CapacityPage } from '@treeseed/sdk/capacity-pagination';
import type { CapacityGovernanceDatabase } from '../../../../database.ts';
import { CapacityGovernanceError } from '../../../../database.ts';
import type { DurableCapacityWorkdayRun } from '../../../../repositories/capacity/workdays/workday-run.ts';
import {
capacityWorkdayContentRoot,
capacityWorkdayRequestedProjectReferences,
resolveCapacityWorkdayProjects,
type WorkdayProject,
} from '../policy/workday-project-policy.ts';
import { resolveWorkdayAgentProfileSnapshot } from '../policy/workday-agent-profile-policy.ts';
import { reconcileTreeDxRefSignals } from '../../../treedx/repositories/treedx-ref-signal-reconciler.ts';
import { reconcileExecutionGraph } from '../../../../../control-plane/repositories/capacity/execution/execution-graph-service.ts';
import { workdayParticipants } from '../../../../policy/execution/workday-participants.ts';
import { readExactProposal } from '../../../../../governance/executable-proposal.ts';

type JsonRecord = Record<string, unknown>;

export interface WorkdayScheduleStore extends CapacityGovernanceDatabase {
	listTeamProjects(teamId: string): Promise<WorkdayProject[]>;
	listProjectAgentClassesPage(projectId: string, filters: { limit: number }): Promise<CapacityPage<unknown>>;
	getProjectTreeDxLibrary(projectId: string): Promise<{ repositoryId?: unknown; contentPath?: unknown; contentRepositoryRef?: unknown; metadata?: unknown } | null>;
	createCapacityWorkdayEvent(teamId: string, runId: string, input: JsonRecord): Promise<unknown>;
	updateCapacityWorkdayRun(teamId: string, runId: string, input: JsonRecord): Promise<DurableCapacityWorkdayRun | null>;
	terminalizeCapacityWorkdayEnvelopes(teamId: string, runId: string, status: string): Promise<{ terminalized: number }>;
}

function text(value: unknown, fallback = ''): string {
	return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function record(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

export function canonicalWorkdayShares(parameters: JsonRecord, projects: WorkdayProject[]) {
	const canonical = (input: JsonRecord): JsonRecord => Object.fromEntries(Object.entries(input).map(([key, value]) => {
		const project = projects.find(candidate => candidate.id === key || candidate.slug === key);
		if (!project) throw new CapacityGovernanceError('capacity_workday_allocation_project_invalid',
			'Allocation percentages must reference a selected project.', 400, { project: key });
		if (Object.keys(input).some(other => other !== key && (other === project.id || other === project.slug))) {
			throw new CapacityGovernanceError('capacity_workday_allocation_project_duplicate',
				'Use one identifier per allocation project.', 400, { projectId: project.id });
		}
		return [project.id, value];
	}));
	return { projectPercentages: canonical(record(parameters.projectPercentages)),
		agentClassPercentages: canonical(record(parameters.agentClassPercentages)) as Record<string, Record<string, number>> };
}

function workdayTime(parameters: JsonRecord) {
	const durationSeconds = Number(parameters.durationSeconds);
	const concurrency = Number(parameters.maximumConcurrency ?? parameters.maxActiveAssignments ?? 1);
	if (!Number.isInteger(durationSeconds) || durationSeconds < 60 || !Number.isInteger(concurrency) || concurrency < 1) throw new CapacityGovernanceError('capacity_workday_time_budget_invalid', 'Workday duration and concurrency must define positive agent-time.', 400);
	return { availableSeconds: durationSeconds * concurrency };
}

function errorEvidence(error: unknown): JsonRecord {
	return {
		code: typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'capacity_workday_schedule_failed',
		message: error instanceof Error ? error.message : String(error),
	};
}

async function recordRequiredEvent(
	store: WorkdayScheduleStore,
	teamId: string,
	runId: string,
	input: JsonRecord,
): Promise<void> {
	const event = await store.createCapacityWorkdayEvent(teamId, runId, input);
	if (!event) {
		throw new CapacityGovernanceError(
			'capacity_workday_event_persistence_failed',
			`Required workday event ${String(input.eventType ?? 'unknown')} was not persisted.`,
			500,
			{ runId, eventType: input.eventType ?? null },
		);
	}
}

export function acceptedLibraryRevision(library: { metadata?: unknown; contentRepositoryRef?: unknown }, projectId: string): string {
	const immutableRef = text(record(library.metadata).resolvedRef, library.contentRepositoryRef);
	if (!/^[a-f0-9]{40}$/u.test(immutableRef)) throw new CapacityGovernanceError('capacity_workday_library_revision_unresolved',
		'Project library must be reconciled to an exact commit before scheduling.', 409, { projectId });
	return immutableRef;
}

/** Cooperative project planning requires one exact proposal; conversation runs bind exact message context instead. */
export function requiresGovernedPlanningProposal(run: Pick<DurableCapacityWorkdayRun, 'executionKind' | 'parameters'>): boolean {
	return run.executionKind === 'workday' && Array.isArray(record(run.parameters.agentSelection).activityTypes)
		&& (record(run.parameters.agentSelection).activityTypes as unknown[]).includes('estimating');
}

async function resolveCapacityWorkdayPreflight(
	store: WorkdayScheduleStore,
	run: DurableCapacityWorkdayRun,
) {
	await store.ensureInitialized();
	const parameters = run.parameters;
	const executionMode = run.executionMode;
	const providerId = text(run.capacityProviderId ?? parameters.providerId);
	if (!providerId) {
		throw new CapacityGovernanceError('capacity_workday_provider_required', 'Workday requires a capacity provider.', 400);
	}
	const requestedReferences = capacityWorkdayRequestedProjectReferences(parameters);
	const startedAt = run.startedAt ?? new Date().toISOString();
	const environment = text(run.environment, 'local');
	const membership = await store.first(`SELECT id,team_id,capacity_provider_id,status FROM capacity_provider_team_memberships
		WHERE team_id=? AND capacity_provider_id=? AND status='approved' ORDER BY approved_at ASC,id ASC LIMIT 1`, [run.teamId,providerId]);
	if (!membership) throw new CapacityGovernanceError('capacity_workday_membership_not_approved',
		'Workday requires an approved capacity-provider membership.', 409, { teamId: run.teamId, providerId });
	const projects = resolveCapacityWorkdayProjects(requestedReferences, await store.listTeamProjects(run.teamId));
	const contexts = new Map<string, { contentRoot: string; repositoryId: string; immutableRef: string }>();
	const proposalContexts = new Map<string, Record<string, unknown>>();
	const selectedProposalIds = Array.isArray(parameters.proposalIds) ? parameters.proposalIds.map(text).filter(Boolean) : [];
	const selectedProposals = await Promise.all(selectedProposalIds.map(async (proposalId) => {
		const proposal = await store.getGovernanceProposal(proposalId);
		if (!proposal || text(proposal.teamId) !== run.teamId) throw new CapacityGovernanceError(
			'capacity_workday_proposal_not_found', `Workday proposal ${proposalId} is unavailable to this team.`, 404, { proposalId });
		if (!['draft','submitted','open','voting'].includes(text(proposal.status))) throw new CapacityGovernanceError(
			'capacity_workday_proposal_not_plannable', `Workday proposal ${proposalId} is not open for cooperative planning.`, 409, { proposalId });
		const exact = await readExactProposal(store, proposal);
		return { proposalId, projectId: text(proposal.projectId), ref: exact.ref, definition: exact.definition };
	}));
	const agentProfiles = new Map<string, Awaited<ReturnType<typeof resolveWorkdayAgentProfileSnapshot>>>();
	for (const project of projects) {
		const library = await store.getProjectTreeDxLibrary(project.id);
		const repositoryId = text(library?.repositoryId);
		if (!repositoryId) {
			throw new CapacityGovernanceError(
				'capacity_workday_treedx_binding_missing',
				`Workday requires a configured TreeDX repository for project ${project.slug ?? project.id}.`,
				409,
				{ projectId: project.id },
			);
		}
		const contentRoot = text(library?.contentPath).replace(/^\/+|\/+$/gu, '');
		const immutableRef = acceptedLibraryRevision(library ?? {}, project.id);
		contexts.set(project.id, { contentRoot: contentRoot || capacityWorkdayContentRoot(project), repositoryId, immutableRef });
		const profileSnapshot=await resolveWorkdayAgentProfileSnapshot(store, project.id, parameters.agentSelection);
		agentProfiles.set(project.id,profileSnapshot);
		const projectProposals = selectedProposals.filter((proposal) => proposal.projectId === project.id);
		if (requiresGovernedPlanningProposal(run) && projectProposals.length !== 1) throw new CapacityGovernanceError(
			'capacity_workday_proposal_selection_invalid', 'A planning-only workday requires exactly one governed proposal per selected project.', 409,
			{ projectId: project.id, proposalIds: projectProposals.map((proposal) => proposal.proposalId) });
		if (projectProposals[0]) proposalContexts.set(project.id, projectProposals[0].ref);
	}
	const selectedProjectIds = new Set(projects.map((project) => project.id));
	const outsideSelection = selectedProposals.filter((proposal) => !selectedProjectIds.has(proposal.projectId));
	if (outsideSelection.length) throw new CapacityGovernanceError('capacity_workday_proposal_project_mismatch',
		'Every selected proposal must belong to a selected workday project.', 409,
		{ proposalIds: outsideSelection.map((proposal) => proposal.proposalId) });
	const time = workdayTime(parameters);
	const frozenProfilesByProjectId = Object.fromEntries(agentProfiles);
	const agentIds = workdayParticipants({
		agentSelection: parameters.agentSelection,
		agentProfilesByProjectId: frozenProfilesByProjectId,
		proposalsByProjectId: Object.fromEntries(selectedProposals.map(proposal => [proposal.projectId, proposal.definition])),
	}).map((participant) => participant.id);
	const appliedPlan = compileWorkday({ id: run.id, teamId: run.teamId,
		executionMode,
		activityTypes: Array.isArray(record(parameters.agentSelection).activityTypes)
			? (record(parameters.agentSelection).activityTypes as unknown[]).map((value) => text(value)) : [],
		policyId: text(parameters.policyId, 'default'), policyRevision: Math.max(1, Number(parameters.policyRevision ?? 1)),
		policy: { durationSeconds: Math.max(1, Number(parameters.durationSeconds)),
			maximumConcurrency: Math.max(1, Number(parameters.maximumConcurrency ?? parameters.maxActiveAssignments ?? 1)),
			planningPercent: Number(parameters.planningPercent ?? 20), allocationWeight: Number(parameters.allocationWeight ?? 1),
			planningTurnMaximumSeconds: Number(parameters.planningTurnMaximumSeconds ?? 180),
			communicationConcurrency: Math.max(1, Number(parameters.communicationConcurrency ?? 1)),
			...canonicalWorkdayShares(parameters, projects) },
		agentIds, startsAt: startedAt });
	// Turn ceilings are not reservations. Admission sizes each turn against supply.
	const planningSeconds = appliedPlan.planningRounds.length ? agentIds.length * 2 : 0;
	if (planningSeconds > time.availableSeconds * appliedPlan.policySnapshot.planningPercent / 100) throw new CapacityGovernanceError('capacity_workday_planning_capacity_insufficient',
		'Workday capacity cannot guarantee the compiled cooperative assignments for every selected agent.', 409,
		{ requiredSeconds: planningSeconds, availableSeconds: time.availableSeconds, agentCount: agentIds.length });
	return { parameters,executionMode,providerId,startedAt,environment,membership,projects,contexts,proposalContexts,agentProfiles,time,appliedPlan };
}

export async function preflightCapacityWorkdayRun(store: WorkdayScheduleStore, run: DurableCapacityWorkdayRun) {
	const resolved = await resolveCapacityWorkdayPreflight(store, run);
	const executionNodeDemands=(await Promise.all(resolved.projects.map((project)=>store.all(
		`SELECT node.*, graph.revision AS graph_revision FROM execution_nodes node
		JOIN LATERAL (SELECT revision FROM execution_graph_revisions WHERE team_id=node.team_id ORDER BY revision DESC LIMIT 1) graph ON true
		WHERE node.team_id = ? AND node.project_id = ? AND node.status = 'ready' AND node.kind <> 'condition'
		AND node.workday_id IS NULL
		AND NOT EXISTS (SELECT 1 FROM capacity_provider_assignments assignment
			WHERE assignment.team_id=node.team_id AND assignment.execution_node_id=node.id
			AND assignment.execution_node_revision=node.node_revision)
		ORDER BY node.id`,
		[run.teamId,project.id])))).flat();
	return {
		ok: true,
		teamId: run.teamId,
		providerId: resolved.providerId,
		projects: resolved.projects.map((project) => ({
			id: project.id,
			slug: project.slug ?? project.id,
			repositoryId: resolved.contexts.get(project.id)!.repositoryId,
			agentProfileRevision: resolved.agentProfiles.get(project.id)!.revision,
			agentProfiles: resolved.agentProfiles.get(project.id)!.agents.length,
			agents: resolved.agentProfiles.get(project.id)!.agents.map((agent) => ({
				slug: agent.definition.id,
				agentClass: agent.definition.agentClass,
				classId: agent.projectAgentClassId,
				classSlug: agent.projectAgentClassSlug,
				activityTypes: agent.activities,
			})),
		})),
		availableSeconds: resolved.time.availableSeconds,
		executionNodeDemands,
		appliedPlan: resolved.appliedPlan,
	};
}

export async function scheduleCapacityWorkdayRun(
	store: WorkdayScheduleStore,
	run: DurableCapacityWorkdayRun,
): Promise<{ projects: WorkdayProject[] }> {
	const resolved = await resolveCapacityWorkdayPreflight(store, run);
	const { parameters,executionMode,providerId,startedAt,membership,projects,contexts,proposalContexts,agentProfiles,time,appliedPlan } = resolved;
	for (const project of projects) await reconcileTreeDxRefSignals(store, project.id, startedAt);
	for (const project of projects) {
		const context = contexts.get(project.id)!;
		await recordRequiredEvent(store, run.teamId, run.id, {
			eventType: 'workday.started', status: 'recorded', projectId: project.id, workdayId: run.id,
			title: `Started API-scheduled workday for ${project.slug ?? project.id}`,
			context: { ...context, agentProfileRevision: agentProfiles.get(project.id)!.revision },
		});
	}
	const updated = await store.updateCapacityWorkdayRun(run.teamId, run.id, {
		parameters: {
			...parameters, appliedPlan: { ...appliedPlan, state: 'active', activatedAt: startedAt },
			availableSeconds: time.availableSeconds,
			scheduledProjectIds: projects.map((project) => project.id),
			scheduledProjectSlugs: projects.map((project) => project.slug ?? project.id),
			repositoryIdsByProjectId: Object.fromEntries(
				projects.map((project) => [project.id, contexts.get(project.id)!.repositoryId]),
			),
			planningSourceByProjectId: Object.fromEntries(proposalContexts),
			workdayContextByProjectId: Object.fromEntries(projects.map((project) => {
				const context = contexts.get(project.id)!;
				const root = context.contentRoot === '.' ? '' : `${context.contentRoot.replace(/\/+$/u, '')}/`;
				return [project.id, { store: 'treedx', model: 'knowledge', id: `${project.id}:project-context`, revision: 1,
					digest: `sha256:${createHash('sha256').update(`${context.repositoryId}:${context.immutableRef}:${root}README.md`).digest('hex')}`,
					repository: context.repositoryId, commit: context.immutableRef, path: `${root}README.md` }];
			})),
			agentProfilesByProjectId: Object.fromEntries(projects.map((project) => [project.id, agentProfiles.get(project.id)])),
		},
	});
	if (!updated) {
		throw new CapacityGovernanceError('capacity_workday_run_update_failed', 'Scheduled workday run could not be updated.', 500, { runId: run.id });
	}
	await reconcileExecutionGraph(store, run.teamId);
	await recordRequiredEvent(store, run.teamId, run.id, {
		eventType: 'assignment.polling_ready', status: 'recorded',
		title: 'Workday is ready for authenticated provider polling',
		context: {
			providerId, membershipId: membership.id, architecture: 'membership_authenticated_provider_polling',
			note: 'Assignment creation is API-owned and is triggered only by an authenticated membership availability session.',
		},
	});
	return { projects };
}

export async function recordCapacityWorkdayScheduleFailure(
	store: WorkdayScheduleStore,
	run: Pick<DurableCapacityWorkdayRun, 'teamId' | 'id'>,
	error: unknown,
	now = new Date().toISOString(),
): Promise<void> {
	const evidence = errorEvidence(error);
	const failures: JsonRecord[] = [];
	for (const [owner, operation] of [
		['envelopes', () => store.terminalizeCapacityWorkdayEnvelopes(run.teamId, run.id, 'failed')],
		['event', () => recordRequiredEvent(store, run.teamId, run.id, {
			eventType: 'workday.schedule_failed', status: 'error', title: 'Workday schedule failed', context: { error: evidence.message, code: evidence.code },
		})],
		['run', async () => {
			const updated = await store.updateCapacityWorkdayRun(run.teamId, run.id, {
				status: 'failed', completedAt: now, error: { code: 'capacity_workday_schedule_failed', message: evidence.message, causeCode: evidence.code },
			});
			if (!updated) {
				throw new CapacityGovernanceError('capacity_workday_run_update_failed', 'Failed workday run could not be updated.', 500, { runId: run.id });
			}
		}],
	] as const) {
		try {
			await operation();
		} catch (recoveryError) {
			failures.push({ owner, ...errorEvidence(recoveryError) });
		}
	}
	if (failures.length > 0) {
		throw new CapacityGovernanceError(
			'capacity_workday_schedule_recovery_incomplete',
			'Workday scheduling failed and required recovery evidence could not be fully persisted.',
			500,
			{ runId: run.id, schedulingFailure: evidence, recoveryFailures: failures },
		);
	}
}
