import type { Context, Hono } from 'hono';
import type { CapacityGovernanceDatabase } from '../../../database.ts';
import { CapacityGovernanceError } from '../../../database.ts';
import { bearerTokenFromRequest } from '../../../../accounts/request-auth.ts';

interface DiagnosticsStore extends CapacityGovernanceDatabase {
	authenticateRunner(projectId: string, token: string): Promise<unknown | null>;
	getProjectCapacityDiagnostics(projectId: string, environment: string): Promise<Record<string, unknown> | null>;
	getProjectCapacitySummary(projectId: string, environment: string): Promise<Record<string, unknown> | null>;
	getProjectCapacityRuntimeDiagnostics(projectId: string, teamId: string): Promise<Record<string, unknown> | null>;
	getTeam(teamId: string): Promise<{ id: string } | null>;
	getTeamBySlug(slug: string): Promise<{ id: string } | null>;
	getProjectDetails(projectId: string): Promise<{ project: { id: string; teamId: string } } | null>;
	getProjectByTeamAndSlug(teamId: string, slug: string): Promise<{ id: string } | null>;
}

export interface ProjectDiagnosticsRouteOptions {
	store: CapacityGovernanceDatabase;
	requireProjectAccess(c: Context, store: CapacityGovernanceDatabase, projectId: string, permission: string): Promise<{ response?: Response | null }>;
}

function notFound(c: Context, message: string) {
	return c.json({ ok: false, error: message, code: 'not_found' }, { status: 404 });
}

export function installProjectDiagnosticsRoutes(app: Hono, options: ProjectDiagnosticsRouteOptions) {
	const store = options.store as DiagnosticsStore;
	app.get('/v1/projects/:projectId/capacity', async (c) => {
		const projectId = c.req.param('projectId');
		const access = await options.requireProjectAccess(c, options.store, projectId, 'projects:read:team');
		if (access.response) return access.response;
		const environment = c.req.query('environment')?.trim() || 'staging';
		const payload = await store.getProjectCapacitySummary(projectId, environment);
		return payload ? c.json({ ok: true, payload }) : notFound(c, 'Unknown project.');
	});

	app.get('/v1/projects/:projectId/capacity-diagnostics', async (c) => {
		const projectId = c.req.param('projectId');
		const token = bearerTokenFromRequest(c.req.raw);
		const runner = token ? await store.authenticateRunner(projectId, token) : null;
		if (!runner) {
			const access = await options.requireProjectAccess(c, options.store, projectId, 'projects:read:team');
			if (access.response) return access.response;
		}
		const environment = c.req.query('environment')?.trim() || 'staging';
		const payload = await store.getProjectCapacityDiagnostics(projectId, environment);
		return payload ? c.json({ ok: true, payload }) : notFound(c, 'Unknown project.');
	});

	app.get('/v1/projects/:projectId/capacity-runtime-diagnostics', async (c) => {
		const requestedTeam = c.req.query('teamId')?.trim() || null;
		const team = requestedTeam ? await store.getTeam(requestedTeam) ?? await store.getTeamBySlug(requestedTeam) : null;
		const requestedProject = c.req.param('projectId');
		let projectDetails = await store.getProjectDetails(requestedProject);
		if (!projectDetails && team) {
			const projectBySlug = await store.getProjectByTeamAndSlug(team.id, requestedProject);
			projectDetails = projectBySlug ? await store.getProjectDetails(projectBySlug.id) : null;
		}
		if (!projectDetails) return notFound(c, 'Unknown project.');
		const teamId = team?.id ?? projectDetails.project.teamId;
		const providerAuth = (c as unknown as Context<{ Variables: { capacityProviderAccessAuth: { principal?: { teamId: string; scopes: string[] } } | null } }>).get('capacityProviderAccessAuth');
		const providerCanRead = providerAuth?.principal?.teamId === projectDetails.project.teamId
			&& providerAuth.principal.scopes.includes('provider:assignments:read');
		if (!providerCanRead) {
			const access = await options.requireProjectAccess(c, options.store, projectDetails.project.id, 'projects:read:team');
			if (access.response) return access.response;
		}
		if (teamId !== projectDetails.project.teamId) return notFound(c, 'Unknown project or team.');
		const payload = await store.getProjectCapacityRuntimeDiagnostics(projectDetails.project.id, teamId);
		return payload ? c.json({ ok: true, payload }) : notFound(c, 'Unknown project or team.');
	});
}
