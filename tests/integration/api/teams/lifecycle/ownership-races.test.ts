import {
	createTestPostgresDatabase,
	createTestStore,
	describe,
	expect,
	it,
} from '../../../../support/api-harness.ts';

async function teamWithTwoOwners() {
	const store = createTestStore(createTestPostgresDatabase());
	const timestamp = new Date().toISOString();
	await store.batch([
		{
			query: `INSERT INTO users (id, email, display_name, status, metadata_json, created_at, updated_at)
				VALUES (?, ?, ?, 'active', '{}', ?, ?)`,
			params: ['race-owner-a', 'race-a@example.com', 'Race Owner A', timestamp, timestamp],
		},
		{
			query: `INSERT INTO users (id, email, display_name, status, metadata_json, created_at, updated_at)
				VALUES (?, ?, ?, 'active', '{}', ?, ?)`,
			params: ['race-owner-b', 'race-b@example.com', 'Race Owner B', timestamp, timestamp],
		},
	]);
	const team = await store.createTeam({
		name: `owner-race-${Date.now()}`,
		displayName: 'Owner Race',
		ownerUserId: 'race-owner-a',
	});
	const first = (await store.listTeamMembers(team.id))[0];
	await store.batch([
		{
			query: `INSERT INTO team_memberships (id, team_id, user_id, status, created_at, updated_at)
				VALUES (?, ?, ?, 'active', ?, ?)`,
			params: ['race-membership-b', team.id, 'race-owner-b', timestamp, timestamp],
		},
		{
			query: `INSERT INTO team_role_bindings (id, team_membership_id, role_id, created_at)
				VALUES (?, ?, ?, ?)`,
			params: ['race-binding-b', 'race-membership-b', await store.roleIdForKey('team_owner'), timestamp],
		},
	]);
	return { store, teamId: team.id, firstId: first.id, secondId: 'race-membership-b' };
}

describe('transactional last-owner protection', () => {
	it('rejects stale role and removal mutations without changing membership state', async () => {
		const fixture = await teamWithTwoOwners();
		const role = await fixture.store.updateTeamMemberRole(
			fixture.teamId,
			fixture.secondId,
			'contributor',
			'stale-version',
		);
		const removal = await fixture.store.removeTeamMember(
			fixture.teamId,
			fixture.secondId,
			'stale-version',
		);
		expect(role).toMatchObject({ ok: false, code: 'stale' });
		expect(removal).toMatchObject({ ok: false, code: 'stale' });
		expect((await fixture.store.listTeamMembers(fixture.teamId))
			.find((member) => member.id === fixture.secondId)?.roles).toContain('team_owner');
	});

	it('prevents concurrent owner demotions from leaving a team without an owner', async () => {
		const fixture = await teamWithTwoOwners();
		const results = await Promise.all([
			fixture.store.updateTeamMemberRole(fixture.teamId, fixture.firstId, 'contributor'),
			fixture.store.updateTeamMemberRole(fixture.teamId, fixture.secondId, 'contributor'),
		]);
		const owners = (await fixture.store.listTeamMembers(fixture.teamId))
			.filter((member) => member.roles.includes('team_owner'));
		expect(owners).toHaveLength(1);
		expect(results.filter((result) => result.ok)).toHaveLength(1);
		expect(results.filter((result) => result.code === 'last_owner')).toHaveLength(1);
	});

	it('prevents concurrent owner removals from leaving a team without an owner', async () => {
		const fixture = await teamWithTwoOwners();
		const results = await Promise.all([
			fixture.store.removeTeamMember(fixture.teamId, fixture.firstId),
			fixture.store.removeTeamMember(fixture.teamId, fixture.secondId),
		]);
		const owners = (await fixture.store.listTeamMembers(fixture.teamId))
			.filter((member) => member.roles.includes('team_owner'));
		expect(owners).toHaveLength(1);
		expect(results.filter((result) => result.ok)).toHaveLength(1);
		expect(results.filter((result) => result.code === 'last_owner')).toHaveLength(1);
	});
});
