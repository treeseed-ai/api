import type { Context, Hono } from 'hono';
import {
	decodeCapacityPageCursor,
	normalizeCapacityPageLimit,
	type CapacityPage,
	type CapacityPageCursor,
} from '@treeseed/sdk/capacity-pagination';
import type { CapacityGovernanceDatabase } from '../database.ts';
import { CapacityGovernanceError } from '../database.ts';
import { ProjectAgentClassService } from '../services/project-agent-class-service.ts';
import { readCapacityRequestObject } from './request-json.ts';

interface ProjectAgentOperatorStore extends CapacityGovernanceDatabase {
	listProjectAgentClassesPage(projectId: string, page: PageInput): Promise<CapacityPage<Record<string, unknown>>>;
	listAgentModeRunsPage(projectId: string, filters: Record<string, unknown> & PageInput): Promise<CapacityPage<Record<string, unknown>>>;
	listAgentFallbackOutputsPage(projectId: string, filters: Record<string, unknown> & PageInput): Promise<CapacityPage<Record<string, unknown>>>;
	listTreeDxProxyAuditPage(projectId: string, filters: Record<string, unknown> & PageInput): Promise<CapacityPage<Record<string, unknown>>>;
	getProviderAssignment(teamId: string, assignmentId: string): Promise<Record<string, unknown> | null>;
}

interface PageInput {
	limit: number;
	cursor: CapacityPageCursor | null;
}

export interface ProjectAgentOperatorRouteOptions {
	store: CapacityGovernanceDatabase;
	requireProjectAccess(c: Context, store: CapacityGovernanceDatabase, projectId: string, permission: string): Promise<{
		response?: Response | null;
		details?: { project?: { teamId?: string } };
	}>;
}

function query(c: Context, name: string) {
	const value = c.req.query(name);
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function idempotencyKey(c: Context) {
	const key = c.req.header('Idempotency-Key')?.trim();
	if (!key) throw new CapacityGovernanceError('capacity_idempotency_key_required', 'An idempotency key is required.', 400);
	return key;
}

function page(c: Context): PageInput {
	try {
		return {
			limit: normalizeCapacityPageLimit(query(c, 'limit')),
			cursor: decodeCapacityPageCursor(query(c, 'cursor')),
		};
	} catch (error) {
		throw new CapacityGovernanceError('capacity_page_invalid', error instanceof Error ? error.message : String(error), 400);
	}
}

function errorResponse(error: unknown) {
	const candidate = error && typeof error === 'object'
		? error as { message?: unknown; code?: unknown; status?: unknown; details?: unknown }
		: {};
	const status = Number(candidate.status);
	if (!Number.isInteger(status) || status < 400 || status > 599) throw error;
	return new Response(JSON.stringify({
		ok: false,
		error: typeof candidate.message === 'string' ? candidate.message : 'Project agent operator request failed.',
		code: typeof candidate.code === 'string' ? candidate.code : 'project_agent_operator_failed',
		details: candidate.details && typeof candidate.details === 'object' ? candidate.details : undefined,
	}), { status, headers: { 'content-type': 'application/json' } });
}

function value(record: Record<string, unknown>, camel: string, snake: string) {
	return record[camel] ?? record[snake] ?? null;
}

export function installProjectAgentOperatorRoutes(app: Hono, options: ProjectAgentOperatorRouteOptions) {
	const store = options.store as ProjectAgentOperatorStore;
	const classes = new ProjectAgentClassService(options.store as ProjectAgentOperatorStore & { getProject(projectId: string): Promise<{ id: string; teamId: string } | null> });
	const read = (c: Context) => options.requireProjectAccess(c, options.store, c.req.param('projectId'), 'projects:read:team');
	const manage = (c: Context) => options.requireProjectAccess(c, options.store, c.req.param('projectId'), 'projects:manage:team');

	app.get('/v1/projects/:projectId/agent-classes', async (c) => {
		const access = await read(c); if (access.response) return access.response;
		try {
			return c.json({ ok: true, payload: await store.listProjectAgentClassesPage(c.req.param('projectId'), page(c)) });
		} catch (error) {
			return errorResponse(error);
		}
	});

	app.post('/v1/projects/:projectId/agent-classes', async (c) => {
		try {
			const access = await manage(c); if (access.response) return access.response;
			const agentClass = await classes.create(c.req.param('projectId'), await readCapacityRequestObject(c, { optional: true }), idempotencyKey(c));
			return agentClass ? c.json({ ok: true, payload: agentClass }, { status: 201 }) : c.json({ ok: false, error: 'Unknown project.', code: 'not_found' }, { status: 404 });
		} catch (error) { return errorResponse(error); }
	});

	app.get('/v1/projects/:projectId/agent-classes/:classId', async (c) => {
		try {
			const access = await read(c); if (access.response) return access.response;
			const agentClass = await classes.get(c.req.param('projectId'), c.req.param('classId'));
			return agentClass ? c.json({ ok: true, payload: agentClass }) : c.json({ ok: false, error: 'Unknown project agent class.', code: 'not_found' }, { status: 404 });
		} catch (error) { return errorResponse(error); }
	});

	app.patch('/v1/projects/:projectId/agent-classes/:classId', async (c) => {
		try {
			const access = await manage(c); if (access.response) return access.response;
			const agentClass = await classes.update(c.req.param('projectId'), c.req.param('classId'), await readCapacityRequestObject(c, { optional: true }), idempotencyKey(c));
			return agentClass ? c.json({ ok: true, payload: agentClass }) : c.json({ ok: false, error: 'Unknown project agent class.', code: 'not_found' }, { status: 404 });
		} catch (error) { return errorResponse(error); }
	});

	app.get('/v1/projects/:projectId/agent-mode-runs', async (c) => {
		const access = await read(c); if (access.response) return access.response;
		try {
			return c.json({
				ok: true,
				payload: await store.listAgentModeRunsPage(c.req.param('projectId'), {
					mode: query(c, 'mode'),
					assignmentId: query(c, 'assignmentId'),
					...page(c),
				}),
			});
		} catch (error) {
			return errorResponse(error);
		}
	});

	app.get('/v1/projects/:projectId/assignments/:assignmentId/timeline', async (c) => {
		const access = await read(c); if (access.response) return access.response;
		const projectId = c.req.param('projectId');
		const assignmentId = c.req.param('assignmentId');
		const teamId = access.details?.project?.teamId;
		if (!teamId) return c.json({ ok: false, error: 'Unknown project.', code: 'not_found' }, { status: 404 });
		const assignment = await store.getProviderAssignment(teamId, assignmentId);
		if (!assignment || String(assignment.projectId ?? assignment.project_id ?? '') !== projectId) {
			return c.json({ ok: false, error: 'Unknown assignment.', code: 'not_found' }, { status: 404 });
		}
		try {
			const requestedPage = page(c);
			const modeRuns = await store.listAgentModeRunsPage(projectId, { assignmentId, ...requestedPage });
			const items: Array<Record<string, unknown>> = modeRuns.items.map((run, index) => {
				const outputs = run.outputs && typeof run.outputs === 'object' ? run.outputs as Record<string, unknown> : {};
				const outputStatus = String(outputs.status ?? '');
				const status = String(run.status ?? '');
				return {
					type: outputStatus === 'message_recorded'
						? 'assistant_message'
						: outputStatus === 'tool_call'
							? 'tool_call'
							: outputStatus === 'tool_result'
								? 'tool_result'
								: status === 'succeeded'
									? 'completed'
									: status === 'failed'
										? 'failed'
										: 'checkpoint',
					id: run.id,
					assignmentId,
					modeRunId: run.id,
					index,
					status: run.status,
					createdAt: value(run, 'startedAt', 'started_at')
						?? value(run, 'completedAt', 'completed_at')
						?? value(run, 'failedAt', 'failed_at')
						?? value(run, 'createdAt', 'created_at'),
					payload: run,
				};
			});
			if (!requestedPage.cursor) {
				items.unshift({
					type: 'assignment_created',
					id: `${assignmentId}:created`,
					assignmentId,
					modeRunId: null,
					index: -1,
					status: assignment.status,
					createdAt: value(assignment, 'createdAt', 'created_at'),
					payload: assignment,
				});
			}
			return c.json({ ok: true, payload: { assignment, items, page: modeRuns.page } });
		} catch (error) {
			return errorResponse(error);
		}
	});

	app.get('/v1/projects/:projectId/agent-fallback-outputs', async (c) => {
		const access = await read(c); if (access.response) return access.response;
		try {
			return c.json({
				ok: true,
				payload: await store.listAgentFallbackOutputsPage(c.req.param('projectId'), {
					mode: query(c, 'mode'),
					status: query(c, 'status'),
					assignmentId: query(c, 'assignmentId'),
					...page(c),
				}),
			});
		} catch (error) {
			return errorResponse(error);
		}
	});

	app.get('/v1/projects/:projectId/treedx-proxy-audit', async (c) => {
		const access = await read(c); if (access.response) return access.response;
		try {
			return c.json({
				ok: true,
				payload: await store.listTreeDxProxyAuditPage(c.req.param('projectId'), {
					assignmentId: query(c, 'assignmentId'),
					actorType: query(c, 'actorType'),
					...page(c),
				}),
			});
		} catch (error) {
			return errorResponse(error);
		}
	});
}
