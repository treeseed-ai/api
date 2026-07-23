import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

describe('market api', () => {
it('exchanges GitHub OIDC for managed operation jobs without exposing provider secrets', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);

		const launched = await json(await app.request(`/v1/teams/${team.id}/projects/launch`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				slug: 'ci-managed-project',
				name: 'CI Managed Project',
				sourceKind: 'blank',
				hostingMode: 'managed',
			}),
		}));
		const projectId = launched.payload.project.project.id as string;
		const details = await json(await app.request(`/v1/projects/${projectId}`, {
			headers: {
				authorization: `Bearer ${token}`,
			},
		}));
		const softwareRepository = details.payload.repositories.find((repository: { role: string }) => repository.role === 'software');
		const repository = `${softwareRepository.owner}/${softwareRepository.name}`.toLowerCase();
		const now = Math.floor(Date.now() / 1000);
		const oidcToken = unsignedTestJwt({
			iss: 'https://token.actions.githubusercontent.com',
			aud: `treeseed:${projectId}`,
			exp: now + 300,
			nbf: now - 10,
			repository,
			ref: 'refs/heads/staging',
			ref_name: 'staging',
			sha: '1234567890abcdef1234567890abcdef12345678',
			workflow: 'Treeseed Web Deploy',
			workflow_ref: `${repository}/.github/workflows/deploy-web.yml@refs/heads/staging`,
			run_id: '1001',
			run_attempt: '1',
			actor: 'octocat',
			event_name: 'push',
		});

		const exchanged = await app.request(`/v1/projects/${projectId}/ci/oidc/exchange`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				oidcToken,
				actionKind: 'deploy_web',
				environment: 'staging',
				sha: '1234567890abcdef1234567890abcdef12345678',
			}),
		});
		expect(exchanged.status).toBe(202);
		const payload = await json(exchanged);
		expect(payload.payload.job).toMatchObject({
			projectId,
			namespace: 'workflow',
			operation: 'deploy_runtime',
			requestedByType: 'ci_oidc',
			requestedById: repository,
		});
		expect(payload.payload.operationToken).toContain('.');
		expect(JSON.stringify(payload)).not.toContain('TREESEED_CLOUDFLARE_API_TOKEN');
		expect(JSON.stringify(payload)).not.toContain('TREESEED_RAILWAY_API_TOKEN');
		expect(JSON.stringify(payload)).not.toContain('TREESEED_SMTP_PASSWORD');

		const status = await app.request(`/v1/projects/${projectId}/ci/jobs/${payload.payload.job.id}`, {
			headers: {
				authorization: `Bearer ${payload.payload.operationToken}`,
			},
		});
		expect(status.status).toBe(200);
		const statusPayload = await json(status);
		expect(statusPayload.payload.job.id).toBe(payload.payload.job.id);
		expect(statusPayload.payload.job.input.managedHostExecution).toMatchObject({
			mode: 'treeseed_managed',
			credentialExposure: 'none',
		});

		const mismatchedToken = unsignedTestJwt({
			iss: 'https://token.actions.githubusercontent.com',
			aud: `treeseed:${projectId}`,
			exp: now + 300,
			repository: 'other-owner/other-repo',
			ref: 'refs/heads/staging',
			workflow_ref: 'other-owner/other-repo/.github/workflows/deploy-web.yml@refs/heads/staging',
		});
		const rejected = await app.request(`/v1/projects/${projectId}/ci/oidc/exchange`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				oidcToken: mismatchedToken,
				actionKind: 'deploy_web',
				environment: 'staging',
			}),
		});
		expect(rejected.status).toBe(403);
	}, 60000);
});
