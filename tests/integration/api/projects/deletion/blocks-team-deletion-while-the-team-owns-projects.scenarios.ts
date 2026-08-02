import { authorizeApp,createTeam,createTestApp,describe,expect,it,json } from '../../../../support/api-harness.ts';

describe('market api', () => {
it('blocks team deletion while the team owns projects', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);
		await json(await app.request(`/v1/teams/${team.id}/projects`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				slug: 'owned-project',
				name: 'Owned Project',
			}),
		}));
		const blocked = await json(await app.request(`/v1/teams/${team.id}/deletion-readiness`, {
			headers: {
				authorization: `Bearer ${token}`,
			},
		}));
		expect(blocked).toMatchObject({ ok: true, ready: false });
		expect(blocked.blockers.some((entry: { code: string }) => entry.code === 'project')).toBe(true);
	});
});
