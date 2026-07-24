import type { Context, Hono } from 'hono';
import type { CapacityGovernanceDatabase } from '../../../database.ts';
import { CapacityGovernanceError } from '../../../database.ts';
import { proxyTreeDxJson } from '../../../services/treedx/repositories/treedx-proxy-service.ts';
import {
	resolveTreeDxProxyBaseUrl,
	treeDxPathScope,
	treeDxRepoScopedContextBody,
	treeDxTokenScope,
	verifyTreeDxWorkspace,
	type TreeDxProxyRuntime,
} from '../../../services/treedx/repositories/treedx-proxy-token-service.ts';
import { readCapacityRequestObject } from '../../support/request-json.ts';

const WORKSPACE_CREATE = 'workspace:create';

interface TreeDxProxyStore extends CapacityGovernanceDatabase {
	getProjectTreeDxLibrary(projectId: string): Promise<Record<string, unknown> | null>;
	upsertProjectTreeDxLibrary(projectId: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
}

export interface TreeDxProxyRouteOptions {
	store: CapacityGovernanceDatabase;
	runtime: TreeDxProxyRuntime;
	requireProjectAccess(c: Context, store: CapacityGovernanceDatabase, projectId: string, permission: string): Promise<{ response?: Response | null; principal?: Record<string, unknown>; details?: { project: { id: string; teamId: string } } }>;
}

function repositoryId(library: Record<string, unknown> | null): string | null {
	const topology = library?.topology && typeof library.topology === 'object' ? library.topology as Record<string, unknown> : {};
	const contentRepository = topology.contentRepository && typeof topology.contentRepository === 'object' ? topology.contentRepository as Record<string, unknown> : {};
	const treeDx = contentRepository.treeDx && typeof contentRepository.treeDx === 'object' ? contentRepository.treeDx as Record<string, unknown> : {};
	const value = library?.repositoryId ?? treeDx.repositoryId;
	return typeof value === 'string' ? value : null;
}

function assertRepository(library: Record<string, unknown> | null, requested: string) {
	const expected = repositoryId(library);
	if (expected && expected !== requested) throw new CapacityGovernanceError('treedx_repository_project_mismatch', 'TreeDX repository is not bound to this project.', 403, { repositoryId: requested, expectedRepositoryId: expected });
}

function errorResponse(c: Context, error: unknown) {
	if (error instanceof CapacityGovernanceError) return new Response(JSON.stringify({ ok: false, error: error.message, code: error.code, details: error.details }), { status: error.status, headers: { 'content-type': 'application/json' } });
	throw error;
}

export function installTreeDxProxyRoutes(app: Hono, options: TreeDxProxyRouteOptions) {
	const store = options.store as TreeDxProxyStore;
	const execute = (input: Omit<Parameters<typeof proxyTreeDxJson>[0], 'runtime' | 'store' | 'requireProjectAccess'>) => proxyTreeDxJson({ ...input, runtime: options.runtime, store: options.store, requireProjectAccess: options.requireProjectAccess });

	app.get('/v1/projects/:projectId/treedx-library', async (c) => {
		const access = await options.requireProjectAccess(c, options.store, c.req.param('projectId'), 'projects:read:team');
		if (access.response) return access.response;
		return c.json({ ok: true, payload: await store.getProjectTreeDxLibrary(c.req.param('projectId')) });
	});
	app.post('/v1/projects/:projectId/treedx-library', async (c) => {
		try {
			const access = await options.requireProjectAccess(c, options.store, c.req.param('projectId'), 'projects:manage:team');
			if (access.response) return access.response;
			const payload = await store.upsertProjectTreeDxLibrary(c.req.param('projectId'), await readCapacityRequestObject(c, { optional: true }));
			if (!payload) throw new CapacityGovernanceError('treedx_team_binding_required', 'Create a team TreeDX binding before binding a project library.', 404);
			return c.json({ ok: true, payload }, { status: 201 });
		} catch (error) { return errorResponse(c, error); }
	});

	app.post('/v1/dx/projects/:projectId/repos', async (c) => {
		try { return await execute({ c, projectId: c.req.param('projectId'), permission: 'projects:manage:team', method: 'POST', path: '/api/v1/repos', body: await readCapacityRequestObject(c, { optional: true }), tokenScope: treeDxTokenScope({ capabilities: ['repos:write'] }) }); }
		catch (error) { return errorResponse(c, error); }
	});
	app.post('/v1/dx/projects/:projectId/repos/:repoId/workspaces', async (c) => {
		try {
			const library = await store.getProjectTreeDxLibrary(c.req.param('projectId')); assertRepository(library, c.req.param('repoId'));
			return await execute({ c, projectId: c.req.param('projectId'), permission: 'projects:manage:team', method: 'POST', path: `/api/v1/repos/${encodeURIComponent(c.req.param('repoId'))}/workspaces`, body: await readCapacityRequestObject(c, { optional: true }), tokenScope: treeDxTokenScope({ repoId: c.req.param('repoId'), capabilities: ['repos:write', WORKSPACE_CREATE, 'files:read', 'files:write', 'git:read', 'git:diff', 'git:commit'], paths: ['**'] }) });
		} catch (error) { return errorResponse(c, error); }
	});

	const workspace = (method: 'GET' | 'POST' | 'PUT', operation: 'files' | 'search' | 'commit' | 'close') => async (c: Context) => {
		try {
			const projectId = c.req.param('projectId'); const workspaceId = c.req.param('workspaceId');
			const library = await store.getProjectTreeDxLibrary(projectId);
			await verifyTreeDxWorkspace({ runtime: options.runtime, projectId, library, workspaceId });
			const repoId = repositoryId(library);
			const filePath = operation === 'files' ? c.req.query('path') : null;
			if (operation === 'files' && !filePath) throw new CapacityGovernanceError('treedx_file_path_required', 'TreeDX file path is required.', 400);
			const body = method === 'GET' ? undefined : await readCapacityRequestObject(c, { optional: true });
			const path = operation === 'files' ? `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/files?path=${encodeURIComponent(filePath!)}` : `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/${operation}`;
			const capabilities = operation === 'files'
				? [method === 'GET' ? 'files:read' : 'files:write']
				: operation === 'search'
					? ['files:search']
					: operation === 'close'
						? ['workspace:write', 'files:read']
						: ['git:commit'];
			const paths = operation === 'files' ? treeDxPathScope(filePath) : operation === 'search' && Array.isArray(body?.paths) ? body.paths : ['**'];
			return await execute({ c, projectId, permission: method === 'GET' || operation === 'search' ? 'projects:read:team' : 'projects:manage:team', method, path, body, tokenScope: treeDxTokenScope({ repoId, capabilities, paths }) });
		} catch (error) { return errorResponse(c, error); }
	};
	app.get('/v1/dx/projects/:projectId/workspaces/:workspaceId/files', workspace('GET', 'files'));
	app.put('/v1/dx/projects/:projectId/workspaces/:workspaceId/files', workspace('PUT', 'files'));
	app.post('/v1/dx/projects/:projectId/workspaces/:workspaceId/search', workspace('POST', 'search'));
	app.post('/v1/dx/projects/:projectId/workspaces/:workspaceId/commit', workspace('POST', 'commit'));
	app.post('/v1/dx/projects/:projectId/workspaces/:workspaceId/close', workspace('POST', 'close'));

	const repositoryRead = (operation: 'files/read' | 'paths/list' | 'context/build') => async (c: Context) => {
		try {
			const projectId = c.req.param('projectId'); const repoId = c.req.param('repoId');
			assertRepository(await store.getProjectTreeDxLibrary(projectId), repoId);
			const body = await readCapacityRequestObject(c, { optional: true });
			const pathInput = Array.isArray(body.paths) && body.paths.length ? body.paths : typeof body.path === 'string' && body.path.trim() ? treeDxPathScope(body.path) : ['**'];
			const capabilities = operation === 'context/build' ? ['files:read', 'files:search', 'graph:query'] : ['files:read'];
			return await execute({ c, projectId, permission: 'projects:read:team', method: 'POST', path: `/api/v1/repos/${encodeURIComponent(repoId)}/${operation}`, body: operation === 'context/build' ? treeDxRepoScopedContextBody(body, repoId) : body, tokenScope: treeDxTokenScope({ repoId, capabilities, paths: pathInput }) });
		} catch (error) { return errorResponse(c, error); }
	};
	app.post('/v1/dx/projects/:projectId/repos/:repoId/files/read', repositoryRead('files/read'));
	app.post('/v1/dx/projects/:projectId/repos/:repoId/paths/list', repositoryRead('paths/list'));
	app.post('/v1/dx/projects/:projectId/repos/:repoId/context/build', repositoryRead('context/build'));
}
