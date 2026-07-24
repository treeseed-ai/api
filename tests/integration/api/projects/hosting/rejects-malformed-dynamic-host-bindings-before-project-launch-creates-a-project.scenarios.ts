import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, Core, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../../support/api-harness.ts';

describe('market api', () => {
it('rejects malformed dynamic host bindings before project launch creates a project', async () => {
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
				slug: 'bad-host-bindings',
				name: 'Bad Host Bindings',
				sourceKind: 'template',
				sourceRef: 'research',
				hostingMode: 'managed',
				hostBindings: {
					publicWeb: {
						requirementKind: 'capacity-provider',
						type: 'web',
						provider: 'cloudflare',
					},
				},
			}),
		});
		expect(launched.status).toBe(400);
		const payload = await json(launched);
		expect(payload.code).toBe('invalid_host_bindings');
		expect(payload.error).toContain('unsupported value "capacity-provider"');
		const projects = await json(await app.request(`/v1/projects?teamId=${team.id}`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(projects.payload.some((project: { slug: string }) => project.slug === 'bad-host-bindings')).toBe(false);
	});
});
