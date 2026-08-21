import { createHash } from 'node:crypto';
import {
	TREESEED_COMMAND_TREE_V1,
	listCommandPaths,
	type CommandNodeDescriptor,
} from '@treeseed/sdk/operator-contracts';
import { validateProviderSupplyOffer } from '@treeseed/sdk/capacity-provider';
import { validateRepositoryWorkdayProfileBundle } from '@treeseed/sdk/operator-contracts';
import type { Context, Hono } from 'hono';
import type { CapacityGovernanceDatabase } from '../../database.ts';
import { readCapacityRequestObject } from './request-json.ts';

type JsonObject = Record<string, unknown>;
type Mode = 'execute' | 'plan';

interface OperatorCommandStore extends CapacityGovernanceDatabase {
	getTeam(id: string): Promise<{ id: string } | null>;
	getTeamBySlug(slug: string): Promise<{ id: string } | null>;
	getProjectDetails(id: string): Promise<{ project: { id: string; teamId: string } } | null>;
	getProjectByTeamAndSlug(teamId: string, slug: string): Promise<{ id: string } | null>;
	updateCapacityWorkdayRun(teamId: string, runId: string, input: JsonObject): Promise<JsonObject | null>;
}

interface OperatorCommandOptions {
	store: CapacityGovernanceDatabase;
	requireTeamAccess(c: Context, store: CapacityGovernanceDatabase, teamId: string, permission: string): Promise<{ response?: Response | null }>;
}

interface OperatorCommandRequest {
	schemaVersion?: string;
	commandPath?: unknown;
	arguments?: unknown;
	options?: unknown;
	mode?: unknown;
	context?: unknown;
}

interface Dispatch {
	method: 'GET' | 'POST' | 'PATCH';
	path: string;
	body?: JsonObject;
}

const commandPaths = new Set(listCommandPaths(TREESEED_COMMAND_TREE_V1));

function leafKinds(nodes: CommandNodeDescriptor[], parent: string[] = [], output = new Map<string, 'read' | 'mutation'>()) {
	for (const node of nodes) {
		const path = [...parent, node.segment];
		if (node.nodeType === 'leaf') output.set(path.join(' '), node.kind);
		else leafKinds(node.children, path, output);
	}
	return output;
}

const commandKinds = leafKinds(TREESEED_COMMAND_TREE_V1.commands);
const clientLocal = new Set(['auth login', 'auth logout', 'auth status', 'secrets list', 'secrets status', 'secrets unlock', 'secrets lock', 'secrets rotate']);
const providerDocumentCommands = new Set(['providers offers validate', 'providers offers plan', 'providers offers apply']);
const workflowCommands = new Set(['save', 'stage', 'release']);
const manageCommands = new Set([
	...listCommandPaths(TREESEED_COMMAND_TREE_V1).filter((path) => commandKinds.get(path) === 'mutation'),
	'workdays plan',
]);

function object(value: unknown): JsonObject {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function text(value: unknown) {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function values(value: unknown) {
	return Array.isArray(value) ? value.map(String) : [];
}

function query(input: JsonObject) {
	const output = new URLSearchParams();
	for (const [key, value] of Object.entries(input)) {
		if (value === null || value === undefined || value === '') continue;
		output.set(key, String(value));
	}
	const encoded = output.toString();
	return encoded ? `?${encoded}` : '';
}

function digest(value: unknown) {
	return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

async function resolveContext(store: OperatorCommandStore, input: JsonObject) {
	const teamSelector = text(input.teamId) ?? text(input.team);
	const team = teamSelector ? await store.getTeam(teamSelector) ?? await store.getTeamBySlug(teamSelector) : null;
	const projectSelector = text(input.projectId) ?? text(input.project);
	let project = projectSelector ? await store.getProjectDetails(projectSelector) : null;
	if (!project && team && projectSelector) {
		const selected = await store.getProjectByTeamAndSlug(team.id, projectSelector);
		project = selected ? await store.getProjectDetails(selected.id) : null;
	}
	return { teamId: team?.id ?? project?.project.teamId ?? null, projectId: project?.project.id ?? null };
}

function requireId(value: string | null, name: string) {
	if (!value) throw Object.assign(new Error(`${name} context is required.`), { code: `${name.toLowerCase()}_required`, status: 400 });
	return encodeURIComponent(value);
}

interface DispatchInput { command: string; args: string[]; options: JsonObject; context: { teamId: string | null; projectId: string | null }; team: string; project: string; first: string; page: string; idempotencyKey: string }

function agentDispatch(input: DispatchInput): Dispatch | null {
	switch (input.command) {
		case 'agents list': case 'agents validate': case 'agents diff': case 'agents bindings list': return { method: 'GET', path: `/v1/projects/${input.project}/agents` };
		case 'agents diagnose': return { method: 'GET', path: `/v1/projects/${input.project}/capacity-diagnostics` };
		case 'agents show': case 'agents bindings show': case 'agents bindings explain': return { method: 'GET', path: `/v1/projects/${input.project}/agents/${input.first}` };
		case 'agents classes list': return { method: 'GET', path: `/v1/projects/${input.project}/agent-classes${input.page}` };
		case 'agents classes show': return { method: 'GET', path: `/v1/projects/${input.project}/agent-classes/${input.first}` };
		default: return null;
	}
}

function providerDispatch(input: DispatchInput): Dispatch | null {
	const { command, args, options, team, first, page, idempotencyKey } = input;
	switch (command) {
		case 'providers list': return { method: 'GET', path: `/v1/teams/${team}/capacity-provider-memberships${page}` };
		case 'providers show': case 'providers status': case 'providers offers show': return { method: 'GET', path: `/v1/teams/${team}/capacity-provider-memberships/${first}` };
		case 'providers diagnose': return { method: 'GET', path: `/v1/teams/${team}/capacity/availability-sessions${query({ providerId: args[0], status: text(options.status), limit: text(options.limit), cursor: text(options.cursor) })}` };
		case 'providers disconnect': return { method: 'POST', path: `/v1/teams/${team}/capacity-provider-memberships/${first}/revoke`, body: { reason: text(options.reason), idempotencyKey } };
		case 'providers requests list': return { method: 'GET', path: `/v1/teams/${team}/capacity-provider-requests${page}` };
		case 'providers requests show': return { method: 'GET', path: `/v1/teams/${team}/capacity-provider-requests/${first}` };
		case 'providers requests approve': case 'providers requests reject': return { method: 'POST', path: `/v1/teams/${team}/capacity-provider-requests/${first}/${command.endsWith('approve') ? 'approve' : 'reject'}`, body: { reason: text(options.reason), idempotencyKey } };
		case 'providers credentials status': return { method: 'GET', path: `/v1/teams/${team}/capacity-provider-memberships/${first}/credentials${page}` };
		case 'providers credentials rotate': return { method: 'POST', path: `/v1/teams/${team}/capacity-provider-memberships/${first}/credentials/rotate`, body: { idempotencyKey } };
		case 'providers credentials revoke': return { method: 'POST', path: `/v1/teams/${team}/capacity-provider-memberships/${first}/credentials/${requireId(text(options.credential), 'Credential')}/revoke`, body: { idempotencyKey } };
		default: return null;
	}
}

function capacityDispatch(input: DispatchInput): Dispatch | null {
	const { command, options, context, team, first, page } = input;
	switch (command) {
		case 'capacity status': return { method: 'GET', path: `/v1/teams/${team}/capacity/availability-sessions${page}` };
		case 'capacity explain': case 'capacity ledger': return { method: 'GET', path: `/v1/teams/${team}/capacity/ledger${query({ projectId: context.projectId, limit: text(options.limit), cursor: text(options.cursor) })}` };
		case 'capacity usage': return { method: 'GET', path: `/v1/teams/${team}/capacity/usage${query({ projectId: context.projectId, limit: text(options.limit), cursor: text(options.cursor) })}` };
		case 'capacity audit': return { method: 'GET', path: `/v1/teams/${team}/capacity-audit-events${page}` };
		case 'plans list': return { method: 'GET', path: `/v1/decisions/${requireId(text(options.decision), 'Decision')}/capacity-plans${page}` };
		case 'plans show': case 'plans explain': return { method: 'GET', path: `/v1/capacity-plans/${first}` };
		default: return null;
	}
}

function workdayDispatch(input: DispatchInput): Dispatch | null {
	const { command, options, context, team, first, page, idempotencyKey } = input;
	switch (command) {
		case 'workdays profiles list': return { method: 'GET', path: `/v1/teams/${team}/capacity/allocation-sets${page}` };
		case 'workdays profiles show': return { method: 'GET', path: `/v1/teams/${team}/capacity/allocation-sets/${first}` };
		case 'workdays plan': return { method: 'POST', path: `/v1/teams/${team}/workday-runs/preflight`, body: { schemaVersion: 'treeseed.workday-intent/v1', teamId: context.teamId, profileId: text(options.profile), projects: text(options.projects) === 'all' ? 'all' : String(options.projects ?? '').split(',').filter(Boolean), startsAt: text(options.start) ?? new Date().toISOString(), ...(text(options.end) ? { endsAt: text(options.end) } : { durationSeconds: Number(text(options.duration) ?? 900) }), objectiveFilters: values(options.objective) } };
		case 'workdays start': return { method: 'POST', path: `/v1/teams/${team}/workday-runs`, body: { preflightId: text(options.preflight), preflightDigest: text(options.digest), idempotencyKey } };
		case 'workdays list': return { method: 'GET', path: `/v1/teams/${team}/workday-runs${page}` };
		case 'workdays show': return { method: 'GET', path: `/v1/teams/${team}/workday-runs/${first}` };
		case 'workdays watch': return { method: 'GET', path: `/v1/teams/${team}/workday-runs/${first}/activity${page}` };
		case 'workdays schedules list': return { method: 'GET', path: `/v1/teams/${team}/workday-schedules` };
		case 'workdays schedules show': return { method: 'GET', path: `/v1/teams/${team}/workday-schedules/${first}` };
		case 'workdays schedules start': return { method: 'POST', path: `/v1/teams/${team}/workday-schedules`, body: { profileId: text(options.profile), projectScope: text(options.projects) ?? 'all', durationSeconds: Number(text(options.duration) ?? 900), idempotencyKey } };
		case 'workdays schedules pause': case 'workdays schedules resume': case 'workdays schedules retire': return { method: 'PATCH', path: `/v1/teams/${team}/workday-schedules/${first}`, body: { status: command.endsWith('pause') ? 'paused' : command.endsWith('resume') ? 'active' : 'retired', idempotencyKey } };
		default: return null;
	}
}

function assignmentDispatch(input: DispatchInput): Dispatch | null {
	const { command, options, context, team, first, idempotencyKey } = input;
	switch (command) {
		case 'assignments list': return { method: 'GET', path: `/v1/teams/${team}/capacity/assignments${query({ projectId: context.projectId, status: text(options.status), limit: text(options.limit), cursor: text(options.cursor) })}` };
		case 'assignments show': case 'assignments watch': case 'assignments artifacts': return { method: 'GET', path: `/v1/teams/${team}/capacity/assignments/${first}` };
		case 'assignments explain': return { method: 'GET', path: `/v1/teams/${team}/capacity/assignments/${first}/explanation` };
		case 'assignments retry': case 'assignments cancel': return { method: 'POST', path: `/v1/teams/${team}/capacity/assignments/${first}/${command.endsWith('retry') ? 'requeue' : 'cancel'}`, body: { reason: text(options.reason), idempotencyKey } };
		default: return null;
	}
}

function dispatch(command: string, args: string[], options: JsonObject, context: { teamId: string | null; projectId: string | null }): Dispatch | null {
	const input: DispatchInput = { command, args, options, context, team: requireId(context.teamId, 'Team'), project: context.projectId ? encodeURIComponent(context.projectId) : '', first: args[0] ? encodeURIComponent(args[0]) : '', page: query({ status: text(options.status), limit: text(options.limit), cursor: text(options.cursor) }), idempotencyKey: text(options.idempotencyKey) ?? `operator:${command.replaceAll(' ', '.')}:${context.teamId ?? context.projectId ?? 'global'}:${digest({ args, options })}` };
	if (command.startsWith('agents ')) { input.project = requireId(context.projectId, 'Project'); if (!input.first && /(?:show|explain)$/.test(command)) input.first = requireId(null, 'Resource'); return agentDispatch(input); }
	if (command.startsWith('providers ')) { if (!input.first && !command.endsWith('list')) input.first = requireId(null, 'Resource'); return providerDispatch(input); }
	if (command.startsWith('capacity ') || command.startsWith('plans ')) { if (!input.first && /plans (?:show|explain)$/.test(command)) input.first = requireId(null, 'Resource'); return capacityDispatch(input); }
	if (command.startsWith('workdays ')) { if (!input.first && /(?:show|watch|pause|resume|retire)$/.test(command)) input.first = requireId(null, 'Resource'); return workdayDispatch(input); }
	if (command.startsWith('assignments ')) { if (!input.first && !command.endsWith('list')) input.first = requireId(null, 'Resource'); return assignmentDispatch(input); }
	return null;
}

function errorResponse(c: Context, error: unknown) {
	const candidate = object(error);
	const status = Number(candidate.status);
	const responseStatus = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 400;
	return c.json({ ok: false, code: text(candidate.code) ?? 'operator_command_invalid', error: error instanceof Error ? error.message : String(error) }, responseStatus as 400);
}

async function forward(app: Hono, c: Context, target: Dispatch) {
	const url = new URL(target.path, c.req.url);
	const headers = new Headers(c.req.raw.headers);
	headers.delete('content-length');
	if (target.method !== 'GET') headers.set('content-type', 'application/json');
	const idempotencyKey = text(target.body?.idempotencyKey);
	if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey);
	return app.request(url, { method: target.method, headers, body: target.method === 'GET' ? undefined : JSON.stringify(target.body ?? {}) });
}

export function installOperatorCommandRoute(app: Hono, options: OperatorCommandOptions) {
	const handle = (access: 'team-read' | 'team-manage') => async (c: Context) => {
		try {
			const request = await readCapacityRequestObject(c) as OperatorCommandRequest;
			const command = values(request.commandPath).join(' ');
			if (!commandPaths.has(command)) return c.json({ ok: false, code: 'unknown_command', error: `Unknown canonical command: ${command}` }, 404);
			if (clientLocal.has(command)) return c.json({ ok: false, code: 'client_local_command', error: `${command} is intentionally handled by local credential/session custody.` }, 409);
			const mode: Mode = request.mode === 'plan' ? 'plan' : 'execute';
			const args = values(request.arguments);
			const commandOptions = object(request.options);
			const commandContext = await resolveContext(options.store as OperatorCommandStore, object(request.context));
			if (!commandContext.teamId) return c.json({ ok: false, code: 'team_required', error: 'An unambiguous team context is required.' }, 400);
			const expectedAccess = manageCommands.has(command) ? 'team-manage' : 'team-read';
			if (expectedAccess !== access) return c.json({ ok: false, code: 'operator_access_route_mismatch', error: `${command} must use the ${expectedAccess} operator endpoint.` }, 409);
			const authorized = await options.requireTeamAccess(c, options.store, commandContext.teamId, access === 'team-manage' ? 'teams:manage:team' : 'projects:read:team');
			if (authorized.response) return authorized.response;

			if (workflowCommands.has(command) || command === 'providers connect') {
				if (mode === 'plan') {
					const proposal = { commandPath: command.split(' '), authority: 'trusted-control-plane-provider', mutation: false };
					return c.json({ ok: true, payload: { ...proposal, digest: digest(proposal) } });
				}
				return c.json({ ok: false, code: command === 'providers connect' ? 'provider_runtime_not_connected' : 'github_work_provider_not_ready', error: command === 'providers connect' ? 'Provider connection requires a trusted private provider runtime; the CLI cannot perform provider registration.' : 'The trusted GitHub work-provider mutation route is not active yet.' }, 409);
			}
			if (providerDocumentCommands.has(command)) {
				const validation = validateProviderSupplyOffer(object(commandOptions.document) as never);
				if (command === 'providers offers validate') return c.json({ ok: validation.diagnostics.length === 0, payload: validation }, validation.diagnostics.length === 0 ? 200 : 400);
				if (command === 'providers offers plan' || mode === 'plan') return c.json({ ok: validation.diagnostics.length === 0, payload: { validation, operation: 'provider-offer-apply', mutation: false, digest: digest(commandOptions.document) } }, validation.diagnostics.length === 0 ? 200 : 400);
				return c.json({ ok: false, code: 'provider_runtime_not_connected', error: 'A trusted private provider runtime must apply the validated offer.' }, 409);
			}
			if (command === 'workdays profiles validate') {
				const bundle = object(commandOptions.document);
				const diagnostics = validateRepositoryWorkdayProfileBundle(bundle as never);
				return c.json({ ok: diagnostics.length === 0, payload: { diagnostics } }, diagnostics.length === 0 ? 200 : 400);
			}
			if (command === 'workdays schedules plan') {
				const proposal = { profileId: text(commandOptions.profile), projectScope: text(commandOptions.projects) ?? 'all', durationSeconds: Number(text(commandOptions.duration) ?? 900), mutation: false };
				return c.json({ ok: true, payload: { ...proposal, digest: digest(proposal) } });
			}
			if (command === 'plans diff') {
				if (args.length < 2) return c.json({ ok: false, code: 'resource_required', error: 'Two capacity-plan identities are required.' }, 400);
				const [left, right] = await Promise.all(args.slice(0, 2).map((id) => forward(app, c, { method: 'GET', path: `/v1/capacity-plans/${encodeURIComponent(id)}` }).then((response) => response.json())));
				return c.json({ ok: true, payload: { left, right, equal: digest(left) === digest(right), leftDigest: digest(left), rightDigest: digest(right) } });
			}
			if (['workdays pause', 'workdays resume', 'workdays stop', 'workdays cancel'].includes(command)) {
				const runId = args[0];
				if (!runId) return c.json({ ok: false, code: 'resource_required', error: 'A workday identity is required.' }, 400);
				const change = { status: command.endsWith('pause') ? 'paused' : command.endsWith('resume') ? 'running' : 'cancelled', reason: text(commandOptions.reason), idempotencyKey: text(commandOptions.idempotencyKey) ?? `operator:${command.replaceAll(' ', '.')}:${commandContext.teamId}:${runId}` };
				if (mode === 'plan') return c.json({ ok: true, payload: { commandPath: command.split(' '), resource: { type: 'workday', id: runId }, change, digest: digest(change), mutation: false } });
				const run = await (options.store as OperatorCommandStore).updateCapacityWorkdayRun(commandContext.teamId, runId, change);
				return run ? c.json({ ok: true, payload: run }) : c.json({ ok: false, code: 'not_found', error: 'Unknown workday run.' }, 404);
			}
			if (command === 'status' || command === 'diagnose') {
				return c.json({ ok: true, payload: { controlPlane: 'ready', commandAuthority: 'api', teamId: commandContext.teamId, projectId: commandContext.projectId, observedAt: new Date().toISOString() } });
			}

			const target = dispatch(command, args, commandOptions, commandContext);
			if (!target) return c.json({ ok: false, code: 'operator_route_missing', error: `No API-owned route is bound for ${command}.` }, 501);
			if (mode === 'plan' && commandKinds.get(command) === 'mutation') {
				const proposal = { commandPath: command.split(' '), method: target.method, path: target.path, body: target.body ?? null };
				return c.json({ ok: true, payload: { ...proposal, digest: digest(proposal), mutation: false } });
			}
			return forward(app, c, target);
		} catch (error) {
			return errorResponse(c, error);
		}
	};
	app.post('/v1/operator/commands/read', handle('team-read'));
	app.post('/v1/operator/commands/mutations', handle('team-manage'));
}
