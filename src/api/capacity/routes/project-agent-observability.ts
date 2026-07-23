import type { Context, Hono } from 'hono';
import type { CapacityGovernanceDatabase } from '../database.ts';

type Row = Record<string, unknown>;

interface AgentObservabilityStore extends CapacityGovernanceDatabase {
	getProjectAgentsSummary(projectId: string, principal?: unknown): Promise<Row | null>;
	requestProjectRuntime(projectId: string, principal: unknown, path: string): Promise<unknown | null>;
	collectControlPlaneGeneratedArtifacts(projectId: string): Promise<Row[]>;
}

interface ProjectAccess {
	response?: Response | null;
	principal?: Row;
	details?: { project: { id: string } };
}

export interface ProjectAgentObservabilityRouteOptions {
	store: CapacityGovernanceDatabase;
	requireProjectAccess(c: Context, store: CapacityGovernanceDatabase, projectId: string, permission: string): Promise<ProjectAccess>;
}

function byId(items: unknown, id: string): Row | null {
	return Array.isArray(items) ? items.find((item) => String(item?.id ?? item?.taskId ?? '') === id) ?? null : null;
}

function notFound(c: Context, message: string) {
	return c.json({ ok: false, error: message }, { status: 404 });
}

function sourceMap(artifact: Row): unknown[] {
	const frontmatter = artifact.frontmatter && typeof artifact.frontmatter === 'object' ? artifact.frontmatter as Row : {};
	const docsMutationResult = artifact.docsMutationResult && typeof artifact.docsMutationResult === 'object' ? artifact.docsMutationResult as Row : {};
	const promotionToStaging = artifact.promotionToStaging && typeof artifact.promotionToStaging === 'object' ? artifact.promotionToStaging as Row : {};
	const value = artifact.sourceMap ?? artifact.source_map ?? frontmatter.source_map ?? docsMutationResult.sourceMap ?? promotionToStaging.sourceMap;
	return Array.isArray(value) ? value : [];
}

function diff(artifact: Row) {
	const docsMutationResult = artifact.docsMutationResult && typeof artifact.docsMutationResult === 'object' ? artifact.docsMutationResult as Row : {};
	return {
		id: artifact.id ?? artifact.taskId ?? null,
		diff: artifact.diff ?? artifact.patch ?? null,
		changedPaths: Array.isArray(artifact.changedPaths) ? artifact.changedPaths : [],
		snapshots: Array.isArray(artifact.snapshots) ? artifact.snapshots : [],
		verification: artifact.verification ?? null,
		verificationStatus: artifact.verificationStatus ?? docsMutationResult.verificationStatus ?? null,
		repairTask: artifact.repairTask ?? null,
		mergedToStaging: artifact.mergedToStaging ?? null,
	};
}

export function installProjectAgentObservabilityRoutes(app: Hono, options: ProjectAgentObservabilityRouteOptions) {
	const store = options.store as AgentObservabilityStore;
	const read = (c: Context) => options.requireProjectAccess(c, options.store, c.req.param('projectId'), 'projects:read:team');

	app.get('/v1/projects/:projectId/agents', async (c) => {
		const access = await read(c);
		if (access.response) return access.response;
		return c.json({ ok: true, payload: await store.getProjectAgentsSummary(c.req.param('projectId'), access.principal) });
	});

	app.get('/v1/projects/:projectId/agents/messages', async (c) => {
		const access = await read(c);
		if (access.response) return access.response;
		const payload = await store.requestProjectRuntime(access.details!.project.id, access.principal, '/v1/agents/messages');
		return payload ? c.json({ ok: true, payload }) : c.json({
			ok: false,
			error: 'Project runtime is not connected or unavailable.',
			projectId: access.details!.project.id,
			path: '/v1/agents/messages',
		}, { status: 409 });
	});

	app.get('/v1/projects/:projectId/agents/:agentSlug', async (c) => {
		const access = await read(c);
		if (access.response) return access.response;
		const summary = await store.getProjectAgentsSummary(c.req.param('projectId'), access.principal);
		const slug = c.req.param('agentSlug');
		const agent = Array.isArray(summary?.agents) ? summary.agents.find((item) => String(item?.agentSlug ?? item?.slug ?? '') === slug) : null;
		return agent ? c.json({ ok: true, payload: { projectId: c.req.param('projectId'), agent } }) : notFound(c, 'Unknown project agent.');
	});

	app.get('/v1/projects/:projectId/agent-artifacts', async (c) => {
		const access = await read(c);
		if (access.response) return access.response;
		const items = await store.collectControlPlaneGeneratedArtifacts(access.details!.project.id);
		return c.json({ ok: true, payload: { projectId: access.details!.project.id, items, warnings: [] } });
	});

	app.get('/v1/projects/:projectId/agent-artifacts/:artifactId', async (c) => {
		const access = await read(c);
		if (access.response) return access.response;
		const artifact = byId((await store.getProjectAgentsSummary(access.details!.project.id, access.principal))?.generatedArtifacts, c.req.param('artifactId'));
		return artifact ? c.json({ ok: true, payload: { projectId: access.details!.project.id, artifact } }) : notFound(c, 'Unknown agent artifact.');
	});

	app.get('/v1/projects/:projectId/agent-artifacts/:artifactId/source-map', async (c) => {
		const access = await read(c);
		if (access.response) return access.response;
		const artifactId = c.req.param('artifactId');
		const artifact = byId((await store.getProjectAgentsSummary(access.details!.project.id, access.principal))?.generatedArtifacts, artifactId);
		return artifact ? c.json({ ok: true, payload: { projectId: access.details!.project.id, artifactId, sourceMap: sourceMap(artifact) } }) : notFound(c, 'Unknown agent artifact.');
	});

	app.get('/v1/projects/:projectId/agent-artifacts/:artifactId/diff', async (c) => {
		const access = await read(c);
		if (access.response) return access.response;
		const artifactId = c.req.param('artifactId');
		const artifact = byId((await store.getProjectAgentsSummary(access.details!.project.id, access.principal))?.generatedArtifacts, artifactId);
		return artifact ? c.json({ ok: true, payload: { projectId: access.details!.project.id, artifactId, ...diff(artifact) } }) : notFound(c, 'Unknown agent artifact.');
	});
}
