import { authorizeApp,createTeamAndProject,createTestApp,createTestPostgresDatabase,createTestStore,describe,expect,it,json } from '../../../../support/api-harness.ts';

describe('market api', () => {
it('returns and updates the canonical TreeDX repository topology without conflating project architecture', async () => {
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

		const topology = await json(await app.request(`/v1/projects/${project.id}/repository-topology`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(topology.payload).toMatchObject({
			contentRepository: { accessMode: 'treedx', contentPath: 'src/content', remote: null,
				treeDx: { repositoryId: 'repo_hub_one', libraryId: 'acme/hub-one' } },
			siteRepository: { accessMode: 'filesystem', name: 'hub-one-site' },
		});

		const updated = await json(await app.request(`/v1/projects/${project.id}/repository-topology`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ ...topology.payload,
				contentRepository: { ...topology.payload.contentRepository, contentPath: 'docs/src/content' } }),
		}));
		expect(updated.payload.contentRepository.contentPath).toBe('docs/src/content');

		const persisted = await json(await app.request(`/v1/projects/${project.id}/repository-topology`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(persisted.payload.contentRepository.contentPath).toBe('docs/src/content');

		const rejectedSecret = await app.request(`/v1/projects/${project.id}/repository-topology`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ ...topology.payload, accessToken: 'ghp_should-not-persist' }),
		});
		expect(rejectedSecret.status).toBe(400);
		expect(await json(rejectedSecret)).toMatchObject({ code: 'repository_topology_secret_material_rejected' });
	});
});
