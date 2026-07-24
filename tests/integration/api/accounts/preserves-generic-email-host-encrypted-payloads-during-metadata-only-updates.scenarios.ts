import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, Core, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../support/api-harness.ts';

describe('market api', () => {
it('preserves generic email host encrypted payloads during metadata-only updates', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);
		const created = await json(await app.request(`/v1/teams/${team.id}/hosts`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				name: 'Team SMTP',
				provider: 'smtp',
				ownership: 'team_owned',
				accountLabel: 'Example Mail',
				encryptedPayload: encryptedHostEnvelope(),
				metadata: { hostType: 'email' },
			}),
		}));
		expect(created.payload.encryptedPayload.ciphertext).toBe('Y2lwaGVydGV4dA==');

		const updated = await json(await app.request(`/v1/teams/${team.id}/hosts/${created.payload.id}`, {
			method: 'PUT',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				name: 'Team SMTP Renamed',
				metadata: { hostType: 'email', purpose: 'transactional' },
			}),
		}));
		expect(updated.payload.name).toBe('Team SMTP Renamed');
		expect(updated.payload.accountLabel).toBe('Example Mail');
		expect(updated.payload.metadata).toMatchObject({ hostType: 'email', purpose: 'transactional' });
		expect(updated.payload.encryptedPayload.ciphertext).toBe('Y2lwaGVydGV4dA==');
	});
});
