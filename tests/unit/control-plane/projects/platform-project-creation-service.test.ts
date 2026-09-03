import { describe, expect, it } from 'vitest';
import { createPlatformProjectCreationService } from '../../../../src/api/control-plane/projects/platform-project-creation-service.ts';

const digest = `sha256:${'b'.repeat(64)}`;
const target = {
	slug: 'example-app', team: 'team-1', template: { id: 'engineering', version: '1.0.0-rc.5', digest },
	repository: { owner: 'example', name: 'example-app', visibility: 'private' as const },
};

const store = { async getProjectByTeamAndSlug() { return null; }, async listHubRepositories() { return []; }, async getProjectTreeDxLibrary() { return null; } };

describe('Platform project creation authority observation', () => {
	it('plans a new project without performing any mutation', async () => {
		const fetchImpl = async () => new Response(null, { status: 404 });
		const service = createPlatformProjectCreationService(store, { env: {}, fetchImpl: fetchImpl as typeof fetch });
		await expect(service.plan(target)).resolves.toMatchObject({ ok: true, actions: [
			{ step: 'project', action: 'create' }, { step: 'repository', action: 'adopt' }, { step: 'template', action: 'apply' },
			{ step: 'library', action: 'bind' }, { step: 'inventory', action: 'publish' },
		] });
	});

	it('derives the repository owner from portable team configuration', async () => {
		const configuredStore = { ...store, async getTeam() { return { metadata: { repositoryOwner: 'example' } }; } };
		const service = createPlatformProjectCreationService(configuredStore, { env: {}, fetchImpl: (async () => new Response(null, { status: 404 })) as typeof fetch });
		await expect(service.plan({ ...target, repository: { name: 'example-app', visibility: 'private' } } as never))
			.resolves.toMatchObject({ repository: { owner: 'example', name: 'example-app', visibility: 'private' } });
	});

	it('derives the repository owner from the active team project inventory', async () => {
		const inventoryStore = {
			...store,
			async getTeam() { return { metadata: {} }; },
			async first() { return null; },
			async listTeamProjects() { return [{ id: 'project-1' }]; },
			async listHubRepositories() { return [{ role: 'primary', owner: 'example', name: 'platform' }]; },
		};
		const service = createPlatformProjectCreationService(inventoryStore, { env: {}, fetchImpl: (async () => new Response(null, { status: 404 })) as typeof fetch });
		await expect(service.plan({ ...target, repository: { name: 'example-app', visibility: 'private' } } as never))
			.resolves.toMatchObject({ repository: { owner: 'example', name: 'example-app', visibility: 'private' } });
	});

	it('fails closed when a nonempty unmanaged repository already owns the requested identity', async () => {
		const fetchImpl = async () => new Response(JSON.stringify({ id: 7, name: 'example-app', owner: { login: 'example' }, private: true, size: 12,
			html_url: 'https://github.com/example/example-app' }), { status: 200, headers: { 'content-type': 'application/json' } });
		const service = createPlatformProjectCreationService(store, { env: {}, fetchImpl: fetchImpl as typeof fetch });
		await expect(service.plan(target)).resolves.toMatchObject({ ok: false, blockers: ['repository_conflicts_with_requested_target'] });
	});
});
