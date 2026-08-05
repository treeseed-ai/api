import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { agentLabMetricKeys, type AgentLabEntityKind } from '@treeseed/sdk/agent-capacity';
import type { Context, Hono } from 'hono';
import { AgentLabProjectionService } from '../../services/capacity/observability/agent-lab-projection-service.ts';
import { AgentLabCommandService } from '../../services/capacity/observability/agent-lab-command-service.ts';
import type { WorkdayRouteDependencies } from './operator-workdays.ts';
import { readCapacityRequestObject } from './request-json.ts';
import { resolveKnowledgeGatewayConnection } from '../../../knowledge/gateway-treedx-connection.ts';
import { validateAgentArtifactContract } from '@treeseed/sdk/agent-capacity';
import { parse as parseYaml } from 'yaml';
import { searchRelations } from '../../../routes/knowledge/relation-search.ts';
import { CapacityAllocationService } from '../../services/capacity/allocations/allocation-service.ts';
import { agentLabRepositoryDefinitions,matchesAgentDefinition,validateAgentDefinitionSource } from './agent-lab-repository-definitions.ts';

const entityKinds = new Set<AgentLabEntityKind>(['agents', 'workdays', 'events', 'assignments', 'executions', 'artifacts']);
const commandSurfaces = new Set(['inbox', 'decisions', 'build', 'direction', 'results', 'find']);
const commandKinds = new Set(['proposal', 'decision', 'question', 'artifact', 'error', 'agent', 'artifact-contract', 'signal', 'assignment', 'execution', 'simulation', 'seed', 'workday', 'note']);

function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function jsonObject(value: unknown) { if (typeof value === 'string') try { return object(JSON.parse(value)); } catch { return {}; } return object(value); }
function text(...values: unknown[]) { return String(values.find((value) => typeof value === 'string' && value) ?? ''); }

async function relationResults(dependencies: WorkdayRouteDependencies, projects: Array<Record<string, unknown>>, query: string) {
	if (query.trim().length < 2) return [];
	const results = await Promise.all(projects.map(async (project) => {
		const projectId = text(project.id); if (!projectId) return [];
		const connection = await resolveKnowledgeGatewayConnection(dependencies.store, { projectId, write: false, relationPaths: true }).catch(() => null);
		if (!connection) return [];
		const found = await searchRelations(connection, query, new Set()).catch(() => []);
		return found.map((entry: Record<string, unknown>) => ({ id: `treedx:${projectId}:${text(entry.kind)}:${text(entry.id)}`, kind: ['questions', 'proposals', 'decisions', 'agents'].includes(text(entry.kind)) ? text(entry.kind).replace(/s$/u, '') : 'note', title: text(entry.title, 'Repository content'), description: text(entry.summary, 'TreeDX relationship match'), status: 'indexed', projectId, projectName: text(project.name, project.slug), tags: ['TreeDX', text(entry.kind)].filter(Boolean), data: { ...entry, projectId, source: 'treedx' } }));
	}));
	return results.flat();
}

function repositoryBody(source: string) {
	if (!source.startsWith('---')) return source.trim();
	const boundary = source.indexOf('\n---', 3);
	return boundary < 0 ? source.trim() : source.slice(boundary + 4).trim();
}

async function knowledgeConversation(dependencies: WorkdayRouteDependencies, projectId: string, subjectId: string) {
	if (!projectId || !subjectId) return [];
	const connection = await resolveKnowledgeGatewayConnection(dependencies.store, { projectId, write: false, relationPaths: true }).catch(() => null);
	if (!connection) return [];
	const matches = await searchRelations(connection, subjectId, new Set(['notes', 'questions'])).catch(() => []);
	return matches.filter((entry: Record<string, unknown>) => text(entry.id) !== subjectId).map((entry: Record<string, unknown>) => ({
		id: `treedx:${projectId}:${text(entry.kind)}:${text(entry.id)}`,
		kind: text(entry.kind).replace(/s$/u, ''),
		title: text(entry.title, 'Related conversation'),
		description: text(entry.summary, 'Repository-linked context'),
		status: 'indexed', projectId, occurredAt: text(entry.occurredAt) || null,
		data: { ...entry, projectId, source: 'treedx' },
	}));
}

function validTimeZone(value: unknown) {
	const candidate = typeof value === 'string' && value ? value : 'UTC';
	try { new Intl.DateTimeFormat('en', { timeZone: candidate }).format(); return candidate; } catch { return 'UTC'; }
}

async function projectionContext(c: Context, dependencies: WorkdayRouteDependencies) {
	const access = await dependencies.read(c);
	if (access.response) return { response: access.response };
	const preference = access.principal?.id
		? await dependencies.store.first(`SELECT time_zone FROM user_preferences WHERE user_id = ? LIMIT 1`, [access.principal.id])
		: null;
	const timeZone = validTimeZone(preference?.time_zone);
	const service = new AgentLabProjectionService(dependencies.store);
	const snapshot = await service.snapshot(c.req.param('teamId'), timeZone, new Date(), { date: c.req.query('date'), workdayId: c.req.query('workday') });
	if (!snapshot) return { response: dependencies.notFound(c, 'Unknown team.') };
	return { service, snapshot, access };
}

async function viewState(dependencies: WorkdayRouteDependencies, userId: string | null | undefined, teamId: string, namespace = 'command') {
	if (!userId) return [];
	return dependencies.store.all(`SELECT * FROM agent_lab_view_state WHERE user_id = ? AND team_id = ? AND namespace = ?`, [userId, teamId, namespace]).catch(() => []);
}

function withViewState<T extends { items: Array<Record<string, unknown>>; secondaryItems?: Array<Record<string, unknown>> }>(payload: T, rows: Array<Record<string, unknown>>) {
	const states = new Map(rows.map((row) => [`${row.entity_kind}:${row.entity_id}`, row]));
	const apply = (item: Record<string, unknown>) => { const state = states.get(`${item.kind}:${item.id}`); return state ? { ...item, pinned: Number(state.pinned) === 1, hidden: Number(state.hidden) === 1, resolved: Number(state.resolved) === 1, viewStateVersion: Number(state.version ?? 1) } : item; };
	return { ...payload, items: payload.items.map(apply), secondaryItems: payload.secondaryItems?.map(apply) };
}

function notModified(c: Context, revision: string) {
	const etag = `"${revision}"`;
	return c.req.header('If-None-Match') === etag
		? new Response(null, { status: 304, headers: { etag, 'cache-control': 'private, no-cache' } })
		: null;
}

function response(c: Context, payload: unknown, revision: string) {
	return c.json({ ok: true, payload }, 200, { etag: `"${revision}"`, 'cache-control': 'private, no-cache' });
}

async function allocationSnapshot(dependencies: WorkdayRouteDependencies, teamId: string, snapshot: Exclude<Awaited<ReturnType<AgentLabProjectionService['snapshot']>>, null>, canManage: boolean) {
	const active = await new CapacityAllocationService(dependencies.store).getActive(teamId); const slices = active?.slices ?? [];
	const equalProjects = snapshot.rows.projects.length ? 100 / snapshot.rows.projects.length : 0;
	const projects = snapshot.rows.projects.map((project) => { const id = text(project.id); const slice = slices.find((item) => item.scope === 'project' && item.targetId === id); return { id, name: text(project.name, project.slug, 'Project'), percentage: slice?.policy.targetPercent ?? equalProjects }; });
	const classes = snapshot.rows.classes.map((agentClass) => { const id = text(agentClass.id); const projectId = text(agentClass.project_id); const siblings = snapshot.rows.classes.filter((item) => text(item.project_id) === projectId); const slice = slices.find((item) => item.scope === 'agent-class' && item.targetId === id); return { id, projectId, name: text(agentClass.name, agentClass.slug, 'Agent class'), percentage: slice?.policy.targetPercent ?? (siblings.length ? 100 / siblings.length : 0) }; });
	const requested = snapshot.rows.demands.reduce((sum, row) => sum + Number(row.requested_credits ?? 0), 0);
	const activeReservations = snapshot.rows.reservations.filter((row) => ['reserved', 'consuming'].includes(text(row.state)));
	const reserved = activeReservations.reduce((sum, row) => sum + Number(row.reserved_credits ?? 0), 0);
	const aggregateUsage = new Set(snapshot.rows.usage.filter((row) => text(row.usage_dimension) === 'aggregate').map((row) => `${text(row.assignment_id)}:${Number(row.assignment_attempt ?? 1)}`));
	const reported = snapshot.rows.usage.filter((row) => text(row.accounting_mode) === 'aggregate' || (text(row.accounting_mode) === 'incremental' && !aggregateUsage.has(`${text(row.assignment_id)}:${Number(row.assignment_attempt ?? 1)}`))).reduce((sum, row) => sum + Number(row.actual_credits ?? 0), 0);
	const spent = snapshot.rows.ledger.filter((row) => text(row.phase) === 'task_completed_actual_settlement').reduce((sum, row) => sum + Number(row.credits ?? 0), 0);
	const overrun = snapshot.rows.ledger.filter((row) => text(row.phase) === 'overrun_hold').reduce((sum, row) => sum + Number(row.credits ?? 0), 0);
	const budget = snapshot.rows.workdays.reduce((sum, row) => sum + Number(object(row.parameters_json).availableCredits ?? object(row.parameters_json).available_credits ?? 0), 0);
	return { revision: snapshot.overview.revision, generatedAt: snapshot.overview.generatedAt, canManage, activeAllocationSetId: active?.id ?? null, credits: { budget: budget || null, requested, reserved, committed: reserved + spent, reported, spent, remaining: budget ? Math.max(0, budget - reserved - spent) : null, overrun }, projects, agentClasses: classes };
}

function pageCursor(value: string | null) {
	if (!value) return null;
	try { const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); return typeof parsed.id === 'string' ? parsed.id : null; }
	catch { return null; }
}

function nextCursor(id: string | undefined) {
	return id ? Buffer.from(JSON.stringify({ id }), 'utf8').toString('base64url') : null;
}

function deltaCursor(value: string | undefined) {
	if (!value) return null;
	try {
		const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
		return typeof parsed.revision === 'string' && Array.isArray(parsed.ids)
			? { revision: parsed.revision, ids: parsed.ids.filter((id: unknown): id is string => typeof id === 'string') }
			: null;
	} catch { return null; }
}

function encodeDeltaCursor(revision: string, ids: string[]) {
	return Buffer.from(JSON.stringify({ revision, ids }), 'utf8').toString('base64url');
}

function installProjectionRoutes(app: Hono, dependencies: WorkdayRouteDependencies) {
	app.get('/v1/teams/:teamId/agent-lab/workday-context', async (c) => {
		const context = await projectionContext(c, dependencies); if (context.response) return context.response;
		const { snapshot } = context as Exclude<typeof context, { response: Response }>;
		return response(c, snapshot.overview.workdayContext, snapshot.overview.revision);
	});

	app.get('/v1/teams/:teamId/agent-lab/overview', async (c) => {
		const context = await projectionContext(c, dependencies); if (context.response) return context.response;
		const { snapshot } = context as Exclude<typeof context, { response: Response }>;
		return notModified(c, snapshot.overview.revision) ?? response(c, snapshot.overview, snapshot.overview.revision);
	});

	app.get('/v1/teams/:teamId/agent-lab/activity', async (c) => {
		const context = await projectionContext(c, dependencies); if (context.response) return context.response;
		const { service, snapshot } = context as Exclude<typeof context, { response: Response }>;
		const prior = deltaCursor(c.req.query('cursor')); const intervals = service.activity(snapshot.rows);
		const unchanged = prior?.revision === snapshot.overview.revision; const ids = intervals.map((item) => item.id);
		const payload = { revision: snapshot.overview.revision, generatedAt: snapshot.overview.generatedAt,
			cursor: encodeDeltaCursor(snapshot.overview.revision, ids), upserts: unchanged ? [] : intervals,
			removedIds: unchanged ? [] : (prior?.ids ?? []).filter((id) => !ids.includes(id)) };
		return notModified(c, snapshot.overview.revision) ?? response(c, payload, snapshot.overview.revision);
	});

	app.get('/v1/teams/:teamId/agent-lab/metric-series', async (c) => {
		const context = await projectionContext(c, dependencies); if (context.response) return context.response;
		const { service, snapshot } = context as Exclude<typeof context, { response: Response }>;
		const prior = deltaCursor(c.req.query('cursor')); const points = service.series(snapshot.rows, snapshot.overview.operatingDay, new Date(snapshot.overview.generatedAt));
		const unchanged = prior?.revision === snapshot.overview.revision; const ids = points.map((item) => item.id);
		const payload = { revision: snapshot.overview.revision, generatedAt: snapshot.overview.generatedAt,
			cursor: encodeDeltaCursor(snapshot.overview.revision, ids), upserts: unchanged ? [] : points,
			removedIds: unchanged ? [] : (prior?.ids ?? []).filter((id) => !ids.includes(id)) };
		return notModified(c, snapshot.overview.revision) ?? response(c, payload, snapshot.overview.revision);
	});

	app.get('/v1/teams/:teamId/agent-lab/allocation', async (c) => {
		const context = await projectionContext(c, dependencies); if (context.response) return context.response;
		const { snapshot } = context as Exclude<typeof context, { response: Response }>;
		const management = await dependencies.manage(c); const payload = await allocationSnapshot(dependencies, c.req.param('teamId'), snapshot, !management.response);
		return notModified(c, payload.revision) ?? response(c, payload, payload.revision);
	});

	app.post('/v1/teams/:teamId/agent-lab/allocation', async (c) => {
		const access = await dependencies.manage(c); if (access.response) return access.response;
		const context = await projectionContext(c, dependencies); if (context.response) return context.response;
		const { snapshot } = context as Exclude<typeof context, { response: Response }>; const body = await readCapacityRequestObject(c);
		const percentages = (value: unknown) => Array.isArray(value) ? value.flatMap((entry) => { const item = object(entry); const percentage = Number(item.percentage); return text(item.id) && Number.isFinite(percentage) && percentage >= 0 ? [{ id: text(item.id), percentage }] : []; }) : [];
		const scope = text(body.scope); const projectId = text(body.projectId); const values = percentages(body.slices); const total = values.reduce((sum, item) => sum + item.percentage, 0);
		const projectIds = new Set(snapshot.rows.projects.map((row) => text(row.id))); const classIds = new Set(snapshot.rows.classes.filter((row) => text(row.project_id) === projectId).map((row) => text(row.id)));
		const eligible = scope === 'portfolio' ? projectIds : scope === 'agent-class' && projectIds.has(projectId) ? classIds : null;
		if (!eligible || values.length !== eligible.size || values.some((item) => !eligible.has(item.id)) || Math.abs(total - 100) > .001) return c.json({ ok: false, code: 'agent_lab_allocation_invalid', error: 'The selected allocation scope must contain every eligible entry and total exactly 100%.' }, 422);
		const service = new CapacityAllocationService(dependencies.store); const active = await service.getActive(c.req.param('teamId')); const allocationId = randomUUID();
		const baseProjectSlices = snapshot.rows.projects.map((project, index) => { const targetId = text(project.id); const existing = active?.slices.find((slice) => slice.scope === 'project' && slice.targetId === targetId); return existing ?? { id: `${allocationId}:project:${targetId}`, scope: 'project' as const, targetId, policy: { minPercent: 0, targetPercent: 100 / Math.max(1, snapshot.rows.projects.length), maxPercent: 100, hardCapPercent: 100 } }; });
		let slices = active ? [...active.slices] : [...baseProjectSlices]; for (const projectSlice of baseProjectSlices) if (!slices.some((slice) => slice.id === projectSlice.id)) slices.push(projectSlice);
		if (scope === 'portfolio') slices = slices.map((slice) => slice.scope !== 'project' ? slice : { ...slice, policy: { ...slice.policy, targetPercent: values.find((item) => item.id === slice.targetId)!.percentage } });
		else {
			const parent = slices.find((slice) => slice.scope === 'project' && slice.targetId === projectId)!; const priorClasses = slices.filter((slice) => slice.scope === 'agent-class' && slice.parentSliceId === parent.id); const priorIds = new Set(priorClasses.map((slice) => slice.id)); const retainedIds = new Set<string>();
			const replacements = values.map((item) => { const prior = priorClasses.find((slice) => slice.targetId === item.id); if (prior) retainedIds.add(prior.id); return prior ? { ...prior, policy: { ...prior.policy, targetPercent: item.percentage } } : { id: `${allocationId}:class:${item.id}`, scope: 'agent-class' as const, targetId: item.id, parentSliceId: parent.id, policy: { minPercent: 0, targetPercent: item.percentage, maxPercent: 100, hardCapPercent: 100 } }; });
			slices = [...slices.filter((slice) => !priorIds.has(slice.id) && !(slice.scope === 'mode' && priorIds.has(slice.parentSliceId ?? '') && !retainedIds.has(slice.parentSliceId ?? ''))), ...replacements];
		}
		const requestId = text(body.requestId, randomUUID()); const input = { id: allocationId, reservePolicy: active?.reservePolicy, borrowingRules: active?.borrowingRules ?? [], slices, metadata: { ...(active?.metadata ?? {}), source: 'agent-lab', updateScope: scope } };
		try { await service.create(c.req.param('teamId'), input, access.principal?.id ?? null, `agent-lab-allocation:create:${requestId}`); await service.supersede(c.req.param('teamId'), allocationId, typeof body.expectedActiveAllocationSetId === 'string' ? body.expectedActiveAllocationSetId : null, `agent-lab-allocation:activate:${requestId}`); return response(c, await allocationSnapshot(dependencies, c.req.param('teamId'), snapshot, true), `${snapshot.overview.revision}:${allocationId}`); }
		catch (error) { const value = error as { status?: number; code?: string; message?: string; diagnostics?: unknown }; return c.json({ ok: false, code: value.code ?? 'agent_lab_allocation_failed', error: value.message ?? 'Allocation could not be applied.', diagnostics: value.diagnostics }, (value.status ?? 409) as 400); }
	});
}

function installEntityRoutes(app: Hono, dependencies: WorkdayRouteDependencies) {
	app.get('/v1/teams/:teamId/agent-lab/entities', async (c) => {
		const kind = c.req.query('kind') as AgentLabEntityKind;
		if (!entityKinds.has(kind)) return c.json({ ok: false, code: 'agent_lab_entity_kind_invalid', error: 'Select a supported Agent Lab entity kind.' }, 400);
		const context = await projectionContext(c, dependencies); if (context.response) return context.response;
		const { service, snapshot } = context as Exclude<typeof context, { response: Response }>;
		const query = (c.req.query('q') ?? '').trim().toLowerCase(); const status = (c.req.query('status') ?? '').trim();
		const project = (c.req.query('projectId') ?? '').trim(); const profile = (c.req.query('activityProfile') ?? '').trim();
		const limit = Math.max(1, Math.min(Number(c.req.query('limit') ?? 25), 100));
		let items = service.entities(kind, snapshot).filter((item) => (!query || `${item.title} ${item.description}`.toLowerCase().includes(query))
			&& (!status || item.status === status) && (!project || item.projectId === project) && (!profile || item.activityProfile === profile));
		const afterId = pageCursor(c.req.query('cursor') ?? null); const start = afterId ? Math.max(0, items.findIndex((item) => item.id === afterId) + 1) : 0;
		const selected = items.slice(start, start + limit); const hasMore = start + limit < items.length;
		return response(c, { kind, items: selected, page: { limit, hasMore, nextCursor: hasMore ? nextCursor(selected.at(-1)?.id) : null }, total: items.length }, snapshot.overview.revision);
	});
}

function installSurfaceRoutes(app: Hono, dependencies: WorkdayRouteDependencies) {
	app.get('/v1/teams/:teamId/agent-lab/surfaces/:surface', async (c) => {
		const surface = c.req.param('surface');
		if (!commandSurfaces.has(surface)) return c.json({ ok: false, code: 'agent_lab_surface_invalid', error: 'Select a supported Agent Lab surface.' }, 400);
		const context = await projectionContext(c, dependencies); if (context.response) return context.response;
		const { snapshot, access } = context as Exclude<typeof context, { response: Response }>;
		const query = (c.req.query('q') ?? '').trim();
		const service = new AgentLabCommandService(dependencies.store); const payload = await service.surface(surface as 'inbox' | 'decisions' | 'build' | 'direction' | 'results' | 'find', snapshot, query);
		if (surface === 'build') {
			const definitions = await agentLabRepositoryDefinitions(dependencies, snapshot.rows.projects);
			const repositoryAgents = definitions.filter((item) => item.kind === 'agent');
			payload.items = payload.items.map((item) => {
				if (item.kind !== 'agent') return item;
				const definition = repositoryAgents.find((candidate) => matchesAgentDefinition(item, candidate));
				return definition ? { ...item, status: definition.status, tags: [...(item.tags ?? []), 'TreeDX definition'], data: { ...object(item.data), definition: definition.data } } : item;
			});
			payload.items.push(...definitions.filter((item) => item.kind !== 'agent') as typeof payload.items); payload.page.total = payload.items.length;
			const byContract = new Map(definitions.map((item) => [text(item.data.contractId),item]));
			for (const agent of payload.items.filter((item) => item.kind === 'agent')) {
				const agentData = jsonObject(agent.data); const repository = jsonObject(agentData.definition); const repositoryActivities = jsonObject(repository.activities);
				const refs = jsonObject(agentData.handler_refs_json); const configuredAgents = Object.keys(repositoryActivities).length ? [{ activities: repositoryActivities }] : Array.isArray(refs.agents) ? refs.agents.map(object) : [];
				for (const configured of configuredAgents) for (const [profileId,profileValue] of Object.entries(object(configured.activities))) {
					const profile = object(profileValue); for (const [direction,owner] of [['input',object(profile.inputs)],['output',object(profile.outputs)]] as const) for (const field of ['artifactContracts','signalContracts']) for (const contractId of Array.isArray(owner[field]) ? owner[field].map(text) : []) {
						const contract = byContract.get(contractId); if (!contract) continue; const from = direction === 'input' ? contract.id : agent.id; const to = direction === 'input' ? agent.id : contract.id;
						payload.relations = [...(payload.relations ?? []), { id: `${agent.id}:${profileId}:${direction}:${contractId}`, from, to, label: `${profileId} ${direction}`, tone: direction }];
					}
				}
			}
			payload.metrics = [...(payload.metrics ?? []), { label: 'Repository contracts', value: definitions.length, detail: 'Scenes, seeds, artifacts, and signals' }];
		}
		if (surface === 'find') {
			const repositoryItems = await relationResults(dependencies, snapshot.rows.projects, query);
			payload.items.push(...repositoryItems as typeof payload.items);
			payload.page.total = payload.items.length;
			payload.metrics = [{ label: 'Matched records', value: payload.items.length, detail: repositoryItems.length ? `${repositoryItems.length} from TreeDX` : 'Control-plane matches' }];
		}
		const projected = withViewState(payload, await viewState(dependencies, access.principal?.id, c.req.param('teamId'))); const revision = service.revision(projected);
		return notModified(c, revision) ?? response(c, projected, revision);
	});
}

function installViewStateRoutes(app: Hono, dependencies: WorkdayRouteDependencies) {
	app.get('/v1/teams/:teamId/agent-lab/view-state', async (c) => {
		const access = await dependencies.read(c); if (access.response) return access.response;
		const rows = await viewState(dependencies, access.principal?.id, c.req.param('teamId'), c.req.query('namespace') ?? 'command');
		return c.json({ ok: true, payload: rows.map((row) => ({ kind: row.entity_kind, id: row.entity_id, pinned: Number(row.pinned) === 1, hidden: Number(row.hidden) === 1, resolved: Number(row.resolved) === 1, layout: (() => { try { return JSON.parse(String(row.layout_json ?? '{}')); } catch { return {}; } })(), version: Number(row.version ?? 1) })) });
	});

	app.patch('/v1/teams/:teamId/agent-lab/view-state', async (c) => {
		const access = await dependencies.read(c); if (access.response) return access.response;
		if (!access.principal?.id) return c.json({ ok: false, code: 'authentication_required', error: 'Sign in to save an Agent Lab view.' }, 401);
		const body = await readCapacityRequestObject(c); const kind = typeof body.kind === 'string' ? body.kind : ''; const entityId = typeof body.id === 'string' ? body.id : '';
		if (!commandKinds.has(kind) || !entityId) return c.json({ ok: false, code: 'agent_lab_view_state_invalid', error: 'Provide a supported record type and ID.' }, 400);
		const namespace = typeof body.namespace === 'string' && body.namespace ? body.namespace : 'command'; const existing = await dependencies.store.first(`SELECT * FROM agent_lab_view_state WHERE user_id = ? AND team_id = ? AND namespace = ? AND entity_kind = ? AND entity_id = ? LIMIT 1`, [access.principal.id, c.req.param('teamId'), namespace, kind, entityId]);
		if (body.expectedVersion !== undefined && Number(body.expectedVersion) !== Number(existing?.version ?? 0)) return c.json({ ok: false, code: 'agent_lab_view_state_stale', error: 'This personal view changed in another session.', currentVersion: Number(existing?.version ?? 0) }, 409);
		const now = new Date().toISOString(); const version = Number(existing?.version ?? 0) + 1; const values = { pinned: body.pinned === undefined ? Number(existing?.pinned ?? 0) : body.pinned ? 1 : 0, hidden: body.hidden === undefined ? Number(existing?.hidden ?? 0) : body.hidden ? 1 : 0, resolved: body.resolved === undefined ? Number(existing?.resolved ?? 0) : body.resolved ? 1 : 0, layout: body.layout === undefined ? String(existing?.layout_json ?? '{}') : JSON.stringify(body.layout ?? {}) };
		if (existing) await dependencies.store.run(`UPDATE agent_lab_view_state SET pinned = ?, hidden = ?, resolved = ?, layout_json = ?, version = ?, updated_at = ? WHERE id = ?`, [values.pinned, values.hidden, values.resolved, values.layout, version, now, existing.id]);
		else await dependencies.store.run(`INSERT INTO agent_lab_view_state (id, user_id, team_id, namespace, entity_kind, entity_id, pinned, hidden, resolved, layout_json, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [randomUUID(), access.principal.id, c.req.param('teamId'), namespace, kind, entityId, values.pinned, values.hidden, values.resolved, values.layout, version, now, now]);
		return c.json({ ok: true, payload: { kind, id: entityId, ...values, layout: JSON.parse(values.layout), version } });
	});
}

function installAuthoringRoutes(app: Hono, dependencies: WorkdayRouteDependencies) {
	app.post('/v1/teams/:teamId/agent-lab/surfaces/build/authoring', async (c) => {
		const access = await dependencies.manage(c); if (access.response) return access.response;
		const body = await readCapacityRequestObject(c); const projectId = typeof body.projectId === 'string' ? body.projectId : ''; const path = typeof body.path === 'string' ? body.path.replace(/^\/+|\/+$/gu, '') : ''; const source = typeof body.source === 'string' ? body.source : '';
		const project = projectId ? await dependencies.store.first(`SELECT id, name FROM projects WHERE id = ? AND team_id = ? LIMIT 1`, [projectId, c.req.param('teamId')]) : null;
		if (!project) return c.json({ ok: false, code: 'agent_lab_authoring_project_invalid', error: 'Choose a project in this team.' }, 422);
		const allowed = /^(?:src\/content\/agents\/[^/]+(?:\/[^/]+)*\.mdx|\.treeseed\/agents\/artifacts\/[^/]+\.ya?ml|\.treeseed\/seeds\/[^/]+\.ya?ml|scenes\/[^/]+(?:\/[^/]+)*\.ya?ml)$/u;
		if (!allowed.test(path)) return c.json({ ok: false, code: 'agent_lab_authoring_path_invalid', error: 'Choose an agent, artifact contract, seed, or scene path.' }, 422);
		if (!source.trim()) return c.json({ ok: false, code: 'agent_lab_authoring_source_required', error: 'Source cannot be empty.' }, 422);
		const agentValidation = path.endsWith('.mdx') ? validateAgentDefinitionSource(source) : null;
		if (agentValidation && !agentValidation.ok) return c.json({ ok: false, code: 'agent_definition_invalid', error: 'The agent definition is invalid.', diagnostics: agentValidation.diagnostics }, 422);
		if (/\.ya?ml$/u.test(path)) { try { const parsed = parseYaml(source); if (path.includes('/artifacts/')) { const validation = validateAgentArtifactContract(parsed); if (!validation.ok) return c.json({ ok: false, code: 'agent_artifact_invalid', error: 'The artifact contract is invalid.', diagnostics: validation.diagnostics }, 422); } else if (!parsed || typeof parsed !== 'object') return c.json({ ok: false, code: 'agent_lab_yaml_invalid', error: 'The definition must be a YAML object.' }, 422); } catch (error) { return c.json({ ok: false, code: 'agent_lab_yaml_invalid', error: error instanceof Error ? error.message : 'The YAML is invalid.' }, 422); } }
		const connection = await resolveKnowledgeGatewayConnection(dependencies.store, { projectId, write: true, authoringPaths: true });
		if (!connection) return c.json({ ok: false, code: 'agent_lab_treedx_unavailable', error: 'The project TreeDX repository is unavailable.' }, 503);
		const branchName = `refs/heads/${connection.authoringBranch.replace(/^refs\/heads\//u, '')}`; const workspace = await connection.client.createWorkspace({ repoId: connection.repositoryId, baseRef: branchName, branchName, mode: 'writable', allowedPaths: connection.allowedPaths, ttlSeconds: 600 });
		if (typeof body.expectedBase === 'string' && body.expectedBase && body.expectedBase !== workspace.baseCommitSha) { await connection.client.closeWorkspace(workspace.workspaceId).catch(() => {}); return c.json({ ok: false, code: 'agent_lab_authoring_conflict', error: 'The authoring branch changed. Compare against the current source before saving.', currentBase: workspace.baseCommitSha }, 409); }
		if (agentValidation?.references.length) {
			const paths = [...new Set(agentValidation.references.map((reference) => `.treeseed/agents/artifacts/${reference.id}.yaml`))];
			const existing = await connection.client.readRepositoryFiles({ repoId: connection.repositoryId, ref: workspace.baseCommitSha, paths, encoding: 'utf8', parseFrontmatter: false, allowProtected: true }).catch(() => ({ files: [] }));
			const found = new Map((existing.files ?? []).map((file: unknown) => [text(object(file).path), text(object(file).content)])); const diagnostics: Array<{ path: string; message: string }> = [];
			for (const reference of agentValidation.references) { const contractPath = `.treeseed/agents/artifacts/${reference.id}.yaml`; const content = found.get(contractPath); if (!content) { diagnostics.push({ path: contractPath, message: `Missing ${reference.kind} contract ${reference.id}.` }); continue; } try { const parsed = object(parseYaml(content)); const validation = validateAgentArtifactContract(parsed); if (!validation.ok || text(parsed.kind) !== reference.kind) diagnostics.push({ path: contractPath, message: `${reference.id} must be a valid ${reference.kind} contract.` }); } catch { diagnostics.push({ path: contractPath, message: `${reference.id} is not valid YAML.` }); } }
			if (diagnostics.length) { await connection.client.closeWorkspace(workspace.workspaceId).catch(() => {}); return c.json({ ok: false, code: 'agent_contract_reference_invalid', error: 'The agent references missing or incompatible artifact/signal contracts.', diagnostics }, 422); }
		}
		try { await connection.client.writeFile({ workspaceId: workspace.workspaceId, path, content: source, encoding: 'utf8', ...(typeof body.expectedSha === 'string' && body.expectedSha ? { expectedSha: body.expectedSha } : {}) }); const commit = await connection.client.commit({ workspaceId: workspace.workspaceId, message: `agent-lab: update ${path}`, author: { name: access.principal?.name ?? access.principal?.id ?? 'Agent Lab operator', email: access.principal?.email ?? 'agent-lab@users.treeseed.local' } }); await dependencies.store.run(`INSERT INTO audit_events (id, actor_type, actor_id, event_type, target_type, target_id, data_json, created_at) VALUES (?, 'user', ?, 'agent_lab.authoring.committed', 'project', ?, ?, ?)`, [randomUUID(), access.principal?.id ?? null, projectId, JSON.stringify({ path, commitSha: commit.commitSha, branchName: commit.branchName }), new Date().toISOString()]); return c.json({ ok: true, payload: { commit: commit.commitSha, branch: commit.branchName, changedPaths: commit.changedPaths } }); } catch (error) { await connection.client.closeWorkspace(workspace.workspaceId).catch(() => {}); return c.json({ ok: false, code: 'agent_lab_authoring_failed', error: error instanceof Error ? error.message : 'TreeDX could not commit the definition.' }, 409); }
	});
}

function installServicePrincipalRoutes(app: Hono, dependencies: WorkdayRouteDependencies) {
	app.post('/v1/teams/:teamId/agent-lab/service-principal/reconcile', async (c) => {
		const access = await dependencies.manage(c); if (access.response) return access.response;
		const localRuntime = dependencies.environment === 'local'
			|| process.env.TREESEED_API_ENVIRONMENT === 'local'
			|| process.env.TREESEED_ENVIRONMENT === 'local'
			|| process.env.LOCAL_DEV_MODE === '1';
		if (!localRuntime || !dependencies.runtimeMarketAuthProvider) return c.json({ ok: false, code: 'agent_lab_service_principal_local_only', error: 'Agent Lab service principals are available only in the managed local environment.' }, 403);
		const body = await readCapacityRequestObject(c); const resourceKey = text(body.resourceKey); const name = text(body.name, 'Agent Lab Operations Runner');
		if (!/^service-principal:[a-z0-9._/-]+$/u.test(resourceKey)) return c.json({ ok: false, code: 'agent_lab_service_principal_key_invalid', error: 'Provide a stable service-principal resource key.' }, 422);
		const serviceId = `agent-lab-${createHash('sha256').update(`${c.req.param('teamId')}:${resourceKey}`).digest('hex').slice(0, 24)}`;
		const credential = await dependencies.runtimeMarketAuthProvider.createServiceToken({ serviceId, name, roles: [], permissions: [] });
		const membership = await dependencies.store.upsertTeamMember(c.req.param('teamId'), serviceId, 'team_owner');
		const team = await dependencies.store.first(`SELECT metadata_json FROM teams WHERE id = ? LIMIT 1`, [c.req.param('teamId')]); const metadata = object(typeof team?.metadata_json === 'string' ? (() => { try { return JSON.parse(team.metadata_json); } catch { return {}; } })() : {});
		metadata.agentLab = { ...object(metadata.agentLab), servicePrincipalId: serviceId, servicePrincipalResourceKey: resourceKey };
		const now = new Date().toISOString(); await dependencies.store.run(`UPDATE teams SET metadata_json = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(metadata), now, c.req.param('teamId')]);
		await dependencies.store.run(`INSERT INTO audit_events (id, actor_type, actor_id, event_type, target_type, target_id, data_json, created_at) VALUES (?, 'user', ?, 'agent_lab.service_principal.reconciled', 'team', ?, ?, ?)`, [randomUUID(), access.principal?.id ?? null, c.req.param('teamId'), JSON.stringify({ resourceKey, serviceId, membershipId: membership?.id ?? null, credentialId: credential.id }), now]);
		return c.json({ ok: true, payload: { serviceId, credentialId: credential.id, credential: credential.secret, membershipId: membership?.id ?? null, roles: ['team_owner'] } });
	});
}

function installSimulationRoutes(app: Hono, dependencies: WorkdayRouteDependencies) {
	app.post('/v1/teams/:teamId/agent-lab/simulations', async (c) => {
		const access = await dependencies.manage(c); if (access.response) return access.response;
		const body = await readCapacityRequestObject(c); const scenePath = typeof body.scenePath === 'string' ? body.scenePath : ''; const immutableRef = typeof body.immutableRef === 'string' ? body.immutableRef : '';
		if (!/^scenes\/[a-z0-9._/-]+\.ya?ml$/iu.test(scenePath) || !/^[a-f0-9]{40,64}$/iu.test(immutableRef)) return c.json({ ok: false, code: 'agent_lab_simulation_definition_invalid', error: 'Choose a repository scene and its immutable commit SHA.' }, 422);
		const requestedProjectId = typeof body.projectId === 'string' ? body.projectId : '';
		const project = requestedProjectId
			? await dependencies.store.first(`SELECT id, name FROM projects WHERE id = ? AND team_id = ? LIMIT 1`, [requestedProjectId, c.req.param('teamId')])
			: await dependencies.store.first(`SELECT id, name FROM projects WHERE team_id = ? ORDER BY CASE WHEN slug = 'market' THEN 0 ELSE 1 END, created_at ASC LIMIT 1`, [c.req.param('teamId')]);
		if (!project) return c.json({ ok: false, code: 'agent_lab_simulation_project_invalid', error: 'Choose a repository-backed project in this team.' }, 422);
		const connection = await resolveKnowledgeGatewayConnection(dependencies.store, { projectId: text(project.id), write: false, readRefs: [immutableRef], authoringPaths: true });
		if (!connection) return c.json({ ok: false, code: 'agent_lab_simulation_treedx_unavailable', error: 'The project TreeDX repository is unavailable.' }, 503);
		let sceneSource = '';
		try {
			const read = await connection.client.readRepositoryFile({ repoId: connection.repositoryId, ref: immutableRef, path: scenePath, encoding: 'utf8', maxBytes: 196_608, allowProtected: true });
			sceneSource = text(object(read.file).content);
			const parsed = parseYaml(sceneSource);
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The scene is not a YAML object.');
			if (text(object(parsed).schemaVersion) !== 'treeseed.scene/v1') throw new Error('The scene must use treeseed.scene/v1.');
		} catch (error) {
			return c.json({ ok: false, code: 'agent_lab_simulation_ref_invalid', error: error instanceof Error ? error.message : 'TreeDX could not read the scene at that commit.' }, 422);
		}
		const team = await dependencies.store.first(`SELECT metadata_json FROM teams WHERE id = ? LIMIT 1`, [c.req.param('teamId')]); const servicePrincipalId = text(object(object(typeof team?.metadata_json === 'string' ? (() => { try { return JSON.parse(team.metadata_json); } catch { return {}; } })() : {}).agentLab).servicePrincipalId);
		if (!servicePrincipalId) return c.json({ ok: false, code: 'agent_lab_service_principal_missing', error: 'Apply the team seed to reconcile the local Agent Lab service principal before launching simulations.' }, 409);
		const id = randomUUID(); const now = new Date().toISOString(); const input = { teamId: c.req.param('teamId'), projectId: text(project.id), scenePath, sceneSource, immutableRef, environment: 'local', initiatingUserId: access.principal?.id ?? null, executingServicePrincipalId: servicePrincipalId };
		await dependencies.store.run(`INSERT INTO platform_operations (id, namespace, operation, status, target, idempotency_key, input_json, output_json, error_json, requested_by_type, requested_by_id, assigned_runner_id, lease_expires_at, created_at, updated_at, started_at, finished_at, cancelled_at) VALUES (?, 'agent-lab', 'run-scene', 'queued', 'market_operations_runner', ?, ?, NULL, NULL, 'user', ?, NULL, NULL, ?, ?, NULL, NULL, NULL)`, [id, `agent-lab:${c.req.param('teamId')}:${immutableRef}:${scenePath}`, JSON.stringify(input), access.principal?.id ?? null, now, now]);
		await dependencies.store.run(`INSERT INTO platform_operation_events (id, operation_id, seq, kind, data_json, created_at) VALUES (?, ?, 1, 'created', ?, ?)`, [randomUUID(), id, JSON.stringify({ namespace: 'agent-lab', operation: 'run-scene', initiatingUserId: access.principal?.id ?? null, executingServicePrincipalId: servicePrincipalId }), now]);
		return c.json({ ok: true, payload: { id, status: 'queued', scenePath, immutableRef, initiatingUserId: access.principal?.id ?? null, executingServicePrincipalId: servicePrincipalId } }, 202);
	});

	app.post('/v1/teams/:teamId/agent-lab/simulations/:operationId/cancel', async (c) => {
		const access = await dependencies.manage(c); if (access.response) return access.response;
		const operation = await dependencies.store.first(`SELECT * FROM platform_operations WHERE id = ? AND namespace = 'agent-lab' LIMIT 1`, [c.req.param('operationId')]);
		if (!operation) return dependencies.notFound(c, 'Unknown simulation operation.');
		if (!['queued', 'leased', 'running'].includes(String(operation.status))) return c.json({ ok: false, code: 'agent_lab_simulation_not_cancellable', error: 'This simulation is already terminal.' }, 409);
		const now = new Date().toISOString(); await dependencies.store.run(`UPDATE platform_operations SET status = 'cancelled', cancelled_at = ?, finished_at = ?, updated_at = ? WHERE id = ?`, [now, now, now, operation.id]);
		return c.json({ ok: true, payload: { id: operation.id, status: 'cancelled' } });
	});

	app.get('/v1/teams/:teamId/agent-lab/simulations/:operationId/report', async (c) => {
		const access = await dependencies.read(c); if (access.response) return access.response;
		const operation = await dependencies.store.first(`SELECT input_json, output_json, status FROM platform_operations WHERE id = ? AND namespace = 'agent-lab' LIMIT 1`, [c.req.param('operationId')]);
		if (!operation || text(object(JSON.parse(text(operation.input_json) || '{}')).teamId) !== c.req.param('teamId')) return dependencies.notFound(c, 'Unknown simulation report.');
		const reportPath = text(object(JSON.parse(text(operation.output_json) || '{}')).reportPath);
		if (!reportPath) return c.json({ ok: false, code: 'agent_lab_report_pending', error: `The report is not available while the simulation is ${text(operation.status, 'pending')}.` }, 409);
		const reportRoot = resolve(dependencies.store.config.repoRoot ?? process.cwd(), '.treeseed/scenes/runs'); const absolute = resolve(reportPath); const local = relative(reportRoot, absolute);
		if (!local || local.startsWith('../') || local.startsWith('..\\') || !absolute.endsWith('/report.html')) return c.json({ ok: false, code: 'agent_lab_report_path_invalid', error: 'The retained report path is invalid.' }, 500);
		try { return new Response(await readFile(absolute, 'utf8'), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'" } }); }
		catch { return dependencies.notFound(c, 'The retained simulation report is no longer available.'); }
	});
}

function installDetailRoutes(app: Hono, dependencies: WorkdayRouteDependencies) {
	app.get('/v1/teams/:teamId/agent-lab/details/:kind/:entityId', async (c) => {
		const kind = c.req.param('kind');
		if (!commandKinds.has(kind)) return c.json({ ok: false, code: 'agent_lab_detail_kind_invalid', error: 'Select a supported Agent Lab record type.' }, 400);
		const context = await projectionContext(c, dependencies); if (context.response) return context.response;
		const { snapshot } = context as Exclude<typeof context, { response: Response }>;
		const entityId = c.req.param('entityId');
		if (entityId.startsWith('definition:')) {
			const [, projectId, ...pathParts] = entityId.split(':'); const path = pathParts.join(':'); const project = snapshot.rows.projects.find((row) => text(row.id) === projectId);
			if (!project) return dependencies.notFound(c, 'Unknown repository definition.');
			const connection = await resolveKnowledgeGatewayConnection(dependencies.store, { projectId, write: false, authoringPaths: true }).catch(() => null);
			const read = connection ? await connection.client.readRepositoryFile({ repoId: connection.repositoryId, ref: connection.baseRef, path, encoding: 'utf8', maxBytes: 196_608, allowProtected: true }).catch(() => null) : null; const file = object(read?.file);
			if (!text(file.content)) return dependencies.notFound(c, 'Unknown repository definition.');
			const title = path.split('/').at(-1)?.replace(/\.ya?ml$/u, '').replace(/[-_]/gu, ' ') ?? path;
			const language = path.endsWith('.mdx') ? 'mdx' : 'yaml'; const source = text(file.content); const expectedBase = text(read?.resolvedRef, connection?.baseRef);
			const payload = { id: entityId, kind, title, description: path, status: 'repository definition', projectId, projectName: text(project.name), primary: { actor: { label: 'Repository owner', name: text(project.name, 'Project team'), detail: 'project' }, content: { label: 'Definition', body: `${title} is the active repository-backed ${kind.replace(/-/gu, ' ')} definition.`, classification: kind.replace(/-/gu, ' '), missing: false }, facts: [{ label: 'Project', value: text(project.name) }, { label: 'Path', value: path }] }, permissions: { note: true, question: true, edit: true }, metrics: [{ label: 'Bytes', value: Buffer.byteLength(source, 'utf8') }], sections: [{ id: 'source', title: 'Canonical repository source', fields: [{ label: 'Immutable base ref', value: expectedBase }, { label: 'Path', value: path }, { label: `${language.toUpperCase()} source`, value: source }] }], timeline: [], related: await knowledgeConversation(dependencies, projectId, entityId), data: { projectId, path, ref: expectedBase, source, authoring: { source, path, language, expectedBase, projectId, projectName: text(project.name) } } };
			return response(c, payload, new AgentLabCommandService(dependencies.store).revision(payload));
		}
		if (entityId.startsWith('treedx:')) {
			const [, projectId, relationKind, ...identity] = entityId.split(':'); const project = snapshot.rows.projects.find((row) => text(row.id) === projectId);
			if (!project) return dependencies.notFound(c, 'Unknown TreeDX relationship.');
			const connection = await resolveKnowledgeGatewayConnection(dependencies.store, { projectId, write: false, relationPaths: true }).catch(() => null);
			const match = connection ? (await searchRelations(connection, identity.join(':'), new Set(relationKind ? [relationKind] : [])).catch(() => [])).find((entry: Record<string, unknown>) => text(entry.id) === identity.join(':')) : null;
			if (!match) return dependencies.notFound(c, 'Unknown TreeDX relationship.');
			const read = connection && text(match.path) ? await connection.client.readRepositoryFile({ repoId: connection.repositoryId, ref: connection.baseRef, path: text(match.path), encoding: 'utf8', maxBytes: 196_608 }).catch(() => null) : null;
			const content = repositoryBody(text(object(read?.file).content, match.summary));
			const payload = { id: entityId, kind, title: text(match.title, 'Repository content'), description: text(match.summary), status: 'indexed', projectId, projectName: text(project.name), occurredAt: text(match.occurredAt) || null, primary: { actor: { label: kind === 'question' ? 'Asked by' : kind === 'note' ? 'Noted by' : 'Published by', name: text(match.author, 'Repository contributor'), detail: 'content author' }, postedAt: text(match.occurredAt) || null, content: { label: kind === 'question' ? 'Question' : kind === 'note' ? 'Note' : 'Content', body: content, classification: text(match.kind, kind), missing: !content }, facts: [{ label: 'Project', value: text(project.name) }, { label: 'Collection', value: text(match.kind) }] }, permissions: { note: true, question: true }, metrics: [{ label: 'TreeDX score', value: Number(match.score ?? 0) }], sections: [{ id: 'repository', title: 'Repository relationship', fields: [{ label: 'Collection', value: match.kind }, { label: 'Canonical identity', value: match.id }, { label: 'Path', value: match.path }, { label: 'Why it matched', value: match.summary }, { label: 'Complete source', value: object(read?.file).content }] }], timeline: [], related: await knowledgeConversation(dependencies, projectId, identity.join(':')), data: { ...match, content: object(read?.file).content } };
			return response(c, payload, new AgentLabCommandService(dependencies.store).revision(payload));
		}
		const service = new AgentLabCommandService(dependencies.store); const payload = await service.detail(kind as Parameters<AgentLabCommandService['detail']>[0], entityId, snapshot);
		if (!payload) return dependencies.notFound(c, 'Unknown Agent Lab record.');
		if (kind === 'agent') {
			const definitions = await agentLabRepositoryDefinitions(dependencies, snapshot.rows.projects);
			const definition = definitions.find((candidate) => matchesAgentDefinition(payload, candidate));
			if (definition) {
				const definitionData = object(definition.data); const path = text(definitionData.path);
				const connection = await resolveKnowledgeGatewayConnection(dependencies.store, { projectId: text(payload.projectId), write: false, authoringPaths: true }).catch(() => null);
				const read = connection && path ? await connection.client.readRepositoryFile({ repoId: connection.repositoryId, ref: connection.baseRef, path, encoding: 'utf8', maxBytes: 393_216, allowProtected: true }).catch(() => null) : null;
				const source = text(object(read?.file).content); const activities = object(definitionData.activities); const contractIds = new Set<string>();
				for (const profile of Object.values(activities).map(object)) for (const direction of ['inputs','outputs']) for (const field of ['artifactContracts','signalContracts']) for (const contractId of Array.isArray(object(profile[direction])[field]) ? object(profile[direction])[field] as unknown[] : []) if (text(contractId)) contractIds.add(text(contractId));
				payload.permissions = { ...(payload.permissions ?? {}), edit: Boolean(source) };
				payload.data = { ...object(payload.data), definition: definitionData, authoring: source ? { source, path, language: 'mdx', expectedBase: text(read?.resolvedRef, connection?.baseRef), projectId: payload.projectId, projectName: payload.projectName } : null };
				payload.sections = [{ id: 'profiles', title: 'Activity profile contracts', fields: Object.entries(activities).map(([profileId, profile]) => ({ label: profileId, value: { handler: object(profile).handler, stage: object(object(profile).planningIntent).stage, inputs: object(profile).inputs, outputs: object(profile).outputs } })) }, ...(payload.sections ?? [])];
				payload.related = [...definitions.filter((candidate) => contractIds.has(text(object(candidate.data).contractId))), ...(payload.related ?? [])] as typeof payload.related;
			}
		}
		const conversation = await knowledgeConversation(dependencies, text(payload.projectId), entityId);
		payload.related = [...conversation, ...(payload.related ?? [])] as typeof payload.related;
		return notModified(c, service.revision(payload)) ?? response(c, payload, service.revision(payload));
	});
}

function installTargetRoutes(app: Hono, dependencies: WorkdayRouteDependencies) {
	app.patch('/v1/teams/:teamId/agent-lab/targets', async (c) => {
		const access = await dependencies.manage(c); if (access.response) return access.response;
		const body = await readCapacityRequestObject(c, { optional: true }); const requested = body.targets;
		if (!requested || typeof requested !== 'object' || Array.isArray(requested)) return c.json({ ok: false, code: 'agent_lab_targets_invalid', error: 'Provide metric targets as an object.' }, 400);
		const team = await dependencies.store.first(`SELECT metadata_json, updated_at FROM teams WHERE id = ? LIMIT 1`, [c.req.param('teamId')]);
		if (!team) return dependencies.notFound(c, 'Unknown team.');
		if (typeof body.expectedRevision === 'string' && body.expectedRevision !== team.updated_at) return c.json({ ok: false, code: 'agent_lab_targets_stale', error: 'Metric targets changed. Reload before saving again.' }, 409);
		const metadataValue = typeof team.metadata_json === 'string' ? (() => { try { return JSON.parse(team.metadata_json); } catch { return {}; } })() : {};
		const metadata = metadataValue && typeof metadataValue === 'object' && !Array.isArray(metadataValue) ? metadataValue : {};
		const prior = metadata.agentLab?.metricTargets && typeof metadata.agentLab.metricTargets === 'object' ? metadata.agentLab.metricTargets : {};
		const targets: Record<string, number> = Object.fromEntries(Object.entries(prior).filter(([key, value]) => agentLabMetricKeys.includes(key as typeof agentLabMetricKeys[number]) && typeof value === 'number' && Number.isFinite(value) && value >= 0));
		const input = requested as Record<string, unknown>;
		for (const key of agentLabMetricKeys) {
			if (!(key in input)) continue;
			if (input[key] === null || input[key] === '') { delete targets[key]; continue; }
			const value = Number(input[key]); if (!Number.isFinite(value) || value < 0) return c.json({ ok: false, code: 'agent_lab_target_invalid', error: `${key} target must be a nonnegative number.` }, 400);
			targets[key] = value;
		}
		const now = new Date().toISOString(); metadata.agentLab = { ...(metadata.agentLab ?? {}), metricTargets: targets };
		await dependencies.store.run(`UPDATE teams SET metadata_json = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(metadata), now, c.req.param('teamId')]);
		await dependencies.store.run(`INSERT INTO audit_events (id, actor_type, actor_id, event_type, target_type, target_id, data_json, created_at) VALUES (?, 'user', ?, 'agent_lab.metric_targets.updated', 'team', ?, ?, ?)`, [randomUUID(), access.principal?.id ?? null, c.req.param('teamId'), JSON.stringify({ metricKeys: Object.keys(targets) }), now]);
		return c.json({ ok: true, payload: { targets, revision: now } });
	});
}

export function installOperatorAgentLabRoutes(app: Hono, dependencies: WorkdayRouteDependencies) {
	installProjectionRoutes(app, dependencies);
	installEntityRoutes(app, dependencies);
	installSurfaceRoutes(app, dependencies);
	installViewStateRoutes(app, dependencies);
	installAuthoringRoutes(app, dependencies);
	installServicePrincipalRoutes(app, dependencies);
	installSimulationRoutes(app, dependencies);
	installDetailRoutes(app, dependencies);
	installTargetRoutes(app, dependencies);
}
