import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

describe('market api', () => {
it('updates project profile settings through the project API', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const token = await authorizeApp(app);
		const { team, project } = await createTeamAndProject(app, token, {
			slug: 'settings-before',
			name: 'Settings Before',
			description: 'Before description',
		});
		const headers = {
			'content-type': 'application/json',
			authorization: `Bearer ${token}`,
		};

		const updated = await json(await app.request(`/v1/projects/${project.id}`, {
			method: 'PUT',
			headers,
			body: JSON.stringify({
				slug: 'settings-after',
				name: 'Settings After',
				description: 'After description',
			}),
		}));
		expect(updated.ok).toBe(true);
		expect(updated.payload.project.slug).toBe('settings-after');
		expect(updated.payload.project.name).toBe('Settings After');

		const listed = await json(await app.request(`/v1/projects?teamId=${team.id}`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(listed.payload.find((entry: { id: string }) => entry.id === project.id)?.slug).toBe('settings-after');

		const duplicate = await json(await app.request(`/v1/teams/${team.id}/projects`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ slug: 'taken-project', name: 'Taken Project' }),
		}));
		const rejected = await json(await app.request(`/v1/projects/${duplicate.payload.project.id}`, {
			method: 'PUT',
			headers,
			body: JSON.stringify({
				slug: 'settings-after',
				name: 'Taken Project',
			}),
		}));
		expect(rejected.ok).toBe(false);
		expect(rejected.code).toBe('slug_taken');
	});
});
