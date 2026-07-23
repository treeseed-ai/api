import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

describe('market api', () => {
it('launch with TreeSeed managed Cloudflare host records paid hosting metadata', async () => {
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
					slug: 'hosted-with-treeseed-cloudflare',
					name: 'Hosted With TreeSeed Cloudflare',
					sourceKind: 'blank',
					hostingMode: 'managed',
					cloudflareHostMode: 'treeseed_managed',
				}),
			});
			expect(launched.status).toBe(202);
			const launchPayload = await json(launched);
			expect(launchPayload.payload.launchJob.status).toBe('running');
			const projects = await json(await app.request(`/v1/projects?teamId=${team.id}`, {
				headers: { authorization: `Bearer ${token}` },
			}));
			const projectId = projects.payload.find((project: { slug: string }) => project.slug === 'hosted-with-treeseed-cloudflare')?.id;
			expect(projectId).toBeTruthy();
			const details = await json(await app.request(`/v1/projects/${projectId}`, {
				headers: { authorization: `Bearer ${token}` },
			}));
			expect(details.payload.project.metadata.cloudflareHost.mode).toBe('treeseed_managed');
			expect(details.payload.project.metadata.cloudflareHost.billing.fee).toBe('treeseed_cloudflare_hosting');
			expect(details.payload.entitlement.tier).toBe('paid_hosting');
		});
	});
});
