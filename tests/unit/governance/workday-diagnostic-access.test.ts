import { describe, expect, it } from 'vitest';
import { requireTeamAccess } from '../../../src/api/app/support/governance/policy/governance.ts';

function context(principal: unknown) {
	return {
		get(key: string) { return key === 'principal' ? principal : undefined; },
		json(payload: unknown, options: number | { status?: number }) { return { payload, status: typeof options === 'number' ? options : options?.status }; },
	};
}

describe('workday diagnostic access', () => {
	it('requires the exact team-derived diagnostic permission', async () => {
		const principal = { id: 'member', roles: ['member'] };
		const denied = await requireTeamAccess(context(principal) as never, {
			async principalCanAccessTeam() { return true; },
			async getTeamAccessSummary() { return { permissions: ['knowledge:read'] }; },
		} as never, 'team-a', 'workday:diagnose') as { response: { status: number; payload: unknown } };
		expect(denied.response.status).toBe(403);
		expect(denied.response.payload).toMatchObject({ permission: 'workday:diagnose' });
	});

	it('allows a member carrying the team diagnostic permission', async () => {
		const principal = { id: 'reviewer', roles: ['member'] };
		const granted = await requireTeamAccess(context(principal) as never, {
			async principalCanAccessTeam() { return true; },
			async getTeamAccessSummary() { return { permissions: ['workday:diagnose'] }; },
		} as never, 'team-a', 'workday:diagnose');
		expect(granted).toEqual({ principal });
	});
});
