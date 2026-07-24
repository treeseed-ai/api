import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, Core, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../support/api-harness.ts';

import { packageRoot } from '../../../support/api-harness.ts';

describe('market api', () => {
it('converts local content write routes into repository platform operations', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const { project } = await createTeamAndProject(app, token, {
			id: 'platform-content-project',
			slug: 'platform-content-project',
			name: 'Platform Content Project',
		});

		const response = await json(await app.request(`/v1/projects/${project.id}/local-content/notes`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				title: 'Queued note',
				summary: 'This should become a platform operation.',
				idempotencyKey: 'note-queued-one',
			}),
		}));

		expect(response.ok).toBe(true);
		expect(response).not.toHaveProperty('payload');
		expect(response.job).toMatchObject({
			namespace: 'repository',
			operation: 'write_content_record',
			status: 'queued',
			input: {
				projectId: project.id,
				collection: 'notes',
				repository: {
					name: 'platform-content-project',
					cloneUrl: packageRoot,
					writeMode: 'workspace',
				},
			},
		});
	});
});
