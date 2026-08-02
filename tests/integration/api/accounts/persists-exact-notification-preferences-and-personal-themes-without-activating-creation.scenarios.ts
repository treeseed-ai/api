import { authorizeApp,createTeamAndProject,createTestApp,createTestPostgresDatabase,createTestStore,describe,expect,it,json } from '../../../support/api-harness.ts';

describe('market api', () => {
it('persists exact notification preferences and personal themes without activating creation', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const token = await authorizeApp(app, { principalId: 'account-redesign-user', displayName: 'Account Redesign User' });
		const { project } = await createTeamAndProject(app, token, { slug: 'account-redesign', name: 'Account Redesign', description: 'Account slice test.' });
		const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
		const initial = await json(await app.request('/v1/auth/web/notifications/preferences', { headers }));
		expect(initial.payload).toMatchObject({ emailCadence: 'daily', globalContentTypes: [], projectOverrides: [] });
		const accountPreferences = await json(await app.request('/v1/auth/web/preferences', {
			method: 'PATCH', headers,
			body: JSON.stringify({ timeZone: 'America/New_York' }),
		}));
		expect(accountPreferences.payload).toEqual({ timeZone: 'America/New_York' });
		expect((await json(await app.request('/v1/auth/web/preferences', { headers }))).payload).toEqual({ timeZone: 'America/New_York' });
		const invalidPreferences = await json(await app.request('/v1/auth/web/preferences', {
			method: 'PATCH', headers,
			body: JSON.stringify({ timeZone: 'Not/A_Time_Zone' }),
		}));
		expect(invalidPreferences).toMatchObject({ ok: false, code: 'invalid_time_zone' });
		const saved = await json(await app.request('/v1/auth/web/notifications/preferences', {
			method: 'PUT', headers,
			body: JSON.stringify({ emailCadence: 'weekly', globalContentTypes: ['questions', 'notes'], projectOverrides: [{ projectId: project.id, contentTypes: ['decisions'] }] }),
		}));
		expect(saved.payload).toEqual({ emailCadence: 'weekly', globalContentTypes: ['notes', 'questions'], projectOverrides: [{ projectId: project.id, contentTypes: ['decisions'] }] });

		const created = await json(await app.request('/v1/auth/web/themes', {
			method: 'POST', headers,
			body: JSON.stringify({ name: 'Research dusk', baseScheme: 'fern', palette: {
				light: { canvas: '#ffffff', surface: '#f5f5f5', text: '#111111', accent: '#176b45' },
				dark: { canvas: '#101510', surface: '#182018', text: '#f5fff5', accent: '#69d69a' },
			} }),
		}));
		expect(created.ok).toBe(true);
		expect(created.payload.schemeId).toBe(`personal-${created.payload.id}`);
		const identity = await json(await app.request('/v1/auth/web/account/identity', { headers }));
		expect(identity.payload).not.toHaveProperty('appearance.scheme', created.payload.schemeId);
		const themes = await json(await app.request('/v1/auth/web/themes', { headers }));
		expect(themes.payload).toContainEqual(expect.objectContaining({ id: created.payload.id, name: 'Research dusk' }));

		const activated = await json(await app.request('/v1/auth/web/appearance', {
			method: 'PATCH', headers,
			body: JSON.stringify({ colorScheme: created.payload.schemeId, themeMode: 'dark' }),
		}));
		expect(activated).toMatchObject({
			ok: true,
			payload: {
				scheme: created.payload.schemeId,
				mode: 'dark',
				principal: { metadata: { appearance: { scheme: created.payload.schemeId, mode: 'dark' } } },
			},
		});
		const activatedHeaders = { authorization: `Bearer ${activated.payload.accessToken}` };
		expect((await json(await app.request('/v1/auth/web/appearance', { headers: activatedHeaders }))).payload).toEqual({
			scheme: created.payload.schemeId,
			mode: 'dark',
		});
		expect(await json(await app.request('/v1/auth/web/appearance', {
			method: 'PATCH', headers: { ...headers, authorization: `Bearer ${token}` },
			body: JSON.stringify({ colorScheme: 'personal-not-owned', themeMode: 'dark' }),
		}))).toMatchObject({ ok: false });
	}, 30000);
});
