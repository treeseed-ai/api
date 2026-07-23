import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

describe('market api', () => {
it('provisions one active team TreeDX binding and exposes mirrors and shares', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);

		const first = await json(await app.request(`/v1/teams/${team.id}/treedx/provision`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ baseUrl: 'https://treedx.team.example' }),
		}));
		expect(first.payload.instance).toMatchObject({
			teamId: team.id,
			provider: 'railway',
			status: 'active',
			baseUrl: 'https://treedx.team.example',
		});

		const second = await json(await app.request(`/v1/teams/${team.id}/treedx`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ baseUrl: 'https://treedx.next.example', status: 'active', provider: 'railway' }),
		}));
		expect(second.payload.instance.id).toBe(first.payload.instance.id);
		expect(second.payload.instance.baseUrl).toBe('https://treedx.next.example');

		const mirror = await json(await app.request(`/v1/teams/${team.id}/treedx/mirrors`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ name: 'Customer mirror', targetKind: 'treedx', targetUrl: 'https://customer.example' }),
		}));
		expect(mirror.payload).toMatchObject({ name: 'Customer mirror', targetUrl: 'https://customer.example' });

		const share = await json(await app.request(`/v1/teams/${team.id}/treedx/shares`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ scope: 'public_federation', publicRead: true }),
		}));
		expect(share.payload).toMatchObject({ scope: 'public_federation', publicRead: true, status: 'active' });

		const status = await json(await app.request(`/v1/teams/${team.id}/treedx`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(status.payload.mirrors).toEqual(expect.arrayContaining([
			expect.objectContaining({ name: 'TreeSeed public registry mirror', targetKind: 'treedx' }),
			expect.objectContaining({ name: 'Customer mirror', targetUrl: 'https://customer.example' }),
		]));
		expect(status.payload.shares).toHaveLength(1);
	});
});
