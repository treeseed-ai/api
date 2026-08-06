import { authorizeApp,createTeamAndProject,createTestApp,describe,expect,it,json } from '../../../../support/api-harness.ts';

describe('market api', () => {
it('requires a TreeDX changeset when project settings would mutate the core objective', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const { project } = await createTeamAndProject(app, token, {
			id: 'settings-core-objective-project',
			slug: 'settings-core-objective-project',
			name: 'Settings Core Objective Project',
			metadata: {
				coreObjective: '# Core Objective\n\nOriginal objective.',
			},
		});

		const response = await json(await app.request(`/v1/projects/${project.id}`, {
			method: 'PUT',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				name: 'Settings Core Objective Project',
				slug: 'settings-core-objective-project',
				coreObjective: '# Core Objective\n\nUpdated objective for repository sync.',
			}),
		}));

		expect(response).toMatchObject({ ok: false, code: 'treedx_changeset_required' });
	});
});
