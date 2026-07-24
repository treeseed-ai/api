import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, Core, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../support/api-harness.ts';

describe('market api', () => {
it('launches with dynamic host bindings and records the binding snapshot', async () => {
		await withEnv({
			TREESEED_CLOUDFLARE_API_TOKEN: 'managed-token',
			TREESEED_CLOUDFLARE_ACCOUNT_ID: 'managed-account',
		}, async () => {
			const app = createTestApp();
			const token = await authorizeApp(app);
			const team = await createTeam(app, token);

			const launched = await app.request(`/v1/teams/${team.id}/projects/launch`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					slug: 'dynamic-host-bindings',
					name: 'Dynamic Host Bindings',
					sourceKind: 'template',
					sourceRef: 'research',
					hostingMode: 'managed',
					hostBindings: {
						sourceRepository: {
							requirementKind: 'host',
							type: 'repository',
							provider: 'github',
							hostId: 'platform:github:hosted-hubs',
							mode: 'treeseed_managed',
						},
						publicWeb: {
							requirementKind: 'host',
							type: 'web',
							provider: 'cloudflare',
							managedHostKey: 'treeseed-managed-cloudflare',
							mode: 'treeseed_managed',
						},
						transactionalEmail: {
							requirementKind: 'host',
							type: 'email',
							provider: 'smtp',
							managedHostKey: 'treeseed-managed-email',
							mode: 'treeseed_managed',
						},
					},
				}),
			});
			expect(launched.status).toBe(202);
			const payload = await json(launched);
			expect(payload.payload.project.project.metadata.templateLineage).toEqual([
				expect.objectContaining({ kind: 'template', ref: 'research' }),
			]);
			expect(payload.payload.project.project.metadata.hostBindings).toMatchObject({
				sourceRepository: expect.objectContaining({ provider: 'github', provenance: expect.objectContaining({ selectedBy: 'managed-default' }) }),
				publicWeb: expect.objectContaining({ provider: 'cloudflare', managedHostKey: expect.any(String) }),
				transactionalEmail: expect.objectContaining({ provider: 'smtp', managedHostKey: expect.any(String) }),
			});
			expect(payload.payload.launchJob.input.hostBindings.publicWeb.provider).toBe('cloudflare');
			expect(JSON.stringify(payload)).not.toContain('managed-token');
		});
	});
});
