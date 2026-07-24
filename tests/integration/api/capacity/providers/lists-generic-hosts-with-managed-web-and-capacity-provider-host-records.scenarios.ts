import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, Core, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../../support/api-harness.ts';

describe('market api', () => {
it('lists generic hosts with TreeSeed managed web and capacity provider host records', async () => {
			const app = createTestApp();
			const token = await authorizeApp(app);
			const team = await createTeam(app, token);
			const created = await app.request(`/v1/teams/${team.id}/hosts`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
				body: JSON.stringify({
					name: 'Team Capacity Provider Host',
					provider: 'railway',
					ownership: 'team_owned',
					accountLabel: 'Capacity Provider Workspace',
					allowedEnvironments: ['staging', 'prod'],
					encryptedPayload: encryptedHostEnvelope(),
					metadata: {
						hostType: 'capacity_provider',
						configuredKeys: ['TREESEED_RAILWAY_API_TOKEN', 'TREESEED_RAILWAY_WORKSPACE', 'TREESEED_CAPACITY_PROVIDER_MANIFEST'],
					},
				}),
		});
		expect(created.status).toBe(201);

		const listed = await json(await app.request(`/v1/teams/${team.id}/hosts`, {
			headers: { authorization: `Bearer ${token}` },
		}));
			expect(listed.payload.map((host: any) => host.id)).toEqual(expect.arrayContaining([
				'treeseed-managed-web',
			]));
			expect(listed.payload.find((host: any) => host.name === 'Team Capacity Provider Host')).toMatchObject({
				provider: 'railway',
				ownership: 'team_owned',
				metadata: expect.objectContaining({ hostType: 'capacity_provider' }),
			});
			expect(JSON.stringify(listed)).not.toContain('railway-secret-token');
		});
});
