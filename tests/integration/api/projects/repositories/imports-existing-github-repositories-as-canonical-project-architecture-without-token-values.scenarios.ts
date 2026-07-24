import * as Core from '@treeseed/sdk';
import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../../support/api-harness.ts';

describe('market api', () => {
it('imports existing GitHub repositories as canonical project architecture without token values', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);
		await store.upsertTeamTreeDx(team.id, {
			baseUrl: 'https://treedx.team.example',
			status: 'active',
		});
		const plan = Core.planRepositoryImport({
			team: team.slug,
			repository: 'treeseed-ai/sdk',
			env: { TREESEED_GITHUB_TOKEN_TREESEED_AI_SDK: 'ghp_should-never-persist' },
			observation: {
				defaultBranch: 'main',
				files: ['package.json', 'treeseed.package.yaml', 'docs/index.md', 'docs/src/content/intro.md'],
				directories: ['docs', 'docs/src', 'docs/src/content'],
			},
		});

		const imported = await json(await app.request(`/v1/teams/${team.slug}/projects/import`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ plan }),
		}));

		expect(imported.ok).toBe(true);
		expect(imported.payload.project.slug).toBe('sdk');
		expect(imported.payload.architecture).toMatchObject({
			topology: 'single_repository_site',
			sitePath: 'docs',
			contentPath: 'docs/src/content',
			contentRuntimeSource: 'r2_published_manifest',
		});
		expect(imported.payload.hubRepository).toMatchObject({
			role: 'software',
			provider: 'github',
			owner: 'treeseed-ai',
			name: 'sdk',
			defaultBranch: 'main',
		});
		expect(imported.payload.hubRepository.metadata.credentialRef).toBe('env:TREESEED_GITHUB_TOKEN_TREESEED_AI_SDK');
		expect(imported.payload.contentSource.metadata.projectArchitecture.sitePath).toBe('docs');
		expect(imported.payload.treeDxLibrary.contentPath).toBe('docs/src/content');
		expect(JSON.stringify(imported)).not.toContain('ghp_should-never-persist');

		const legacy = await app.request(`/v1/teams/${team.id}/projects/import`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ plan: { ...plan, repositoryTopology: 'split_software_content' } }),
		});
		expect(legacy.status).toBe(400);
		expect(await json(legacy)).toMatchObject({ code: 'legacy_project_topology_rejected' });

		const secret = await app.request(`/v1/teams/${team.id}/projects/import`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ plan: { ...plan, token: 'ghp_should-reject' } }),
		});
		expect(secret.status).toBe(400);
		expect(await json(secret)).toMatchObject({ code: 'project_import_secret_material_rejected' });
	});
});
