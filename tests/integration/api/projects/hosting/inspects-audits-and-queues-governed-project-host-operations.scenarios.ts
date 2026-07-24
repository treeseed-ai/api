import { PlatformRunnerClient } from '@treeseed/sdk';
import { runOnceWithClient } from '../../../../../src/operations-runner/entrypoint.ts';
import { rmSync } from 'node:fs';
import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, tmpdir, Core, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../../support/api-harness.ts';

describe('market api', () => {
it('inspects, audits, and queues governed project host operations', async () => {
		await withEnv({
			TREESEED_CLOUDFLARE_API_TOKEN: 'managed-token',
			TREESEED_CLOUDFLARE_ACCOUNT_ID: 'managed-account',
		}, async () => {
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

			const launched = await app.request(`/v1/teams/${team.id}/projects/launch`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					slug: 'host-ops-project',
					name: 'Host Ops Project',
					sourceKind: 'template',
					sourceRef: 'research',
					hostingMode: 'managed',
					hostBindings: {
						sourceRepository: {
							requirementKind: 'host',
							type: 'repository',
							provider: 'github',
							hostId: 'platform:github:hosted-hubs',
							mode: 'treeseed_managed',
						},
						publicWeb: {
							requirementKind: 'host',
							type: 'web',
							provider: 'cloudflare',
							managedHostKey: 'treeseed-managed-cloudflare',
							mode: 'treeseed_managed',
						},
					},
				}),
			});
			expect(launched.status).toBe(202);
			const launchedPayload = await json(launched);
			const projectId = launchedPayload.projectId;

			const inspected = await json(await app.request(`/v1/projects/${projectId}/hosts`, {
				headers: { authorization: `Bearer ${token}` },
			}));
			expect(inspected.payload.view.requirements.map((entry: { requirementKey: string }) => entry.requirementKey)).toEqual([
				'sourceRepository',
				'publicWeb',
				'transactionalEmail',
			]);
			expect(inspected.payload.view.requirements.find((entry: { requirementKey: string }) => entry.requirementKey === 'publicWeb')).toMatchObject({
				audit: expect.objectContaining({
					marketHostId: expect.any(String),
					repositoryConfig: 'planned',
				}),
			});
			const fixture = createRunnerRepoFixture();
			await store.upsertHubRepository(projectId, {
				role: 'software',
				provider: 'local',
				owner: 'fixture',
				name: 'host-ops-project',
				url: fixture.repo,
				defaultBranch: 'staging',
				status: 'active',
			});

			const invalid = await app.request(`/v1/projects/${projectId}/hosts/publicWeb/replace`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					hostBinding: {
						requirementKind: 'host',
						type: 'email',
						provider: 'smtp',
						hostId: 'smtp-host-1',
					},
				}),
			});
			expect(invalid.status).toBe(400);
			expect((await json(invalid)).code).toBe('invalid_host_binding_operation');

			const audited = await app.request(`/v1/projects/${projectId}/hosts/audit`, {
				method: 'POST',
				headers: { authorization: `Bearer ${token}` },
			});
			expect(audited.status).toBe(202);
			const auditPayload = await json(audited);
			expect(auditPayload.operation).toMatchObject({
				namespace: 'project_hosts',
				operation: 'host_binding_audit',
				status: 'queued',
			});
			expect(auditPayload.payload.view.summary.status).toBe('ok');
			try {
				await withHttpMarketApp(app, async (baseUrl) => {
					const client = new PlatformRunnerClient({
						marketUrl: baseUrl,
						marketId: 'local',
						runnerSecret: 'platform-runner-secret',
					});
					const result = await runOnceWithClient({
						runnerId: 'treeseed-ops-host-runner-01',
						environment: 'staging',
						dataDir: fixture.workspace,
					}, client, 'test', {
						deploymentStore: store,
						operationKey: 'project_hosts:host_binding_audit',
					});
					expect(result).toMatchObject({
						ok: true,
						claimed: true,
						operation: expect.objectContaining({
							id: auditPayload.operation.id,
							status: 'succeeded',
						}),
					});
				});
				const completedAudit = await store.findPlatformOperationById(auditPayload.operation.id);
				expect(completedAudit?.status).toBe('succeeded');
				expect(completedAudit?.output?.hostBindingPlans?.secretDeployment?.items).toEqual(expect.any(Array));
				const afterAudit = await store.getProjectDetails(projectId);
				expect(afterAudit?.project.metadata.hostBindingPlans.secretDeployment.items).toEqual(expect.any(Array));
				expect(afterAudit?.project.metadata.hostBindingSecretSync).toBeNull();
				expect(JSON.stringify(afterAudit?.project.metadata)).not.toContain('managed-token');
			} finally {
				rmSync(fixture.root, { recursive: true, force: true });
			}

			const replaced = await app.request(`/v1/projects/${projectId}/hosts/publicWeb/replace`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					hostBinding: {
						requirementKind: 'host',
						type: 'web',
						provider: 'cloudflare',
						managedHostKey: 'treeseed-managed-cloudflare',
						mode: 'treeseed_managed',
					},
				}),
			});
			expect(replaced.status).toBe(202);
			const replacePayload = await json(replaced);
			expect(replacePayload.operation).toMatchObject({
				namespace: 'project_hosts',
				operation: 'host_binding_replace',
				status: 'queued',
			});
			expect(JSON.stringify(replacePayload)).not.toContain('managed-token');
			const details = await json(await app.request(`/v1/projects/${projectId}`, {
				headers: { authorization: `Bearer ${token}` },
			}));
			expect(details.payload.project.metadata.lastHostOperation).toMatchObject({
				kind: 'replace',
				requirementKey: 'publicWeb',
			});
			expect(details.payload.project.metadata.hostBindingAudit.summary.status).toBe('ok');
		});
	}, 20_000);
});
