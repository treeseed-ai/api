import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

describe('market api', () => {
it('signs editorial preview links for team-scoped overlays', async () => {
		const app = createTestApp({
			config: {
				baseUrl: 'https://market.example.com',
			},
		});
		const token = await authorizeApp(app);
		const { team } = await createTeamAndProject(app, token, {
			id: 'preview-project',
			slug: 'preview-project',
			name: 'Preview Project',
		});

		const response = await json(await app.request(`/v1/teams/${team.id}/content-previews`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				previewId: 'staging-abc123',
				expiresAt: '2030-01-01T00:00:00.000Z',
			}),
		}));

		expect(response.payload).toMatchObject({
			teamId: team.id,
			previewId: 'staging-abc123',
		});
		expect(response.payload.token).toContain('.');
		expect(response.payload.previewUrl).toContain('?preview=');
	});
});
