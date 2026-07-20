import { describe, expect, it } from 'vitest';
import type { CapacityAllocationSetV2, CapacityGrantV2 } from '@treeseed/sdk/agent-capacity/allocation';
import {
	resolveGovernedWorkdaySchedule,
	type GovernedWorkdayScheduleRepository,
} from '../../src/api/capacity/services/workday-governance-service.ts';

const at = '2026-07-17T12:00:00.000Z';
const project = { id: 'project-agent', slug: 'agent' };
const membership = { id: 'membership-a', teamId: 'team-a', providerId: 'provider-a', status: 'approved' };
const allocation: CapacityAllocationSetV2 = {
	schemaVersion: 2,
	id: 'allocation-a',
	teamId: 'team-a',
	version: 1,
	status: 'active',
	effectiveFrom: '2026-07-01T00:00:00.000Z',
	effectiveUntil: null,
	reservePolicy: { percent: 0, overflow: 'deny' },
	slices: [{ id: 'slice-agent', scope: 'project', targetId: project.id, policy: { minPercent: 100, targetPercent: 100, maxPercent: 100, hardCapPercent: 100 } }],
	borrowingRules: [],
};
const grant: CapacityGrantV2 = {
	schemaVersion: 2,
	id: 'grant-a',
	membershipId: membership.id,
	teamId: membership.teamId,
	providerId: membership.providerId,
	projectId: project.id,
	environment: 'local',
	status: 'active',
	executionProviderIds: ['codex'],
	laneIds: [],
	capabilities: ['engineering', 'research', 'repo_read', 'agent_mode_run'],
	allowedModes: ['planning'],
	unmetered: true,
};

function repository(overrides: Partial<GovernedWorkdayScheduleRepository> = {}): GovernedWorkdayScheduleRepository {
	return {
		async approvedMembership() { return membership; },
		async teamProjects() { return [project]; },
		async allocation() { return allocation; },
		async activeGrants() { return [grant]; },
		...overrides,
	};
}

function input(overrides: Partial<Parameters<typeof resolveGovernedWorkdaySchedule>[1]> = {}) {
	return {
		teamId: 'team-a',
		providerId: 'provider-a',
		projectSlugs: ['agent'],
		environment: 'local',
		allocationSetId: allocation.id,
		at,
		...overrides,
	};
}

describe('governed workday scheduling', () => {
	it('resolves existing membership, allocation, and grant without exposing policy mutation methods', async () => {
		const resolved = await resolveGovernedWorkdaySchedule(repository(), input());
		expect(resolved.membership).toEqual(membership);
		expect(resolved.projects).toEqual([project]);
		expect(resolved.allocationSet).toEqual(allocation);
		expect(resolved.grantsByProjectId.get(project.id)).toEqual(grant);
	});

	it('fails closed for missing projects instead of silently running a subset', async () => {
		await expect(resolveGovernedWorkdaySchedule(repository(), input({ projectSlugs: ['agent', 'missing'] })))
			.rejects.toMatchObject({ code: 'capacity_workday_projects_not_found', details: { projectSlugs: ['missing'] } });
	});

	it('requires an active allocation that is effective and covers every project', async () => {
		await expect(resolveGovernedWorkdaySchedule(repository({
			async allocation() { return { ...allocation, status: 'superseded' }; },
		}), input())).rejects.toMatchObject({ code: 'capacity_workday_allocation_not_active' });

		await expect(resolveGovernedWorkdaySchedule(repository({
			async allocation() { return { ...allocation, effectiveFrom: '2026-07-18T00:00:00.000Z' }; },
		}), input())).rejects.toMatchObject({ code: 'capacity_workday_allocation_not_effective' });

		await expect(resolveGovernedWorkdaySchedule(repository({
			async allocation() { return { ...allocation, slices: [] }; },
		}), input())).rejects.toMatchObject({ code: 'capacity_workday_allocation_project_missing' });
	});

	it('requires one unexpired planning grant in the workday environment', async () => {
		await expect(resolveGovernedWorkdaySchedule(repository({
			async activeGrants() { return [{ ...grant, environment: 'staging' }]; },
		}), input())).rejects.toMatchObject({ code: 'capacity_workday_planning_grant_missing' });

		await expect(resolveGovernedWorkdaySchedule(repository({
			async activeGrants() { return [{ ...grant, expiresAt: '2026-07-17T11:59:59.000Z' }]; },
		}), input())).rejects.toMatchObject({ code: 'capacity_workday_planning_grant_missing' });

		await expect(resolveGovernedWorkdaySchedule(repository({
			async activeGrants() { return [grant, { ...grant, id: 'grant-b' }]; },
		}), input())).rejects.toMatchObject({
			code: 'capacity_workday_planning_grant_ambiguous',
			details: { grantIds: ['grant-a', 'grant-b'] },
		});
	});
});
