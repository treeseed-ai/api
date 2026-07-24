import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, Core, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../../support/api-harness.ts';

describe('market api', () => {
it('mints scoped TreeSeed-issued TreeDX tokens for normal project proxy calls', async () => {
		await withEnv({
			TREESEED_TREEDX_JWT_HS256_SECRET: 'test-treedx-signing-secret',
			TREEDX_JWT_HS256_SECRET: undefined,
			TREESEED_TREEDX_ADMIN_TOKEN: 'static-admin-token',
			TREESEED_TREEDX_TOKEN: undefined,
			TREEDX_TOKEN: undefined,
		}, async () => {
			const db = createTestPostgresDatabase();
			const store = createTestStore(db);
			const app = createTestApp({ db, store });
			const token = await authorizeApp(app);
			const { team, project } = await createTeamAndProject(app, token, {
				slug: 'dx-scoped-token',
				name: 'DX Scoped Token',
			});
			await store.upsertTeamTreeDx(team.id, {
				baseUrl: 'http://127.0.0.1:4012',
				status: 'active',
			});
			await store.upsertProjectTreeDxLibrary(project.id, {
				libraryId: 'team-one/dx-scoped-token',
				repositoryId: 'repo_dx_scoped_token',
			});
			const authorizations: string[] = [];
			const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init = {}) => {
				const authorization = init.headers instanceof Headers
					? init.headers.get('authorization')
					: (init.headers as Record<string, string> | undefined)?.authorization;
				if (authorization) authorizations.push(authorization);
				return new Response(JSON.stringify({ ok: true, files: [{ path: 'books/intro.mdx', content: '# Intro' }] }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			});
			const response = await app.request(`/v1/dx/projects/${project.id}/repos/repo_dx_scoped_token/files/read`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
				body: JSON.stringify({ paths: ['books/intro.mdx'] }),
			});
			expect(response.status).toBe(200);
			expect(authorizations).toHaveLength(1);
			expect(authorizations[0]).not.toBe('Bearer static-admin-token');
			const jwt = authorizations[0].replace(/^Bearer\s+/u, '');
			const [, payloadSegment] = jwt.split('.');
			const payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
			expect(payload).toMatchObject({
				aud: 'treedx-local',
				iss: 'https://api.treeseed.local/treedx',
				sub: 'treeseed-api',
				treedx_repo_ids: ['repo_dx_scoped_token'],
				treedx_capabilities: ['files:read'],
				treedx_paths: ['books/intro.mdx'],
				treeseed_project_id: project.id,
			});
			expect(payload.treedx_repo_ids).not.toContain('*');
			expect(payload.treedx_capabilities).not.toContain('policy:write');
			fetchSpy.mockRestore();
		});
	});
});
