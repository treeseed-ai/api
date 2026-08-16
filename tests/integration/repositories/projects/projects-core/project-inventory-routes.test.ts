import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { installProjectsCollectionRoutes } from '../../../../../src/api/routes/projects/projects-collection.ts';

function application(store: Record<string, unknown>, access = async () => ({ response: null }), capacity: Record<string, unknown> = {}) {
	const app = new Hono();
	installProjectsCollectionRoutes({
		app,
		store,
		capacity,
		ensurePrincipal: async () => ({ principal: { id: 'user-a' } }),
		requireProjectAccess: async () => ({ response: null, principal: { id: 'user-a' } }),
		requireTeamAccess: access,
		jsonError: (c: any, status: number, message: string) => c.json({ ok: false, message }, status),
	});
	return app;
}

describe('team project inventory route', () => {
	it('returns every live project with its durable repository bindings', async () => {
		const listTeamProjects = vi.fn(async () => [
			{ id: 'project-api', teamId: 'team-a', slug: 'api', metadata: { repository: { checkoutPath: 'packages/api' } } },
			{ id: 'project-platform', teamId: 'team-a', slug: 'platform', metadata: {} },
			{ id: 'project-retired', teamId: 'team-a', slug: 'retired', metadata: { inventory: { status: 'archived' } } },
		]);
		const listHubRepositories = vi.fn(async (projectId: string) => projectId === 'project-api'
			? [{ id: 'repository-api', hubId: projectId, role: 'primary', owner: 'treeseed-ai', name: 'api', currentBranch: 'staging' }]
			: [{ id: 'repository-fixture', hubId: projectId, role: 'fixture', owner: 'treeseed-ai', name: 'fixtures', currentBranch: 'staging' }]);
		const response = await application({ listTeamProjects, listHubRepositories }).request('/v1/teams/team-a/project-inventory');
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			payload: { teamId: 'team-a', projects: [
				{ id: 'project-api', repositories: [{ name: 'api', role: 'primary' }] },
				{ id: 'project-platform', repositories: [{ name: 'fixtures', role: 'fixture' }] },
			] },
		});
		expect(listHubRepositories).toHaveBeenCalledTimes(2);
	});

	it('does not disclose inventory when team access is denied', async () => {
		const denied = new Response(JSON.stringify({ ok: false }), { status: 403 });
		const listTeamProjects = vi.fn();
		const response = await application({ listTeamProjects }, async () => ({ response: denied })).request('/v1/teams/team-a/project-inventory');
		expect(response.status).toBe(403);
		expect(listTeamProjects).not.toHaveBeenCalled();
	});

	it('omits archived projects from the team-scoped project list', async () => {
		const listTeamProjects = vi.fn(async () => [
			{ id: 'active', teamId: 'team-a', metadata: {} },
			{ id: 'archived', teamId: 'team-a', metadata: { inventory: { status: 'archived' } } },
		]);
		const response = await application({ listTeamProjects }).request('/v1/projects?teamId=team-a');
		expect(response.status).toBe(200);
		expect((await response.json()).payload.map((project: { id: string }) => project.id)).toEqual(['active']);
		expect(listTeamProjects).toHaveBeenCalledWith('team-a');
	});

	it('archives and restores inventory membership without deleting the project', async () => {
		let project = { id: 'project-a', teamId: 'team-a', slug: 'project-a', metadata: { repository: { name: 'project-a' } } };
		const updateProject = vi.fn(async (_id: string, input: { metadata: typeof project.metadata }) => {
			project = { ...project, metadata: input.metadata };
			return project;
		});
		const recordAuditEvent = vi.fn();
		const app = application({ async getProject() { return project; }, updateProject, recordAuditEvent }, undefined, { async evaluateProjectDeletionBlockers() { return []; } });
		expect((await app.request('/v1/projects/project-a/archive', { method: 'POST' })).status).toBe(200);
		expect((project.metadata as any).inventory.status).toBe('archived');
		expect((await app.request('/v1/projects/project-a/restore', { method: 'POST' })).status).toBe(200);
		expect((project.metadata as any).inventory.status).toBe('active');
		expect(updateProject).toHaveBeenCalledTimes(2);
		expect(recordAuditEvent).toHaveBeenCalledTimes(2);
	});
});
