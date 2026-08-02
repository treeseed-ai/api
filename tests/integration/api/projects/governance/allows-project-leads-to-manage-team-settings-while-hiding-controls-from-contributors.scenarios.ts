import { authorizeApp,createTeam,createTestApp,createTestPostgresDatabase,createTestStore,describe,expect,it,json } from '../../../../support/api-harness.ts';

describe('market api', () => {
it('allows project leads to manage team settings while contributors retain read-only directory access', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const ownerToken = await authorizeApp(app);
		const team = await createTeam(app, ownerToken);
		const leadToken = await authorizeApp(app, { principalId: 'team-lead', displayName: 'Team Lead' });
		const contributorToken = await authorizeApp(app, { principalId: 'team-contributor', displayName: 'Team Contributor' });
		await store.upsertTeamMember(team.id, 'team-lead', 'project_lead');
		await store.upsertTeamMember(team.id, 'team-contributor', 'contributor');

		const leadMembers = await json(await app.request(`/v1/teams/${team.id}/members`, {
			headers: { authorization: `Bearer ${leadToken}` },
		}));
		expect(leadMembers.ok).toBe(true);
		const ownerMember = leadMembers.payload.find((entry: { userId: string }) => entry.userId === 'user-1');
		const ownerAliasUpdate = await json(await app.request(`/v1/teams/${team.id}/members/${ownerMember.id}`, {
			method: 'PATCH',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${leadToken}`,
			},
			body: JSON.stringify({ roleKey: 'owner' }),
		}));
		expect(ownerAliasUpdate).toMatchObject({ ok: false, code: 'owner_required' });

		const contributorMembers = await json(await app.request(`/v1/teams/${team.id}/members?q=Team&page=1&limit=25`, {
			headers: { authorization: `Bearer ${contributorToken}` },
		}));
		expect(contributorMembers).toMatchObject({
			ok: true,
			payload: {
				total: 3,
				items: expect.arrayContaining([
					expect.objectContaining({ userId: 'team-lead' }),
					expect.objectContaining({ userId: 'team-contributor' }),
				]),
			},
		});
		const contributorMutation = await app.request(`/v1/teams/${team.id}/members/${ownerMember.id}`, {
			method: 'PATCH',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${contributorToken}`,
			},
			body: JSON.stringify({ roleKey: 'reviewer' }),
		});
		expect(contributorMutation.status).toBe(403);
	});
});
