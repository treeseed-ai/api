import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

describe('market api', () => {
it('enforces deployment governance and audit/redaction boundaries', async () => {
		const { app, store, team, project } = await createDeploymentReadyProject('deployment-governance-project');
		await store.upsertProjectEnvironment(project.id, {
			environment: 'prod',
			deploymentProfile: 'hosted_project',
			baseUrl: 'https://deployment-governance-project.example.com',
			pagesProjectName: 'deployment-governance-project',
		});

		const readOnlyKey = await store.createTeamApiKey(team.id, {
			name: 'Read only deployment key',
			permissions: ['project:read'],
		});
		const noPermissionKey = await store.createTeamApiKey(team.id, {
			name: 'No deployment key',
			permissions: [],
		});
		const apiKeyRead = await app.request(`/v1/projects/${project.id}/deployments`, {
			headers: { authorization: `Bearer ${readOnlyKey.token}` },
		});
		expect(apiKeyRead.status).toBe(200);
		const apiKeyDeniedRead = await app.request(`/v1/projects/${project.id}/deployments`, {
			headers: { authorization: `Bearer ${noPermissionKey.token}` },
		});
		expect(apiKeyDeniedRead.status).toBe(403);

		const contributorToken = await authorizeApp(app, { principalId: 'deployment-contributor', displayName: 'Deployment Contributor' });
		await store.upsertTeamMember(team.id, 'deployment-contributor', 'contributor');
		const contributorDeploy = await app.request(`/v1/projects/${project.id}/deployments/web`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${contributorToken}` },
			body: JSON.stringify({ environment: 'staging', action: 'deploy_web', idempotencyKey: 'contributor-deploy-denied' }),
		});
		expect(contributorDeploy.status).toBe(403);
		expect(await json(contributorDeploy)).toMatchObject({ error: { code: 'not_authorized' } });

		const contributorMonitor = await json(await app.request(`/v1/projects/${project.id}/deployments/web`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${contributorToken}` },
			body: JSON.stringify({ environment: 'staging', action: 'monitor', idempotencyKey: 'contributor-monitor-ok' }),
		}));
		expect(contributorMonitor.deployment).toMatchObject({ action: 'monitor', status: 'queued' });
		const directDeploymentRead = await app.request(`/v1/project-deployments/${contributorMonitor.deployment.id}`, {
			headers: { authorization: `Bearer ${readOnlyKey.token}` },
		});
		expect(directDeploymentRead.status).toBe(200);
		const directDeploymentDenied = await app.request(`/v1/project-deployments/${contributorMonitor.deployment.id}`, {
			headers: { authorization: `Bearer ${noPermissionKey.token}` },
		});
		expect(directDeploymentDenied.status).toBe(403);
		const contributorMonitorRepeat = await json(await app.request(`/v1/projects/${project.id}/deployments/web`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${contributorToken}` },
			body: JSON.stringify({ environment: 'staging', action: 'monitor', idempotencyKey: 'contributor-monitor-ok' }),
		}));
		expect(contributorMonitorRepeat.deployment.id).toBe(contributorMonitor.deployment.id);

		const reviewerToken = await authorizeApp(app, { principalId: 'deployment-reviewer', displayName: 'Deployment Reviewer' });
		await store.upsertTeamMember(team.id, 'deployment-reviewer', 'reviewer');
		const reviewerDeploy = await json(await app.request(`/v1/projects/${project.id}/deployments/web`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${reviewerToken}` },
			body: JSON.stringify({ environment: 'staging', action: 'deploy_web', idempotencyKey: 'reviewer-staging-deploy-ok' }),
		}));
		expect(reviewerDeploy.deployment).toMatchObject({ environment: 'staging', action: 'deploy_web', status: 'queued' });
		const reviewerProduction = await app.request(`/v1/projects/${project.id}/deployments/web`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${reviewerToken}` },
			body: JSON.stringify({ environment: 'prod', action: 'deploy_web', confirmProduction: true, idempotencyKey: 'reviewer-prod-denied' }),
		});
		expect(reviewerProduction.status).toBe(403);

		const leadToken = await authorizeApp(app, { principalId: 'deployment-lead', displayName: 'Deployment Lead' });
		await store.upsertTeamMember(team.id, 'deployment-lead', 'project_lead');
		const productionWithoutConfirmation = await app.request(`/v1/projects/${project.id}/deployments/web`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${leadToken}` },
			body: JSON.stringify({ environment: 'prod', action: 'deploy_web', idempotencyKey: 'lead-prod-no-confirm' }),
		});
		expect(productionWithoutConfirmation.status).toBe(409);
		const productionDeploy = await json(await app.request(`/v1/projects/${project.id}/deployments/web`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${leadToken}` },
			body: JSON.stringify({ environment: 'prod', action: 'deploy_web', confirmProduction: true, idempotencyKey: 'lead-prod-confirmed' }),
		}));
		expect(productionDeploy.deployment).toMatchObject({ environment: 'prod', action: 'deploy_web', status: 'queued' });
		const stagingPublish = await json(await app.request(`/v1/projects/${project.id}/deployments/web`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${leadToken}` },
			body: JSON.stringify({ environment: 'staging', action: 'publish_content', idempotencyKey: 'lead-staging-publish' }),
		}));
		expect(stagingPublish.deployment).toMatchObject({ action: 'publish_content', status: 'queued' });

		const failedDeployment = await store.updateProjectDeployment(reviewerDeploy.deployment.id, { status: 'failed', summary: 'Failed for retry test.' });
		const readOnlyRetry = await app.request(`/v1/projects/${project.id}/deployments/${failedDeployment!.id}/retry`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${readOnlyKey.token}` },
			body: JSON.stringify({ idempotencyKey: 'read-only-retry-denied' }),
		});
		expect(readOnlyRetry.status).toBe(403);
		const retry = await json(await app.request(`/v1/projects/${project.id}/deployments/${failedDeployment!.id}/retry`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${reviewerToken}` },
			body: JSON.stringify({ idempotencyKey: 'reviewer-retry-ok' }),
		}));
		expect(retry.retryDeployment.retryOfDeploymentId).toBe(failedDeployment!.id);
		const resume = await app.request(`/v1/projects/${project.id}/deployments/${failedDeployment!.id}/resume`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${reviewerToken}` },
			body: JSON.stringify({}),
		});
		expect(resume.status).toBe(409);

		const cancelKey = await store.createTeamApiKey(team.id, {
			name: 'Cancel deployment key',
			permissions: ['project:deployment:cancel'],
		});
		const cancelled = await json(await app.request(`/v1/projects/${project.id}/deployments/${contributorMonitor.deployment.id}/cancel`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${cancelKey.token}` },
			body: JSON.stringify({}),
		}));
		expect(cancelled.deployment.status).toBe('cancelled');

		const monitorKey = await store.createTeamApiKey(team.id, {
			name: 'Monitor deployment key',
			permissions: ['project:monitor'],
		});
		const apiKeyMonitor = await json(await app.request(`/v1/projects/${project.id}/deployments/web`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${monitorKey.token}` },
			body: JSON.stringify({ environment: 'prod', action: 'monitor', idempotencyKey: 'api-key-monitor-prod-ok' }),
		}));
		expect(apiKeyMonitor.deployment).toMatchObject({ action: 'monitor', environment: 'prod', status: 'queued' });

		await store.appendProjectDeploymentEvent(productionDeploy.deployment.id, {
			kind: 'deployment.security_probe',
			message: 'Security probe.',
			payload: {
				runnerToken: 'runner-token-secret',
				nested: {
					capacityProviderId: 'capacity-provider-secret',
					apiKey: 'sk-secret-token-value',
				},
			},
		});
		await store.recordAuditEvent({
			eventType: 'security_probe',
			actorType: 'user',
			actorId: 'deployment-lead',
			targetType: 'project',
			targetId: project.id,
			data: {
				runnerToken: 'runner-token-secret',
				capacityProviderId: 'capacity-provider-secret',
				rawProviderResponse: { token: 'secret-token' },
			},
		});
		const deploymentEvents = await store.listProjectDeploymentEvents(productionDeploy.deployment.id);
		const auditEvents = await store.listAuditEventsForTarget('project', project.id, 100);
		const auditTypes = auditEvents.map((event: Record<string, unknown>) => event.eventType);
		expect(auditTypes).toEqual(expect.arrayContaining([
			'project_deployment_requested',
			'project_production_deployment_requested',
			'project_content_publish_requested',
			'project_deployment_retry_requested',
			'project_deployment_resume_requested',
			'project_deployment_cancel_requested',
			'project_deployment_cancelled',
		]));
		const contributorRequestEvents = auditEvents.filter((event: any) => event.eventType === 'project_deployment_requested' && event.data?.deploymentId === contributorMonitor.deployment.id);
		expect(contributorRequestEvents).toHaveLength(1);
		const serialized = JSON.stringify({ deploymentEvents, auditEvents });
		expect(serialized).not.toContain('runner-token-secret');
		expect(serialized).not.toContain('capacity-provider-secret');
		expect(serialized).not.toContain('capacityProviderId');
		expect(serialized).not.toContain('runnerToken');
		expect(serialized).not.toContain('sk-secret-token-value');
	}, 20_000);
});
