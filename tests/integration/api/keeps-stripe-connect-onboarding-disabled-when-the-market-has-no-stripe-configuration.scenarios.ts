import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

describe('market api', () => {
it('keeps Stripe Connect onboarding disabled when the market has no Stripe configuration', async () => {
		const app = createTestApp();
		const seeded = await json(await app.request('/v1/acceptance/seed', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-treeseed-service-id': 'web',
				'x-treeseed-service-secret': 'web-test-secret',
			},
			body: JSON.stringify({ namespace: 'commerce-phase-3-unconfigured' }),
		}));
		const team = seeded.payload.fixtures.team;
		const ownerToken = seeded.payload.actors.teamOwner.accessToken;
		const adminToken = seeded.payload.actors.marketSteward.accessToken;

		const vendor = await json(await app.request(`/v1/commerce/vendors/${team.id}/request`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({ displayName: 'Unconfigured Stripe Vendor' }),
		}));
		await app.request(`/v1/commerce/vendors/${vendor.payload.id}/approve`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${adminToken}`,
			},
			body: JSON.stringify({ trustLevel: 'verified_seller', salesEnabled: true }),
		});

		const status = await json(await app.request(`/v1/commerce/vendors/${team.id}/stripe/status`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(status.payload).toBeNull();

		const response = await app.request(`/v1/commerce/vendors/${team.id}/stripe/onboarding`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({}),
		});
		expect(response.status).toBe(409);
		const payload = await json(response);
		expect(payload.error).toContain('Stripe Connect is not configured');
	}, 15_000);
});
