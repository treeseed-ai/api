import type { CapacityAllocationSetV2 } from '@treeseed/sdk/agent-capacity/allocation';
import type { CapacityGovernanceDatabase } from '../database.ts';
import { CapacityGovernanceError } from '../database.ts';
import type { DurableCapacityWorkdayRun } from '../repositories/workday-run.ts';
import type {
	CreateWorkdayCapacityEnvelopeInput,
	DurableWorkdayCapacityEnvelope,
} from '../repositories/workday-envelope.ts';
import { CapacityGrantService } from './grant-service.ts';
import { resolveGovernedWorkdaySchedule } from './workday-governance-service.ts';
import {
	capacityWorkdayContentRoot,
	capacityWorkdayRequestedProjectSlugs,
	type WorkdayProject,
} from './workday-project-policy.ts';

type JsonRecord = Record<string, unknown>;

export interface WorkdayScheduleStore extends CapacityGovernanceDatabase {
	listTeamProjects(teamId: string): Promise<WorkdayProject[]>;
	getCapacityAllocationSet(teamId: string, allocationSetId: string): Promise<CapacityAllocationSetV2 | null>;
	getActiveCapacityAllocationSet(teamId: string): Promise<CapacityAllocationSetV2 | null>;
	getProjectTreeDxLibrary(projectId: string): Promise<{ repositoryId?: unknown; contentPath?: unknown } | null>;
	createWorkdayCapacityEnvelope(input: CreateWorkdayCapacityEnvelopeInput, idempotencyKey?: string): Promise<DurableWorkdayCapacityEnvelope | null>;
	createCapacityWorkdayEvent(teamId: string, runId: string, input: JsonRecord): Promise<unknown>;
	updateCapacityWorkdayRun(teamId: string, runId: string, input: JsonRecord): Promise<DurableCapacityWorkdayRun | null>;
	terminalizeCapacityWorkdayEnvelopes(teamId: string, runId: string, status: string): Promise<{ terminalized: number }>;
}

function text(value: unknown, fallback = ''): string {
	return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function safeIdPart(value: unknown, fallback = 'item'): string {
	return String(value ?? fallback).trim().toLowerCase()
		.replace(/[^a-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '') || fallback;
}

function availableCredits(parameters: JsonRecord): number {
	const value = Number(parameters.availableCredits ?? parameters.creditBudget ?? 100);
	if (!Number.isFinite(value) || value < 0) {
		throw new CapacityGovernanceError(
			'capacity_workday_credit_budget_invalid',
			'Workday available credits must be non-negative and finite.',
			400,
			{ value: parameters.availableCredits ?? parameters.creditBudget ?? null },
		);
	}
	return value;
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

export async function scheduleCapacityWorkdayRun(
	store: WorkdayScheduleStore,
	run: DurableCapacityWorkdayRun,
): Promise<{ projects: WorkdayProject[]; allocationSet: CapacityAllocationSetV2 }> {
	await store.ensureInitialized();
	const parameters = run.parameters;
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
	const contexts = new Map<string, { contentRoot: string; repositoryId: string }>();
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
		contexts.set(project.id, { contentRoot: text(library?.contentPath, capacityWorkdayContentRoot(project)), repositoryId });
	}
	const credits = availableCredits(parameters);
	for (const project of projects) {
		const context = contexts.get(project.id)!;
		const grant = grantsByProjectId.get(project.id)!;
		const workdayId = safeIdPart(`workday-${run.id}-${project.slug ?? project.id}`);
		const envelope = await store.createWorkdayCapacityEnvelope({
			id: workdayId, workdayRunId: run.id, projectId: project.id, allocationSetId: allocationSet.id,
			environment, status: 'active', startedAt, availableCredits: credits,
			metadata: {
				source: 'workday_scheduler', runId: run.id, slug: project.slug,
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
			context: { ...context, allocationSetId: allocationSet.id, grantId: grant.id },
		});
	}
	const updated = await store.updateCapacityWorkdayRun(run.teamId, run.id, {
		parameters: {
			...parameters, allocationSetId: allocationSet.id,
			scheduledProjectIds: projects.map((project) => project.id),
			scheduledProjectSlugs: projects.map((project) => project.slug ?? project.id),
			repositoryIdsByProjectId: Object.fromEntries(
				projects.map((project) => [project.id, contexts.get(project.id)!.repositoryId]),
			),
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
