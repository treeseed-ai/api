import { PlatformRunnerClient } from '@treeseed/sdk';
import { runOnceWithClient } from '../../../../../src/operations-runner/entrypoint.ts';
import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, tmpdir, Core, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../../support/api-harness.ts';

import { packageRoot } from '../../../../support/api-harness.ts';

describe('market api', () => {
it('runs TreeDX provisioning through Railway project, service, volume, variable, domain, and deploy adapters', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({
			db,
			store,
			config: {
				platformRunnerSecret: 'platform-runner-secret',
			},
		});
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);
		const queued = await json(await app.request(`/v1/teams/${team.id}/treedx/provision`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ publicRead: true, imageRef: 'treeseed/treedx:0.1.0' }),
		}));
		const calls: string[] = [];
		const railwaySecretValues: string[] = [];
		const fakeRailway = {
			ensureProject: vi.fn(async ({ projectName }: any) => {
				calls.push(`project:${projectName}`);
				return { workspace: { id: 'workspace-1' }, project: { id: 'railway-project-1', name: projectName }, created: true };
			}),
			ensureEnvironment: vi.fn(async ({ environmentName }: any) => {
				calls.push(`environment:${environmentName}`);
				return { environment: { id: 'railway-environment-1', name: environmentName }, created: false };
			}),
			ensureService: vi.fn(async ({ serviceName, imageRef }: any) => {
				calls.push(`service:${serviceName}:${imageRef}`);
				return { service: { id: 'railway-service-1', name: serviceName }, created: true };
			}),
			listVariables: vi.fn(async () => ({})),
			upsertVariables: vi.fn(async ({ variables }: any) => {
				calls.push(`variables:${Object.keys(variables).sort().join(',')}`);
				if (typeof variables.TREESEED_TREEDX_SECRET_KEY_BASE === 'string') {
					railwaySecretValues.push(variables.TREESEED_TREEDX_SECRET_KEY_BASE);
				}
				return { variables, changed: true };
			}),
			ensureServiceInstanceConfiguration: vi.fn(async () => {
				calls.push('instance-config');
				return { instance: { id: 'service-instance-1' }, updated: true };
			}),
			ensureServiceVolume: vi.fn(async () => {
				calls.push('volume:/data');
				return { volume: { id: 'volume-1', name: 'public-treedx-node-01-volume' }, instance: { id: 'volume-instance-1' }, created: true, updated: false };
			}),
			ensureGeneratedServiceDomain: vi.fn(async () => {
				calls.push('domain');
				return { domain: { id: 'domain-1', domain: 'treedx-public-staging.up.railway.app' }, created: true };
			}),
			deployServiceInstance: vi.fn(async () => {
				calls.push('deploy');
				return { deploymentId: 'railway-deployment-1' };
			}),
		};

		await withEnv({ TREESEED_PUBLIC_TREEDX_RAILWAY_PROJECT_NAME: 'treeseed-api' }, async () => {
			await withHttpMarketApp(app, async (baseUrl) => {
				const client = new PlatformRunnerClient({
					marketUrl: baseUrl,
					marketId: 'local',
					runnerSecret: 'platform-runner-secret',
				});
				const result = await runOnceWithClient({
					runnerId: 'treeseed-ops-treedx-runner-01',
					environment: 'staging',
					dataDir: packageRoot,
				}, client, 'test', {
					deploymentStore: store,
					operationKey: 'treedx:provision',
					config: { environment: 'staging' },
					railway: fakeRailway,
				});
				expect(result).toMatchObject({
					ok: true,
					claimed: true,
					output: {
						ok: true,
						baseUrl: 'https://treedx-public-staging.up.railway.app',
					},
				});
			});
		});

		expect(calls).toEqual(expect.arrayContaining([
			'project:treeseed-api',
			'environment:staging',
			'service:public-treedx-node-01:treeseed/treedx:0.1.0',
			'variables:PHX_HOST,PHX_SERVER,PORT,TREESEED_TREEDX_DATA_DIR,TREESEED_TREEDX_FEDERATION_MODE,TREESEED_TREEDX_SCOPE,TREESEED_TREEDX_SECRET_KEY_BASE',
			'instance-config',
			'volume:/data',
			'domain',
			'deploy',
		]));
		const status = await store.getTeamTreeDx(team.id);
		expect(status.instance).toMatchObject({
			id: queued.payload.instance.id,
			kind: 'managed_public_federation',
			provider: 'railway',
			status: 'active',
			publicRead: true,
			baseUrl: 'https://treedx-public-staging.up.railway.app',
			railwayProjectId: 'railway-project-1',
			railwayServiceId: 'railway-service-1',
			railwayEnvironmentId: 'railway-environment-1',
			volumeMountPath: '/data',
		});
		expect(railwaySecretValues).toHaveLength(1);
		expect(JSON.stringify(status)).not.toContain(railwaySecretValues[0]);

		const idempotent = await store.provisionTeamTreeDx(team.id, { publicRead: true, imageRef: 'treeseed/treedx:0.1.0' });
		expect(idempotent?.instance).toMatchObject({
			id: queued.payload.instance.id,
			status: 'active',
			baseUrl: 'https://treedx-public-staging.up.railway.app',
			railwayProjectId: 'railway-project-1',
			railwayServiceId: 'railway-service-1',
		});
	});
});
