import { encryptHostConfig } from '../../../src/crypto/host-crypto.ts';
import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

describe('market api', () => {
it('creates repository credential sessions from real secretbox envelopes in the API runtime', async () => {
		await withEnv({
			NODE_ENV: undefined,
			TREESEED_LOCAL_DEV_MODE: undefined,
			TREESEED_CREDENTIAL_SESSION_SECRET: undefined,
			TREESEED_ENVIRONMENT: 'local',
		}, async () => {
			const app = createTestApp({ config: { environment: 'local' } });
			const token = await authorizeApp(app);
			const team = await createTeam(app, token);
			const passphrase = 'api runtime passphrase';
			const encryptedPayload = await encryptHostConfig({
				TREESEED_GITHUB_TOKEN: 'ghp_runtime_test',
				organizationOrOwner: 'example-org',
				owner: 'example-org',
			}, passphrase, { opsLimit: 2, memLimit: 8192 });

			const host = await json(await app.request(`/v1/teams/${team.id}/repository-hosts`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					name: 'Runtime GitHub Host',
					organizationOrOwner: 'example-org',
					ownership: 'team_owned',
					encryptedPayload,
				}),
			}));
			expect(host.ok).toBe(true);

			const session = await json(await app.request(`/v1/teams/${team.id}/provider-credential-sessions`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					hostKind: 'repository_host',
					hostId: host.payload.id,
					passphrase,
					purpose: 'launch_project',
				}),
			}));
			expect(session.ok).toBe(true);
			expect(session.payload.hostKind).toBe('repository_host');
			expect(JSON.stringify(session)).not.toContain('ghp_runtime_test');
		});
	});
});
