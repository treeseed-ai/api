import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

describe('market api', () => {
it('gates production seed apply on matching approved requests', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const teamResponse = await app.request('/v1/teams', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ slug: 'treeseed', name: 'TreeSeed' }),
		});
		const team = (await json(teamResponse)).payload;
		await app.request('/v1/seeds/treeseed/apply', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ environments: ['staging'] }),
		});

		const blockedResponse = await app.request('/v1/seeds/treeseed/apply', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ environments: ['prod'] }),
		});
		expect(blockedResponse.status).toBe(409);
		const blocked = await json(blockedResponse);
		expect(blocked.ok).toBe(false);
		expect(blocked.result.blocked).toBe(true);
		expect(blocked.result.approvalRequest).toMatchObject({
			kind: 'seed_production_apply',
			state: 'pending',
		});

		const teamApprovals = await json(await app.request(`/v1/teams/${team.id}/approval-requests?kind=seed_production_apply`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(teamApprovals.payload).toEqual(expect.arrayContaining([
			expect.objectContaining({
				id: blocked.result.approvalRequest.id,
				kind: 'seed_production_apply',
				state: 'pending',
			}),
		]));

		const inbox = await json(await app.request(`/v1/teams/${team.id}/inbox`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(inbox.payload).toEqual(expect.arrayContaining([
			expect.objectContaining({
				href: `/app/work/decisions#approval-${blocked.result.approvalRequest.id}`,
				metadata: expect.objectContaining({
					approvalId: blocked.result.approvalRequest.id,
					approvalKind: 'seed_production_apply',
				}),
			}),
		]));

		const staleResponse = await app.request('/v1/seeds/treeseed/apply', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ environments: ['prod'], approvalRequestId: blocked.result.approvalRequest.id }),
		});
		expect(staleResponse.status).toBe(409);

		const decided = await app.request(`/v1/approval-requests/${blocked.result.approvalRequest.id}/decide`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ state: 'approved' }),
		});
		expect(decided.status).toBe(200);

		const appliedResponse = await app.request('/v1/seeds/treeseed/apply', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ environments: ['prod'], approvalRequestId: blocked.result.approvalRequest.id }),
		});
		expect(appliedResponse.status).toBe(200);
		const applied = await json(appliedResponse);
		expect(applied.ok).toBe(true);
		expect(applied.summary.create).toBe(0);
		expect(applied.summary.update).toBe(0);
		expect(applied.summary.unchanged).toBeGreaterThan(0);
		expect(applied.result.actionCount).toBe(0);
		expect(applied.run).toMatchObject({ state: 'completed', mode: 'apply' });
	});
});
