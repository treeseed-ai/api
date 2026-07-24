import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, Core, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../../support/api-harness.ts';

describe('market api', () => {
it('automatically provisions private TreeDX and central public mirror trust for private teams', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app, { principalId: 'private-owner' });
		const team = await json(await app.request('/v1/teams', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ slug: 'private-demo-team', name: 'Private Demo Team' }),
		}));
		expect(team.payload.metadata).toMatchObject({
			visibility: 'private',
			privateTreeDx: true,
		});

		const treedx = await json(await app.request(`/v1/teams/${team.payload.id}/treedx`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(treedx.payload.instance).toMatchObject({
			kind: 'managed_private',
			publicRead: false,
			registryUrl: 'https://api.treeseed.dev/treedx',
			metadata: expect.objectContaining({
				automaticPrivateTeamTreeDx: true,
				centralPublicRegistry: expect.objectContaining({
					trustMode: 'scoped_node_token',
					mirrorAllowed: true,
					queryDelegationAllowed: true,
				}),
			}),
		});
		expect(treedx.payload.mirrors).toEqual(expect.arrayContaining([
			expect.objectContaining({
				name: 'TreeSeed public registry mirror',
				direction: 'pull',
				targetKind: 'treedx',
				targetUrl: 'https://api.treeseed.dev/treedx',
				metadata: expect.objectContaining({
					centralPublicRegistry: true,
					privateDataEgress: 'deny_by_default',
				}),
			}),
		]));
	});
});
