import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, Core, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../../support/api-harness.ts';

describe('market api', () => {
it('persists canonical repository topology project architecture in project details', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const token = await authorizeApp(app);
		const { team, project } = await createTeamAndProject(app, token, {
			slug: 'hub-one',
			name: 'Hub One',
			metadata: {},
		});

		await store.upsertHubRepository(project.id, {
			teamId: team.id,
			role: 'software',
			provider: 'github',
			owner: 'acme',
			name: 'hub-one-site',
			url: 'https://github.com/acme/hub-one-site',
			defaultBranch: 'staging',
			status: 'active',
		});
		await store.upsertHubRepository(project.id, {
			teamId: team.id,
			role: 'content',
			provider: 'github',
			owner: 'acme',
			name: 'hub-one-content',
			url: 'https://github.com/acme/hub-one-content',
			defaultBranch: 'main',
			status: 'active',
		});
		await store.upsertHubWorkspaceLink(project.id, {
			teamId: team.id,
			parentOwner: 'acme',
			parentName: 'software',
			parentUrl: 'https://github.com/acme/software',
			parentBranch: 'main',
			softwareSubmodulePath: 'docs',
		});
		await store.upsertTeamTreeDx(team.id, {
			baseUrl: 'https://treedx.team.example',
			status: 'active',
		});

		const binding = await json(await app.request(`/v1/projects/${project.id}/treedx-library`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ libraryId: 'acme/hub-one', repositoryId: 'repo_hub_one' }),
		}));
		expect(binding.payload.contentRepositoryUrl).toBe('https://github.com/acme/hub-one-content');

		const architecturePayload = {
			topology: 'single_repository_site',
			rootPath: '.',
			sitePath: 'docs',
			contentPath: 'docs/src/content',
			contentRuntimeSource: 'treedx_snapshot',
			localContentMaterialization: 'none',
			contentPublishTarget: {
				kind: 'cloudflare_r2',
				prefix: 'hub-one',
			},
		};
		const updated = await json(await app.request(`/v1/projects/${project.id}/repository-topology`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify(architecturePayload),
		}));
		expect(updated.payload).toMatchObject(architecturePayload);

		const architecture = await json(await app.request(`/v1/projects/${project.id}/repository-topology`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(architecture.payload).toMatchObject(architecturePayload);

		const rejectedLegacy = await app.request(`/v1/projects/${project.id}/repository-topology`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ topology: 'split_software_content', sitePath: 'docs' }),
		});
		expect(rejectedLegacy.status).toBe(400);
		expect(await json(rejectedLegacy)).toMatchObject({ code: 'legacy_project_topology_rejected' });

		const rejectedSecret = await app.request(`/v1/projects/${project.id}/repository-topology`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ ...architecturePayload, token: 'ghp_should-not-persist' }),
		});
		expect(rejectedSecret.status).toBe(400);
		expect(await json(rejectedSecret)).toMatchObject({ code: 'project_architecture_secret_material_rejected' });

		const details = await store.getProjectDetails(project.id);
		expect(details?.architecture).toMatchObject(architecturePayload);
		expect(details?.contentSource?.metadata?.projectArchitecture).toMatchObject(architecturePayload);
	});
});
