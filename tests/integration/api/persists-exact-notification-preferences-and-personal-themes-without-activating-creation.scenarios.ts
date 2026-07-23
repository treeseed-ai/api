import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

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
		const saved = await json(await app.request('/v1/auth/web/notifications/preferences', {
			method: 'PUT', headers,
			body: JSON.stringify({ emailCadence: 'weekly', timeZone: 'America/New_York', globalContentTypes: ['questions', 'notes'], projectOverrides: [{ projectId: project.id, contentTypes: ['decisions'] }] }),
		}));
		expect(saved.payload).toEqual({ emailCadence: 'weekly', timeZone: 'America/New_York', globalContentTypes: ['notes', 'questions'], projectOverrides: [{ projectId: project.id, contentTypes: ['decisions'] }] });

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
	}, 30000);
});
