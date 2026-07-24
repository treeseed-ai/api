import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, Core, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../support/api-harness.ts';

const { runHostingAudit: runHostingAuditMock } = getApiMocks();

describe('market api', () => {
it('audits team hosting readiness without exposing secrets', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);
		const audited = await json(await app.request(`/v1/teams/${team.id}/hosting-audit`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				environment: 'local',
				hostKinds: ['repository'],
			}),
		}));
		expect(audited.ok).toBe(true);
		expect(audited.payload.ok).toBe(true);
		expect(runHostingAuditMock).toHaveBeenCalledWith(expect.objectContaining({
			environment: 'local',
			hostKinds: ['repository'],
			repair: false,
		}));
		expect(JSON.stringify(audited)).not.toContain('secret-token');
	});
});
