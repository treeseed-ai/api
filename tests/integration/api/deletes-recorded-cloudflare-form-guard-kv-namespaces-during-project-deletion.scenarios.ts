import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

describe('market api', () => {
it('deletes recorded Cloudflare form guard KV namespaces during project deletion', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const token = await authorizeApp(app);
		const { team, project } = await createTeamAndProject(app, token, {
			slug: 'delete-form-guard-kv',
			name: 'Delete Form Guard KV',
			metadata: {
				cloudflareHost: {
					mode: 'team_owned',
					hostId: 'web-host-delete-kv',
				},
			},
		});
		await store.createTeamWebHost(team.id, {
			id: 'web-host-delete-kv',
			name: 'Delete KV Cloudflare',
			provider: 'cloudflare',
			ownership: 'team_owned',
			encryptedPayload: encryptedTestHostEnvelope({ TREESEED_CLOUDFLARE_API_TOKEN: 'cloudflare-token', TREESEED_CLOUDFLARE_ACCOUNT_ID: 'account-1' }, 'pass'),
			metadata: {},
		});
		await store.upsertProjectInfrastructureResource(project.id, {
			environment: 'staging',
			provider: 'cloudflare',
			resourceKind: 'kv',
			logicalName: 'form_guard',
			locator: 'kv-form-guard-id',
			metadata: {
				id: 'kv-form-guard-id',
				name: 'delete-form-guard-kv-namespace',
				binding: 'FORM_GUARD_KV',
			},
		});
		await store.upsertProjectInfrastructureResource(project.id, {
			environment: 'staging',
			provider: 'cloudflare',
			resourceKind: 'turnstile-widget',
			logicalName: 'form_guard_turnstile',
			locator: 'turnstile-sitekey-2',
			metadata: {
				sitekey: 'turnstile-sitekey-2',
				name: 'delete-form-guard-turnstile',
				mode: 'managed',
			},
		});
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
			const url = String(input);
			const method = String(init.method ?? 'GET').toUpperCase();
			if (url.includes('/storage/kv/namespaces/kv-form-guard-id') && method === 'DELETE') {
				return new Response(JSON.stringify({ success: true, result: { id: 'kv-form-guard-id' } }), { status: 200 });
			}
			if (url.includes('/challenges/widgets/turnstile-sitekey-2') && method === 'DELETE') {
				return new Response(JSON.stringify({ success: true, result: { sitekey: 'turnstile-sitekey-2' } }), { status: 200 });
			}
			return new Response(JSON.stringify({ success: true, result: [] }), { status: 200 });
		});
		const started = await json(await app.request(`/v1/projects/${project.id}`, {
			method: 'DELETE',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ confirmation: 'DELETE delete-form-guard-kv', sensitivePassphrase: 'pass' }),
		}));
		expect(started.ok).toBe(false);
		expect(started.code).toBe('sensitive_passphrase_rejected');
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
