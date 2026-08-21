import { describe, expect, it, vi } from 'vitest';
import { requireTeamAccess } from '../../../../src/api/app/support/governance/policy/governance.ts';

function context(principal: Record<string, unknown>) {
	return {
		get(key: string) {
			if (key === 'principal') return principal;
			if (key === 'actorType') return 'service';
			return undefined;
		},
		json(payload: unknown, options: { status?: number } | number) {
			return { payload, status: typeof options === 'number' ? options : options?.status };
		},
	};
}

describe('local acceptance team access', () => {
	it('allows a platform administrator to inspect team-scoped operational state', async () => {
		const principal = { id: 'admin-a', roles: ['platform_admin'] };
		const principalCanAccessTeam = vi.fn(async () => false);

		await expect(requireTeamAccess(
			context(principal) as never,
			{ principalCanAccessTeam } as never,
			'team-a',
			'projects:read:team',
		)).resolves.toEqual({ principal });
		expect(principalCanAccessTeam).not.toHaveBeenCalled();
	});

	it('allows the isolated live-acceptance service to manage its run-created team', async () => {
		const principal = {
			id: 'team-key:local-capacity-acceptance',
			roles: ['team_api_key', 'platform_admin'],
			permissions: ['*:*:*'],
			metadata: { localAcceptance: true },
		};
		const principalCanAccessTeam = vi.fn(async () => false);

		await expect(requireTeamAccess(
			context(principal) as never,
			{ principalCanAccessTeam } as never,
			'run-created-team',
			'projects:manage:team',
		)).resolves.toEqual({ principal });
		expect(principalCanAccessTeam).not.toHaveBeenCalled();
	});
});
