import { describe, expect, it } from 'vitest';
import { requireTeamAccess } from '../../../src/api/app/support/governance/policy/governance.ts';

function context(principal: any) {
	return {
		get(key: string) { return key === 'principal' ? principal : undefined; },
		json(payload: any, options: any) { return { payload, status: options?.status ?? options }; },
	};
}

describe('knowledge permission boundary', () => {
	it('does not treat team membership as knowledge authoring permission', async () => {
		const store = {
			async principalCanAccessTeam() { return true; },
			async getTeamAccessSummary() { return { permissions: ['knowledge:read'] }; },
		};
		const denied: any = await requireTeamAccess(context({ id: 'viewer', roles: ['user'] }), store, 'team-a', 'knowledge:author');
		expect(denied.response.status).toBe(403);
		expect(denied.response.payload).toMatchObject({ permission: 'knowledge:author' });
	});

	it('accepts the exact role-derived knowledge permission', async () => {
		const principal = { id: 'author', roles: ['user'] };
		const store = {
			async principalCanAccessTeam() { return true; },
			async getTeamAccessSummary() { return { permissions: ['knowledge:read', 'knowledge:author'] }; },
		};
		await expect(requireTeamAccess(context(principal), store, 'team-a', 'knowledge:author'))
			.resolves.toEqual({ principal });
	});
});
