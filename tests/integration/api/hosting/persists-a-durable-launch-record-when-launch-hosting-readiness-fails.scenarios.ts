import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, Core, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../support/api-harness.ts';

const { runHostingAudit: runHostingAuditMock } = getApiMocks();

describe('market api', () => {
it('persists a durable launch record when launch hosting readiness fails', async () => {
		await withEnv({
			TREESEED_CLOUDFLARE_API_TOKEN: 'managed-token',
			TREESEED_CLOUDFLARE_ACCOUNT_ID: 'managed-account',
		}, async () => {
			runHostingAuditMock.mockResolvedValueOnce({
				ok: false,
				environment: 'staging',
				requestedEnvironment: 'current',
				repairMode: false,
				repaired: false,
				target: { kind: 'persistent', scope: 'staging', label: 'staging' },
				hostKinds: ['repository', 'web', 'email'],
				checkedAt: '2026-01-01T00:00:00.000Z',
				checks: [],
				missingConfig: ['TREESEED_CLOUDFLARE_ACCOUNT_ID'] as any,
				resources: {},
				warnings: [],
				blockers: [{ code: 'missing_config', message: 'Cloudflare account is missing.' }] as any,
				nextActions: ['Fix hosting configuration.'],
			});
			const app = createTestApp();
			const token = await authorizeApp(app);
			const team = await createTeam(app, token);

			const launched = await app.request(`/v1/teams/${team.id}/projects/launch`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					slug: 'audit-fails-before-persist',
					launchRequestId: '4a4ed9df-79a6-4297-abaa-01c09f3468e1',
					name: 'Audit Fails Before Persist',
					sourceKind: 'template',
					sourceRef: 'research',
					hostingMode: 'managed',
					cloudflareHostMode: 'treeseed_managed',
					emailHostMode: 'treeseed_managed',
					repositoryHostId: 'platform:github:hosted-hubs',
				}),
			});

			expect(launched.status).toBe(202);
			const launchPayload = await json(launched);
			expect(launchPayload.operationId).toBe('4a4ed9df-79a6-4297-abaa-01c09f3468e1');
			expect(launchPayload.deploymentHref).toBe(`/app/projects/deployment/${launchPayload.deploymentId}`);
			expect(launchPayload.payload.launchJob.status).toBe('running');
			const projects = await json(await app.request(`/v1/projects?teamId=${team.id}`, {
				headers: { authorization: `Bearer ${token}` },
			}));
			expect(projects.payload.some((project: { slug: string }) => project.slug === 'audit-fails-before-persist')).toBe(true);
			expect(await waitForCondition(async () => {
				const job = await json(await app.request('/v1/jobs/4a4ed9df-79a6-4297-abaa-01c09f3468e1', {
					headers: { authorization: `Bearer ${token}` },
				}));
				return job.payload.status === 'failed';
			}, 8000)).toBe(true);
			const job = await json(await app.request('/v1/jobs/4a4ed9df-79a6-4297-abaa-01c09f3468e1', {
				headers: { authorization: `Bearer ${token}` },
			}));
			expect(job.payload.status).toBe('failed');
			expect(job.payload.error.code).toBe('hosting_readiness_audit_failed');
			const deploymentDetail = await json(await app.request(`/v1/project-deployments/${launchPayload.deploymentId}`, {
				headers: { authorization: `Bearer ${token}` },
			}));
			expect(deploymentDetail.payload.events).toEqual(expect.arrayContaining([
				expect.objectContaining({
					kind: 'launch.audit_failed',
					payload: expect.objectContaining({
						audit: expect.objectContaining({
							blockers: expect.arrayContaining([expect.objectContaining({ code: 'missing_config' })]),
							missingConfig: expect.arrayContaining(['TREESEED_CLOUDFLARE_ACCOUNT_ID']),
						}),
					}),
				}),
			]));
			const details = await json(await app.request(`/v1/projects/${launchPayload.projectId}`, {
				headers: { authorization: `Bearer ${token}` },
			}));
			expect(details.payload.deployments).toEqual(expect.arrayContaining([
				expect.objectContaining({ environment: 'staging', action: 'launch_project', status: 'failed', platformOperationId: launchPayload.operationId }),
				expect.objectContaining({ environment: 'prod', action: 'launch_project', status: 'failed', platformOperationId: launchPayload.operationId }),
			]));
		});
	});
});
