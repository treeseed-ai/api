import { listTreeseedManagedHostsFromConfig } from '../../../src/market/managed-hosts.ts';
import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

describe('market api', () => {
it('does not read local machine config for remote managed host status', async () => {
		await withEnv({
			TREESEED_LOCAL_DEV_MODE: undefined,
			TREESEED_ENVIRONMENT: 'staging',
			TREESEED_CLOUDFLARE_API_TOKEN: undefined,
			TREESEED_CLOUDFLARE_ACCOUNT_ID: undefined,
			}, async () => {
			const hosts = await listTreeseedManagedHostsFromConfig('team_remote', {
				env: {
					TREESEED_ENVIRONMENT: 'staging',
				},
				});
				expect(hosts.find((host: any) => host.id === 'treeseed-managed-web')?.status).toBe('configuration_required');
				expect(hosts.find((host: any) => host.id === 'treeseed-managed-capacity-provider')).toBeUndefined();
			});
		});
});
