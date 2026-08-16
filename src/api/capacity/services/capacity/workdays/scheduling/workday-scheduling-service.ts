import type { CapacityAllocationSetV2 } from '@treeseed/sdk/agent-capacity/allocation';
import { validateWorkdayTimePolicy } from '@treeseed/sdk/agent-capacity';
import type { CapacityPage } from '@treeseed/sdk/capacity-pagination';
import type { CapacityGovernanceDatabase } from '../../../../database.ts';
import { CapacityGovernanceError } from '../../../../database.ts';
import type {
CreateWorkdayCapacityEnvelopeInput,
DurableWorkdayCapacityEnvelope,
} from '../../../../repositories/capacity/workdays/workday-envelope.ts';
import type { DurableCapacityWorkdayRun } from '../../../../repositories/capacity/workdays/workday-run.ts';
import { CapacityGrantService } from '../../allocations/grant-service.ts';
import { resolveGovernedWorkdaySchedule } from '../policy/workday-governance-service.ts';
import {
capacityWorkdayContentRoot,
capacityWorkdayRequestedProjectSlugs,
type WorkdayProject,
} from '../policy/workday-project-policy.ts';
import { resolveWorkdayPlanningGraphSnapshot } from '../policy/workday-planning-graph-policy.ts';
import { compileWorkdayAtlasTopology } from '../policy/workday-atlas-topology-policy.ts';
import { compileCooperativePlanningSession,initializeCooperativePlanningSession } from './cooperative-planning-session-service.ts';
import { reconcileTreeDxRefSignals } from '../../../treedx/repositories/treedx-ref-signal-reconciler.ts';
import { ContextQueryCheckService } from '../../agents/context-query-check-service.ts';

type JsonRecord = Record<string, unknown>;

export interface WorkdayScheduleStore extends CapacityGovernanceDatabase {
	listTeamProjects(teamId: string): Promise<WorkdayProject[]>;
	listProjectAgentClassesPage(projectId: string, filters: { limit: number }): Promise<CapacityPage<unknown>>;
	getCapacityAllocationSet(teamId: string, allocationSetId: string): Promise<CapacityAllocationSetV2 | null>;
	getActiveCapacityAllocationSet(teamId: string): Promise<CapacityAllocationSetV2 | null>;
	getProjectTreeDxLibrary(projectId: string): Promise<{ repositoryId?: unknown; contentPath?: unknown; contentRepositoryRef?: unknown } | null>;
	createWorkdayCapacityEnvelope(input: CreateWorkdayCapacityEnvelopeInput, idempotencyKey?: string): Promise<DurableWorkdayCapacityEnvelope | null>;
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

function safeIdPart(value: unknown, fallback = 'item'): string {
	return String(value ?? fallback).trim().toLowerCase()
		.replace(/[^a-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '') || fallback;
}

function workdayTime(parameters: JsonRecord) {
	if (parameters.availableCredits !== undefined || parameters.creditBudget !== undefined) throw new CapacityGovernanceError('capacity_workday_legacy_credits_rejected', 'Legacy credit budgets cannot schedule new work. Configure workday time policy.', 409);
	const durationSeconds = Number(parameters.durationSeconds);
	const concurrency = Number(parameters.maxActiveAssignments ?? 1);
	if (!Number.isInteger(durationSeconds) || durationSeconds < 60 || !Number.isInteger(concurrency) || concurrency < 1) throw new CapacityGovernanceError('capacity_workday_time_budget_invalid', 'Workday duration and concurrency must define positive agent-time.', 400);
	const policy = record(parameters.timePolicy);
	const timePolicy = {
		cooperativePlanningPercent: Number(policy.cooperativePlanningPercent ?? (parameters.planningOnly === true ? 90 : 20)),
		governedExecutionPercent: Number(policy.governedExecutionPercent ?? (parameters.planningOnly === true ? 0 : 70)),
		reservePercent: Number(policy.reservePercent ?? 10),
	};
	const validation = validateWorkdayTimePolicy(timePolicy);
	if (!validation.ok || !validation.value || parameters.planningOnly === true && timePolicy.governedExecutionPercent !== 0) throw new CapacityGovernanceError('capacity_workday_time_policy_invalid', validation.diagnostics[0]?.message ?? 'Planning-only workdays must allocate zero governed-execution time.', 400);
	return { availableSeconds: durationSeconds * concurrency, timePolicy: validation.value };
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

async function resolveCapacityWorkdayPreflight(
	store: WorkdayScheduleStore,
	run: DurableCapacityWorkdayRun,
) {
	await store.ensureInitialized();
	const legacy = await store.first(`SELECT id FROM capacity_reservations WHERE team_id = ? AND state IN ('reserved','consuming','overran_pending_approval','continuation_required') AND requested_seconds IS NULL LIMIT 1`, [run.teamId]);
	if (legacy) throw new CapacityGovernanceError('capacity_legacy_reservations_active', 'Time scheduling is blocked while a nonterminal legacy-credit reservation remains. Terminalize or recover legacy capacity before retrying.', 409, { reservationId: legacy.id, cleanupOperation: 'trsd capacity recover --legacy-reservations' });
	const parameters = run.parameters;
	const executionMode = run.executionMode ?? (parameters.executionMode === 'production' ? 'production' : 'simulation');
	const providerId = text(run.capacityProviderId ?? parameters.providerId);
	if (!providerId) {
		throw new CapacityGovernanceError('capacity_workday_provider_required', 'Workday requires a capacity provider.', 400);
	}
	const requestedSlugs = capacityWorkdayRequestedProjectSlugs(parameters);
	const startedAt = run.startedAt ?? new Date().toISOString();
	const environment = text(run.environment, 'local');
	const requestedAllocationSetId = text(parameters.allocationSetId);
	const grants = new CapacityGrantService(store);
	const governed = await resolveGovernedWorkdaySchedule({
		approvedMembership: async (teamId, capacityProviderId) => {
			const row = await store.first(
				`SELECT * FROM capacity_provider_team_memberships
				 WHERE team_id = ? AND capacity_provider_id = ? AND status = 'approved'
				 ORDER BY approved_at ASC LIMIT 1`,
				[teamId, capacityProviderId],
			);
			return row ? {
				id: String(row.id), teamId: String(row.team_id),
				providerId: String(row.capacity_provider_id), status: String(row.status),
			} : null;
		},
		teamProjects: (teamId) => store.listTeamProjects(teamId),
		allocation: (teamId, allocationSetId) => allocationSetId
			? store.getCapacityAllocationSet(teamId, allocationSetId)
			: store.getActiveCapacityAllocationSet(teamId),
		activeGrants: ({ teamId, membershipId, providerId: capacityProviderId, projectId }) => grants.activePlanningMatches({
			teamId, membershipId, providerId: capacityProviderId, projectId, environment, at: startedAt,
		}),
	}, {
		teamId: run.teamId, providerId, projectSlugs: requestedSlugs,
		environment, allocationSetId: requestedAllocationSetId || null, at: startedAt,
	});
	const { membership, projects, allocationSet, grantsByProjectId } = governed;
	const contexts = new Map<string, { contentRoot: string; repositoryId: string; immutableRef: string }>();
	const planningGraphs = new Map<string, Awaited<ReturnType<typeof resolveWorkdayPlanningGraphSnapshot>>>();
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
		contexts.set(project.id, { contentRoot: contentRoot || capacityWorkdayContentRoot(project), repositoryId, immutableRef: text(library?.contentRepositoryRef, repositoryId) });
		const planningGraph=await resolveWorkdayPlanningGraphSnapshot(store, project.id, parameters.agentSelection);
		const contextRefs=[...new Map(planningGraph.agents.flatMap((agent)=>[
			...agent.contextQueryRefs.map((reference)=>({kind:'query' as const,...reference})),
			...agent.contextQuerySetRefs.map((reference)=>({kind:'query-set' as const,...reference})),
		]).map((reference)=>[`${reference.kind}:${reference.id}:${reference.revision}`,reference])).values()];
		if(contextRefs.length) await new ContextQueryCheckService(store).requirePassing(run.teamId,project.id,contexts.get(project.id)!.immutableRef,contextRefs,new Date(startedAt));
		planningGraphs.set(project.id,planningGraph);
	}
	const time = workdayTime(parameters);
	const planningSeconds = Math.floor(time.availableSeconds * time.timePolicy.cooperativePlanningPercent / 100);
	const rounds = Number(record(parameters.planningSession).rounds ?? 3);
	const maxConcurrentAssignments = Number(parameters.maxActiveAssignments ?? 1);
	const assignmentTimeboxSeconds = Number(record(parameters.planningSession).assignmentTimeboxSeconds ?? 900);
	const planning = compileCooperativePlanningSession({
		snapshots: planningGraphs, rounds, maxConcurrentAssignments, allocatedSeconds: planningSeconds, assignmentTimeboxSeconds,
	});
	return { parameters,executionMode,providerId,startedAt,environment,membership,projects,allocationSet,grantsByProjectId,contexts,planningGraphs,time,planningSeconds,rounds,maxConcurrentAssignments,assignmentTimeboxSeconds,planning };
}

export async function preflightCapacityWorkdayRun(store: WorkdayScheduleStore, run: DurableCapacityWorkdayRun) {
	const resolved = await resolveCapacityWorkdayPreflight(store, run);
	return {
		ok: true,
		teamId: run.teamId,
		providerId: resolved.providerId,
		allocationSetId: resolved.allocationSet.id,
		projects: resolved.projects.map((project) => ({
			id: project.id,
			slug: project.slug ?? project.id,
			repositoryId: resolved.contexts.get(project.id)!.repositoryId,
			planningGraphRevision: resolved.planningGraphs.get(project.id)!.revision,
			agentProfiles: resolved.planningGraphs.get(project.id)!.agents.length,
		})),
		availableSeconds: resolved.time.availableSeconds,
		planningSeconds: resolved.planningSeconds,
		requiredSeconds: resolved.planning.compiled.requiredSeconds,
		rounds: resolved.rounds,
		waves: resolved.planning.compiled.waves.length,
		participants: resolved.planning.participants.length,
	};
}

export async function scheduleCapacityWorkdayRun(
	store: WorkdayScheduleStore,
	run: DurableCapacityWorkdayRun,
): Promise<{ projects: WorkdayProject[]; allocationSet: CapacityAllocationSetV2 }> {
	const resolved = await resolveCapacityWorkdayPreflight(store, run);
	const { parameters,executionMode,providerId,startedAt,environment,membership,projects,allocationSet,grantsByProjectId,contexts,planningGraphs,time,planningSeconds,rounds,maxConcurrentAssignments,assignmentTimeboxSeconds } = resolved;
	for (const project of projects) await reconcileTreeDxRefSignals(store, project.id, startedAt);
	for (const project of projects) {
		const context = contexts.get(project.id)!;
		const grant = grantsByProjectId.get(project.id)!;
		const workdayId = safeIdPart(`workday-${run.id}-${project.slug ?? project.id}`);
		const envelope = await store.createWorkdayCapacityEnvelope({
			id: workdayId, workdayRunId: run.id, projectId: project.id, allocationSetId: allocationSet.id,
			environment, status: 'active', startedAt, availableSeconds: time.availableSeconds, timePolicy: time.timePolicy,
			metadata: {
				source: 'workday_scheduler', runId: run.id, slug: project.slug, executionMode,
				deadlineAt: parameters.deadlineAt ?? null, durationSeconds: parameters.durationSeconds ?? null,
				grantId: grant.id,
			},
		});
		if (!envelope || envelope.id !== workdayId) {
			throw new CapacityGovernanceError(
				'capacity_workday_envelope_create_failed',
				`Workday envelope ${workdayId} was not durably created.`,
				500,
				{ workdayId, projectId: project.id },
			);
		}
		await recordRequiredEvent(store, run.teamId, run.id, {
			eventType: 'workday.started', status: 'recorded', projectId: project.id, workdayId,
			title: `Started API-scheduled workday for ${project.slug ?? project.id}`,
			context: { ...context, allocationSetId: allocationSet.id, grantId: grant.id, planningGraphRevision: planningGraphs.get(project.id)!.revision },
		});
		await store.run(`INSERT INTO agent_signals
			(id,contract_id,subject_kind,subject_id,team_id,project_id,workday_run_id,assignment_id,agent_id,activity_type,capacity_provider_id,causation_id,correlation_id,origin,changed_paths_json,change_summary,evidence_ref,payload_json,metadata_json,created_at)
			VALUES (?,?,?,?,?,?,?,NULL,NULL,NULL,?,?,?,'deterministic-handler','[]',?,?,?, '{}',?) ON CONFLICT(id) DO NOTHING`, [
			`signal:workday-started:${run.id}:${project.id}`, 'workday-started', 'workday', run.id, run.teamId, project.id, run.id,
			providerId, `workday:${run.id}`, `workday:${run.id}`, 'Workday signal graph opened.', `workday-run:${run.id}`,
			JSON.stringify({ workdayId, graphRevision: planningGraphs.get(project.id)!.revision, objectives: parameters.objectiveRefs ?? [] }), startedAt,
		]);
	}
	await store.run(`INSERT INTO workday_planning_sessions
		(id,team_id,workday_run_id,graph_revision,status,agenda_json,objectives_json,proposal_ids_json,rounds,current_round,allocated_seconds,reserved_seconds,started_at,deadline,metadata_json,created_at,updated_at)
		VALUES (?,?,?,?,'running',?,?, '[]',?,0,?,0,?,?,?, ?, ?) ON CONFLICT(workday_run_id) DO NOTHING`, [
		`planning-session:${run.id}`, run.teamId, run.id,
		[...planningGraphs.values()].map((entry) => entry.revision).sort().join(':'),
		JSON.stringify(record(parameters.planningSession)), JSON.stringify(parameters.objectiveRefs ?? []),
		rounds, planningSeconds, startedAt, parameters.deadlineAt,
		JSON.stringify({ projectIds: projects.map((project) => project.id), maxActiveAssignments: parameters.maxActiveAssignments ?? 1 }), startedAt, startedAt,
	]);
	await initializeCooperativePlanningSession({
		database: store, teamId: run.teamId, runId: run.id, sessionId: `planning-session:${run.id}`,
		snapshots: planningGraphs, rounds,
		maxConcurrentAssignments, allocatedSeconds: planningSeconds, now: startedAt,
		assignmentTimeboxSeconds,
	});
	const updated = await store.updateCapacityWorkdayRun(run.teamId, run.id, {
		parameters: {
			...parameters, executionMode, allocationSetId: allocationSet.id, availableSeconds: time.availableSeconds, timePolicy: time.timePolicy,
			scheduledProjectIds: projects.map((project) => project.id),
			scheduledProjectSlugs: projects.map((project) => project.slug ?? project.id),
			repositoryIdsByProjectId: Object.fromEntries(
				projects.map((project) => [project.id, contexts.get(project.id)!.repositoryId]),
			),
			planningGraphByProjectId: Object.fromEntries(projects.map((project) => [project.id, planningGraphs.get(project.id)])),
			atlasTopologyByProjectId: Object.fromEntries(projects.map((project) => [project.id, compileWorkdayAtlasTopology({
				project, planning: planningGraphs.get(project.id)!, immutableRef: contexts.get(project.id)!.immutableRef, capturedAt: startedAt,
			})])),
		},
	});
	if (!updated) {
		throw new CapacityGovernanceError('capacity_workday_run_update_failed', 'Scheduled workday run could not be updated.', 500, { runId: run.id });
	}
	await recordRequiredEvent(store, run.teamId, run.id, {
		eventType: 'assignment.polling_ready', status: 'recorded',
		title: 'Workday is ready for authenticated provider polling',
		context: {
			providerId, membershipId: membership.id, architecture: 'membership_authenticated_provider_polling',
			note: 'Assignment creation is API-owned and is triggered only by an authenticated membership availability session.',
		},
	});
	return { projects, allocationSet };
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
