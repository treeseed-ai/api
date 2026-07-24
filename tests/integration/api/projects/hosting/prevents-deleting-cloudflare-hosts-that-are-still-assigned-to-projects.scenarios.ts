import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, Core, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../../support/api-harness.ts';

describe('market api', () => {
it('prevents deleting Cloudflare hosts that are still assigned to projects', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);
		const host = await json(await app.request(`/v1/teams/${team.id}/web-hosts`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				name: 'Team Cloudflare',
				ownership: 'team_owned',
				encryptedPayload: encryptedHostEnvelope(),
			}),
		}));
		await json(await app.request(`/v1/teams/${team.id}/projects`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				slug: 'hosted-project',
				name: 'Hosted Project',
				metadata: {
					cloudflareHost: {
						mode: 'team_owned',
						hostId: host.payload.id,
					},
				},
			}),
		}));

		const deleted = await app.request(`/v1/teams/${team.id}/web-hosts/${host.payload.id}`, {
			method: 'DELETE',
			headers: { authorization: `Bearer ${token}` },
		});
		expect(deleted.status).toBe(409);
		const payload = await json(deleted);
		expect(payload.error).toBe('in_use');
		expect(payload.projects).toEqual([
			expect.objectContaining({ slug: 'hosted-project', name: 'Hosted Project' }),
		]);
	});
});
