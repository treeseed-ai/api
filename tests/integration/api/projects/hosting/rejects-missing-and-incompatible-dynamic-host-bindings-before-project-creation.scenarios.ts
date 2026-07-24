import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, Core, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../../support/api-harness.ts';

describe('market api', () => {
it('rejects missing and incompatible dynamic host bindings before project creation', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);

		for (const [slug, hostBinding, message] of [
			['missing-public-web-host', {
				requirementKind: 'host',
				type: 'web',
				provider: 'cloudflare',
				mode: 'team_owned',
			}, /publicWeb is required/u],
			['incompatible-public-web-host', {
				requirementKind: 'host',
				type: 'web',
				provider: 'smtp',
				mode: 'treeseed_managed',
			}, /requires provider cloudflare/u],
		] as const) {
			const launched = await app.request(`/v1/teams/${team.id}/projects/launch`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					slug,
					name: slug,
					sourceKind: 'template',
					sourceRef: 'research',
					hostingMode: 'managed',
					hostBindings: {
						publicWeb: hostBinding,
					},
				}),
			});
			expect(launched.status).toBe(400);
			const payload = await json(launched);
			expect(payload.code).toBe('invalid_host_bindings');
			expect(payload.error).toMatch(message);
		}
		const projects = await json(await app.request(`/v1/projects?teamId=${team.id}`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(projects.payload.some((project: { slug: string }) => project.slug === 'missing-public-web-host' || project.slug === 'incompatible-public-web-host')).toBe(false);
	}, 15_000);
});
