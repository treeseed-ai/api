import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

describe('market api', () => {
it('scopes project slug uniqueness to a team', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const token = await authorizeApp(app);
		const headers = {
			'content-type': 'application/json',
			authorization: `Bearer ${token}`,
		};
		const firstTeam = await json(await app.request('/v1/teams', {
			method: 'POST',
			headers,
			body: JSON.stringify({ slug: 'slug-team-one', name: 'Slug Team One' }),
		}));
		const secondTeam = await json(await app.request('/v1/teams', {
			method: 'POST',
			headers,
			body: JSON.stringify({ slug: 'slug-team-two', name: 'Slug Team Two' }),
		}));

		const firstProject = await json(await app.request(`/v1/teams/${firstTeam.payload.id}/projects`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ slug: 'shared-slug', name: 'Shared Slug One' }),
		}));
		const secondProject = await json(await app.request(`/v1/teams/${secondTeam.payload.id}/projects`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ slug: 'shared-slug', name: 'Shared Slug Two' }),
		}));
		expect(firstProject.ok).toBe(true);
		expect(secondProject.ok).toBe(true);
		expect(firstProject.payload.project.teamId).toBe(firstTeam.payload.id);
		expect(secondProject.payload.project.teamId).toBe(secondTeam.payload.id);

		const duplicate = await json(await app.request(`/v1/teams/${firstTeam.payload.id}/projects`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ slug: 'shared-slug', name: 'Duplicate Shared Slug' }),
		}));
		expect(duplicate.ok).toBe(false);
		expect(duplicate.code).toBe('slug_taken');
	});
});
