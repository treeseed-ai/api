import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

describe('market api', () => {
it('does not proxy normal TreeDX project calls with static admin tokens or implicit local secrets', async () => {
		await withEnv({
			TREESEED_TREEDX_JWT_HS256_SECRET: undefined,
			TREEDX_JWT_HS256_SECRET: undefined,
			TREESEED_TREEDX_ADMIN_TOKEN: 'static-admin-token',
			TREESEED_TREEDX_TOKEN: 'static-general-token',
			TREEDX_TOKEN: 'static-legacy-token',
		}, async () => {
			const db = createTestPostgresDatabase();
			const store = createTestStore(db);
			const app = createTestApp({ db, store });
			const token = await authorizeApp(app);
			const { team, project } = await createTeamAndProject(app, token, {
				slug: 'dx-static-token-block',
				name: 'DX Static Token Block',
			});
			await store.upsertTeamTreeDx(team.id, {
				baseUrl: 'http://127.0.0.1:4011',
				status: 'active',
			});
			await store.upsertProjectTreeDxLibrary(project.id, {
				libraryId: 'team-one/dx-static-token-block',
				repositoryId: 'repo_dx_static_token_block',
			});
			const fetchSpy = vi.spyOn(globalThis, 'fetch');
			const response = await app.request(`/v1/dx/projects/${project.id}/repos/repo_dx_static_token_block/files/read`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
				body: JSON.stringify({ paths: ['books/intro.mdx'] }),
			});
			expect(response.status).toBe(503);
			expect(await json(response)).toMatchObject({
				ok: false,
				error: 'TreeDX proxy token is not configured for this project.',
			});
			expect(fetchSpy).not.toHaveBeenCalled();
			fetchSpy.mockRestore();
		});
	});
});
