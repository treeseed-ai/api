import type { CapacityAllocationSetV2, CapacityGrantV2 } from '@treeseed/sdk/agent-capacity/allocation';
import { CapacityGovernanceError } from '../../../../database.ts';

export interface GovernedWorkdayProject {
	id: string;
	slug?: string | null;
	[key: string]: unknown;
}

export interface GovernedWorkdayMembership {
	id: string;
	teamId: string;
	providerId: string;
	status: string;
}

export interface GovernedWorkdayScheduleRepository {
	approvedMembership(teamId: string, providerId: string): Promise<GovernedWorkdayMembership | null>;
	teamProjects(teamId: string): Promise<GovernedWorkdayProject[]>;
	allocation(teamId: string, allocationSetId: string | null): Promise<CapacityAllocationSetV2 | null>;
	activeGrants(input: {
		teamId: string;
		membershipId: string;
		providerId: string;
		projectId: string;
	}): Promise<CapacityGrantV2[]>;
}

export interface GovernedWorkdayScheduleInput {
	teamId: string;
	providerId: string;
	projectSlugs: string[];
	environment: string;
	allocationSetId?: string | null;
	at: string;
}

export interface GovernedWorkdaySchedule {
	membership: GovernedWorkdayMembership;
	projects: GovernedWorkdayProject[];
	allocationSet: CapacityAllocationSetV2;
	grantsByProjectId: ReadonlyMap<string, CapacityGrantV2>;
}

function timestamp(value: string | null | undefined) {
	const parsed = value ? Date.parse(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : null;
}

function projectLabel(project: GovernedWorkdayProject) {
	return project.slug || project.id;
}

/**
 * Resolves workday policy from durable, human-controlled governance records.
 * This service deliberately has no mutation methods: scheduling may consume
 * policy, but it must never create, activate, supersede, or expire policy.
 */
export async function resolveGovernedWorkdaySchedule(
	repository: GovernedWorkdayScheduleRepository,
	input: GovernedWorkdayScheduleInput,
): Promise<GovernedWorkdaySchedule> {
	const requestedSlugs = [...new Set(input.projectSlugs.map((slug) => slug.trim()).filter(Boolean))];
	if (requestedSlugs.length === 0) {
		throw new CapacityGovernanceError('capacity_workday_projects_required', 'Workday requires at least one project.', 400);
	}
	const at = timestamp(input.at);
	if (at === null) {
		throw new CapacityGovernanceError('capacity_workday_schedule_time_invalid', 'Workday scheduling time must be a valid ISO timestamp.', 400);
	}

	const membership = await repository.approvedMembership(input.teamId, input.providerId);
	if (!membership || membership.status !== 'approved') {
		throw new CapacityGovernanceError('capacity_workday_membership_not_approved', 'Workday requires an approved provider membership.', 409);
	}

	const allProjects = await repository.teamProjects(input.teamId);
	const bySlug = new Map(allProjects.map((project) => [String(project.slug || project.id), project]));
	const missingSlugs = requestedSlugs.filter((slug) => !bySlug.has(slug));
	if (missingSlugs.length > 0) {
		throw new CapacityGovernanceError(
			'capacity_workday_projects_not_found',
			`Workday projects do not exist in the team: ${missingSlugs.join(', ')}.`,
			404,
			{ projectSlugs: missingSlugs },
		);
	}
	const projects = requestedSlugs.map((slug) => bySlug.get(slug)!);

	const allocationSet = await repository.allocation(input.teamId, input.allocationSetId || null);
	if (!allocationSet || allocationSet.teamId !== input.teamId || allocationSet.status !== 'active') {
		throw new CapacityGovernanceError('capacity_workday_allocation_not_active', 'Workday requires an active team capacity allocation set.', 409);
	}
	const effectiveFrom = timestamp(allocationSet.effectiveFrom);
	const effectiveUntil = timestamp(allocationSet.effectiveUntil);
	if (effectiveFrom === null || effectiveFrom > at || (effectiveUntil !== null && effectiveUntil <= at)) {
		throw new CapacityGovernanceError(
			'capacity_workday_allocation_not_effective',
			'Workday allocation is not effective at the scheduling time.',
			409,
			{ allocationSetId: allocationSet.id, at: input.at },
		);
	}
	const missingAllocationProjects = projects.filter((project) => !allocationSet.slices.some(
		(slice) => slice.scope === 'project' && slice.targetId === project.id,
	));
	if (missingAllocationProjects.length > 0) {
		throw new CapacityGovernanceError(
			'capacity_workday_allocation_project_missing',
			`Active capacity allocation does not cover projects: ${missingAllocationProjects.map(projectLabel).join(', ')}.`,
			409,
			{ projectIds: missingAllocationProjects.map((project) => project.id) },
		);
	}

	const grantsByProjectId = new Map<string, CapacityGrantV2>();
	for (const project of projects) {
		const candidates = (await repository.activeGrants({
			teamId: input.teamId,
			membershipId: membership.id,
			providerId: input.providerId,
			projectId: project.id,
		})).filter((grant) => grant.status === 'active'
			&& grant.teamId === input.teamId
			&& grant.membershipId === membership.id
			&& grant.providerId === input.providerId
			&& grant.projectId === project.id
			&& grant.environment === input.environment
			&& grant.allowedModes.includes('planning')
			&& (timestamp(grant.expiresAt) === null || timestamp(grant.expiresAt)! > at));
		if (candidates.length === 0) {
			throw new CapacityGovernanceError(
				'capacity_workday_planning_grant_missing',
				`Workday requires an active planning grant for project ${projectLabel(project)}.`,
				409,
				{ projectId: project.id },
			);
		}
		if (candidates.length > 1) {
			throw new CapacityGovernanceError(
				'capacity_workday_planning_grant_ambiguous',
				`Workday found multiple active planning grants for project ${projectLabel(project)}; pause or revoke overlapping grants before scheduling.`,
				409,
				{ projectId: project.id, grantIds: candidates.map((grant) => grant.id).sort() },
			);
		}
		grantsByProjectId.set(project.id, candidates[0]!);
	}

	return { membership, projects, allocationSet, grantsByProjectId };
}
