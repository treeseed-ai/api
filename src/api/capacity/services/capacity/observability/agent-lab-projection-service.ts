import { createHash } from 'node:crypto';
import type {
	AgentLabActivityInterval, AgentLabEntityKind, AgentLabEntitySummary,
	AgentLabMetricKey, AgentLabMetricPoint, AgentLabOverview, AgentLabWorkdayContext,
} from '@treeseed/sdk/agent-capacity';
import { canonicalArtifactManifestReferences } from '../../../domain/artifact-manifest-evidence.ts';
import { logicalModeRunSql } from '../../../repositories/support/mode-run.ts';

export type AgentLabProjectionRow = Record<string, unknown>;
type Row = AgentLabProjectionRow;
interface ProjectionStore {
	ensureInitialized(): Promise<void>;
	first(query: string, values?: unknown[]): Promise<Row | null>;
	all(query: string, values?: unknown[]): Promise<Row[]>;
	getProjectAgentsSummary?(projectId: string, principal?: unknown): Promise<Row | null>;
}

type Snapshot = Awaited<ReturnType<AgentLabProjectionService['loadSnapshot']>>;
type SnapshotEntry = { settledAt: number | null; value: Promise<Snapshot> };
const snapshotCaches = new WeakMap<object, Map<string, SnapshotEntry>>();
const SNAPSHOT_COALESCE_MS = 2_000;
const PORTFOLIO_EVENT_WINDOW = 500;

function snapshotCache(store: object) {
	const current = snapshotCaches.get(store);
	if (current) return current;
	const created = new Map<string, SnapshotEntry>(); snapshotCaches.set(store, created); return created;
}

function record(value: unknown): Row {
	if (value && typeof value === 'object' && !Array.isArray(value)) return value as Row;
	if (typeof value === 'string') { try { return record(JSON.parse(value)); } catch { return {}; } }
	return {};
}
function text(...values: unknown[]) { return String(values.find((value) => typeof value === 'string' && value) ?? ''); }
function count(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function iso(value: unknown) { const parsed = Date.parse(String(value ?? '')); return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null; }
function strings(value: unknown) {
	const parsed = typeof value === 'string' ? (() => { try { return JSON.parse(value); } catch { return []; } })() : value;
	return Array.isArray(parsed) ? parsed.flatMap((entry) => typeof entry === 'string' ? [entry] : entry && typeof entry === 'object' ? [text((entry as Row).id, (entry as Row).providerId)] : []).filter(Boolean) : [];
}

function zonedParts(value: Date, timeZone: string) {
	return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
		timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
		hourCycle: 'h23', minute: '2-digit', second: '2-digit',
	}).formatToParts(value).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
}

function zonedInstant(parts: { year: number; month: number; day: number }, timeZone: string) {
	let guess = Date.UTC(parts.year, parts.month - 1, parts.day);
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const observed = zonedParts(new Date(guess), timeZone);
		const observedUtc = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute, observed.second);
		guess += Date.UTC(parts.year, parts.month - 1, parts.day) - observedUtc;
	}
	return new Date(guess);
}

export function operatingDay(now: Date, timeZone: string) {
	const current = zonedParts(now, timeZone);
	const start = zonedInstant(current, timeZone);
	const nextProbe = new Date(Date.UTC(current.year, current.month - 1, current.day + 1));
	const next = zonedParts(nextProbe, 'UTC');
	const end = zonedInstant(next, timeZone);
	return { start: start.toISOString(), end: end.toISOString() };
}

function dateKey(value: Date, timeZone: string) {
	const parts = zonedParts(value, timeZone);
	return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function operatingDate(value: string, timeZone: string) {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
	if (!match) return null;
	const parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
	const start = zonedInstant(parts, timeZone); const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
	const nextParts = zonedParts(next, 'UTC'); const end = zonedInstant(nextParts, timeZone);
	return { start: start.toISOString(), end: end.toISOString() };
}

function activityProfile(row: Row) {
	const selected = record(row.selected_input_json);
	const decision = record(row.decision_input_json);
	const input = record(decision.input);
	return text(selected.activityType, input.activityType, row.handler_id, row.mode, 'planning');
}

function artifactIdentity(value: Row) {
	return text(value.id, value.receiptId, value.contentPath, value.path, value.outputRef, JSON.stringify(value));
}

function metricTargets(value: unknown): AgentLabOverview['metricTargets'] {
	const source = record(record(value).agentLab).metricTargets;
	if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
	return Object.fromEntries(Object.entries(source).filter(([, target]) => typeof target === 'number' && Number.isFinite(target) && target >= 0)) as AgentLabOverview['metricTargets'];
}

async function resolveWorkdayContext(store: ProjectionStore, teamId: string, timeZone: string, now: Date, requestedDate?: string | null, requestedWorkdayId?: string | null) {
	const all = await store.all(`SELECT * FROM capacity_workday_runs WHERE team_id = ? AND execution_kind='workday' ORDER BY COALESCE(started_at, created_at) DESC, id DESC`, [teamId]);
	const latest = all.find((row) => text(row.status) === 'running') ?? all[0] ?? null;
	const selected = requestedWorkdayId ? all.find((row) => text(row.id) === requestedWorkdayId) ?? null : null;
	const selectedDate = requestedDate && operatingDate(requestedDate, timeZone)
		? requestedDate
		: selected ? dateKey(new Date(text(selected.started_at, selected.created_at)), timeZone)
			: latest ? dateKey(new Date(text(latest.started_at, latest.created_at)), timeZone) : dateKey(now, timeZone);
	const day = operatingDate(selectedDate, timeZone) ?? operatingDay(now, timeZone);
	const withinDate = all.filter((row) => {
		const started = Date.parse(text(row.started_at, row.created_at));
		const finished = text(row.status) === 'running' ? now.getTime() : Date.parse(text(row.completed_at, row.updated_at));
		return started < Date.parse(day.end) && finished >= Date.parse(day.start);
	});
	const context: AgentLabWorkdayContext = { selectedDate, selectedWorkdayId: selected ? text(selected.id) : null, latestWorkdayId: latest ? text(latest.id) : null,
		workdays: withinDate.map((row) => ({ id: text(row.id), title: text(row.scenario_id, 'Workday'), status: text(row.status, 'unknown'), startedAt: iso(row.started_at ?? row.created_at), finishedAt: iso(row.completed_at) })) };
	return { context, selected, day };
}

async function sourceRows(store: ProjectionStore, teamId: string, day: { start: string; end: string }, observedAt: string, selectedWorkdayId: string | null) {
	const runClause = selectedWorkdayId ? ' AND id = ?' : ' AND (created_at < ? AND COALESCE(completed_at, updated_at) >= ?)';
	const runValues = selectedWorkdayId ? [teamId, selectedWorkdayId] : [teamId, day.end, day.start];
	const eventClause = selectedWorkdayId ? ' AND run_id = ?' : ' AND created_at >= ? AND created_at < ?';
	const eventValues = selectedWorkdayId ? [teamId, selectedWorkdayId] : [teamId, day.start, day.end];
	const eventColumns = 'id, run_id, event_index, event_type, status, title, message, project_id, assignment_id, context_json, refs_json, metadata_json, created_at';
	const eventQuery = selectedWorkdayId
		? `SELECT ${eventColumns} FROM capacity_workday_events WHERE team_id = ?${eventClause} ORDER BY created_at ASC, event_index ASC`
		: `SELECT * FROM (SELECT ${eventColumns} FROM capacity_workday_events WHERE team_id = ?${eventClause} ORDER BY created_at DESC, event_index DESC LIMIT ${PORTFOLIO_EVENT_WINDOW}) recent ORDER BY created_at ASC, event_index ASC`;
	const demandJoin = selectedWorkdayId ? ` JOIN capacity_workday_demands demand ON demand.assignment_id = assignment.id AND demand.workday_run_id = ?` : '';
	const assignmentValues = selectedWorkdayId ? [selectedWorkdayId, teamId] : [teamId, day.end, day.start];
	const [team, projects, workdays, events, eventCount, assignments, executions, providers, classes] = await Promise.all([
		store.first(`SELECT id, name, slug, metadata_json, updated_at FROM teams WHERE id = ? LIMIT 1`, [teamId]),
		store.all(`SELECT id, name, slug FROM projects WHERE team_id = ? ORDER BY name ASC`, [teamId]),
		store.all(`SELECT * FROM capacity_workday_runs WHERE team_id = ? AND execution_kind='workday'${runClause} ORDER BY created_at ASC`, runValues),
		store.all(eventQuery, eventValues),
		store.first(`SELECT COUNT(*) AS total FROM capacity_workday_events WHERE team_id = ?${eventClause}`, eventValues),
		store.all(`SELECT assignment.id, assignment.membership_id, assignment.team_id, assignment.project_id, assignment.capacity_provider_id, assignment.provider_session_id, assignment.execution_provider_id, assignment.project_agent_class_id, assignment.reservation_id, assignment.work_day_id, assignment.task_id, assignment.mode, assignment.status, assignment.lease_state, assignment.lease_expires_at, assignment.state_version, assignment.agent_id, assignment.handler_id, assignment.attempt_count, assignment.assigned_at, assignment.claimed_at, assignment.completed_at, assignment.returned_at, assignment.failed_at, assignment.lifecycle_reason, assignment.lifecycle_code, assignment.decision_id, assignment.proposal_id, assignment.metadata_json, assignment.decision_input_json, assignment.lifecycle_output_json, assignment.created_at, assignment.updated_at, project.name AS project_name FROM capacity_provider_assignments assignment${demandJoin} JOIN projects project ON project.id = assignment.project_id WHERE assignment.team_id = ?${selectedWorkdayId ? '' : ' AND assignment.created_at < ? AND COALESCE(assignment.completed_at, assignment.failed_at, assignment.returned_at, assignment.updated_at) >= ?'} ORDER BY assignment.created_at ASC`, assignmentValues),
		store.all(`SELECT mode_run.id, mode_run.team_id, mode_run.project_id, mode_run.provider_assignment_id, mode_run.capacity_provider_id, mode_run.execution_provider_id, mode_run.project_agent_class_id, mode_run.agent_id, mode_run.handler_id, mode_run.mode, mode_run.status, mode_run.fallback_reason, mode_run.started_at, mode_run.completed_at, mode_run.failed_at, mode_run.metadata_json, mode_run.selected_input_json, mode_run.outputs_json, mode_run.created_at, mode_run.updated_at, mode_run.usage_actual_json AS usage_json, assignment.state_version AS assignment_state_version, assignment.status AS assignment_status, assignment.returned_at AS assignment_returned_at, project.name AS project_name FROM agent_mode_runs mode_run JOIN capacity_provider_assignments assignment ON assignment.id = mode_run.provider_assignment_id${selectedWorkdayId ? ' JOIN capacity_workday_demands demand ON demand.assignment_id = assignment.id AND demand.workday_run_id = ?' : ''} JOIN projects project ON project.id = mode_run.project_id WHERE mode_run.team_id = ?${selectedWorkdayId ? '' : ' AND mode_run.created_at < ? AND COALESCE(mode_run.completed_at, mode_run.failed_at, mode_run.updated_at) >= ?'} AND ${logicalModeRunSql('mode_run')} ORDER BY mode_run.created_at ASC, mode_run.id ASC`, assignmentValues),
		store.all(`SELECT * FROM capacity_provider_availability_sessions WHERE team_id = ? AND status = 'open' AND expires_at > ? ORDER BY updated_at DESC`, [teamId, observedAt]),
		store.all(`SELECT * FROM project_agent_classes WHERE team_id = ? AND status = 'active' ORDER BY project_id, slug`, [teamId]),
	]);
	const assignmentIds = assignments.map((row) => text(row.id)).filter(Boolean); const placeholders = assignmentIds.map(() => '?').join(',');
	const [agentSummaries, demands, reservations, usage, ledger] = await Promise.all([
		Promise.all(projects.map(async (project) => ({ projectId: text(project.id), summary: store.getProjectAgentsSummary ? await store.getProjectAgentsSummary(text(project.id)).catch(() => null) : null }))),
		assignmentIds.length ? store.all(`SELECT * FROM capacity_workday_demands WHERE assignment_id IN (${placeholders}) ORDER BY created_at ASC`, assignmentIds) : [],
		assignmentIds.length ? store.all(`SELECT * FROM capacity_reservations WHERE assignment_id IN (${placeholders}) ORDER BY created_at ASC`, assignmentIds) : [],
		assignmentIds.length ? store.all(`SELECT * FROM capacity_usage_actuals WHERE assignment_id IN (${placeholders}) ORDER BY created_at ASC`, assignmentIds) : [],
		assignmentIds.length ? store.all(`SELECT * FROM capacity_ledger_entries WHERE assignment_id IN (${placeholders}) ORDER BY created_at ASC`, assignmentIds) : [],
	]);
	const roster = classes.flatMap((agentClass) => { const configured = record(agentClass.handler_refs_json).agents; return Array.isArray(configured) ? configured.map((agent) => ({ ...record(agent), project_id: text(agentClass.project_id), agentSlug: text(record(agent).slug, record(agent).agentId), status: 'configured' })) : []; });
	const runtimeAgents = agentSummaries.flatMap(({ projectId, summary }) => Array.isArray(summary?.agents) ? summary.agents.map((agent) => ({ ...record(agent), project_id: projectId })) : []);
	const agentsByIdentity = new Map(roster.map((agent) => [`${text(agent.project_id)}:${text(agent.agentSlug, agent.slug)}`, agent])); for (const agent of runtimeAgents) { const identity = `${text(agent.project_id)}:${text(agent.agentSlug, agent.slug)}`; agentsByIdentity.set(identity, { ...agentsByIdentity.get(identity), ...agent }); } const agents = [...agentsByIdentity.values()];
	const eventTotal = eventCount && Number.isFinite(Number(eventCount.total))
		? count(eventCount.total) : new Set(events.map((row) => text(row.id))).size;
	return { team, projects, workdays, events, eventTotal, assignments, executions, providers, classes, agents, demands, reservations, usage, ledger };
}

export type AgentLabSourceRows = Awaited<ReturnType<typeof sourceRows>>;

function artifacts(rows: Row[]) {
	const found = new Map<string, Row>();
	for (const row of rows) {
		const values = [
			...canonicalArtifactManifestReferences(record(row.outputs_json), `mode run ${text(row.id)}`),
			...canonicalArtifactManifestReferences(record(row.lifecycle_output_json), `assignment ${text(row.provider_assignment_id)}`),
		];
		for (const value of values) found.set(artifactIdentity(value), value);
	}
	return [...found.values()];
}

function metrics(rows: Awaited<ReturnType<typeof sourceRows>>, artifactRows: Row[]) {
	const activeAgentIds = new Set(rows.executions.filter((row) => text(row.status) === 'running').map((row) => `${text(row.project_id)}:${text(row.agent_id)}`).filter((value) => !value.endsWith(':')));
	const activeWorkdays = rows.workdays.filter((row) => text(row.status) === 'running').length;
	const values: Record<AgentLabMetricKey, number> = {
		agents: new Set(rows.agents.map((row) => `${text(row.project_id)}:${text(row.agentSlug, row.slug)}`).filter((value) => !value.endsWith(':'))).size,
		workdays: rows.workdays.filter((row) => text(row.status) === 'completed').length,
		systemEvents: Number.isFinite(rows.eventTotal) ? rows.eventTotal : new Set(rows.events.map((row) => text(row.id))).size,
		assignments: new Set(rows.assignments.map((row) => text(row.id))).size,
		executions: new Set(rows.executions.filter((row) => Boolean(row.started_at)).map((row) => text(row.id))).size,
		artifacts: artifactRows.length,
		passed: rows.executions.filter((row) => text(row.status) === 'succeeded').length,
		failed: rows.executions.filter((row) => text(row.status) === 'failed').length,
		running: rows.executions.filter((row) => text(row.status) === 'running').length,
	};
	return { values, activeAgentIds, activeWorkdays };
}

function revisionOf(rows: Awaited<ReturnType<typeof sourceRows>>) {
	return createHash('sha256').update(JSON.stringify([
		[rows.team?.id, rows.team?.updated_at],
		...rows.workdays.map((row) => [row.id, row.updated_at]), ...rows.events.map((row) => [row.id, row.event_index]),
		...rows.assignments.map((row) => [row.id, row.state_version, row.updated_at]), ...rows.executions.map((row) => [row.id, row.updated_at]),
		...rows.providers.map((row) => [row.id, row.updated_at]), ...rows.classes.map((row) => [row.id, row.updated_at]),
		...rows.agents.map((row) => [row.project_id, row.agentSlug, row.slug, row.status]), ...rows.demands.map((row) => [row.id, row.updated_at]),
		...rows.reservations.map((row) => [row.id, row.state, row.updated_at]), ...rows.usage.map((row) => [row.id, row.updated_at]), ...rows.ledger.map((row) => [row.id, row.phase, row.created_at]),
	])).digest('hex').slice(0, 24);
}

export class AgentLabProjectionService {
	constructor(private readonly store: ProjectionStore) {}

	async snapshot(teamId: string, timeZone: string, now = new Date(), selection: { date?: string | null; workdayId?: string | null } = {}) {
		const key = [teamId, timeZone, selection.date ?? '', selection.workdayId ?? ''].join('\0'); const cache = snapshotCache(this.store as object);
		const current = cache.get(key); const observedAt = Date.now();
		if (current && (current.settledAt === null || observedAt - current.settledAt <= SNAPSHOT_COALESCE_MS)) return current.value;
		const value = this.loadSnapshot(teamId, timeZone, now, selection); const entry: SnapshotEntry = { settledAt: null, value }; cache.set(key, entry);
		for (const [candidate, cached] of cache) if (candidate !== key && cached.settledAt !== null && observedAt - cached.settledAt > SNAPSHOT_COALESCE_MS) cache.delete(candidate);
		void value.then(() => { if (cache.get(key)?.value === value) entry.settledAt = Date.now(); });
		value.catch(() => { if (cache.get(key)?.value === value) cache.delete(key); });
		return value;
	}

	async loadSnapshot(teamId: string, timeZone: string, now = new Date(), selection: { date?: string | null; workdayId?: string | null } = {}) {
		await this.store.ensureInitialized();
		const resolved = await resolveWorkdayContext(this.store, teamId, timeZone, now, selection.date, selection.workdayId);
		const selectedBounds = resolved.selected ? { start: iso(resolved.selected.started_at ?? resolved.selected.created_at)!, end: text(resolved.selected.status) === 'running' ? now.toISOString() : iso(resolved.selected.completed_at ?? resolved.selected.updated_at) ?? now.toISOString() } : resolved.day;
		const rows = await sourceRows(this.store, teamId, selectedBounds, now.toISOString(), resolved.context.selectedWorkdayId);
		if (!rows.team) return null;
		const artifactRows = artifacts(rows.executions);
		const summary = metrics(rows, artifactRows);
		const revision = revisionOf(rows);
		const generatedAt = now.toISOString();
		const overview: AgentLabOverview = {
			revision, generatedAt, timeZone, operatingDay: selectedBounds,
			team: { id: teamId, name: text(rows.team.name, rows.team.slug, 'Team') },
			workdayContext: resolved.context,
			metricTargets: metricTargets(rows.team.metadata_json),
			targetRevision: text(rows.team.updated_at) || null,
			connectivity: rows.providers.length ? 'live' : summary.activeWorkdays ? 'degraded' : 'idle',
			activeWorkdays: summary.activeWorkdays,
			activeProviders: rows.providers.length,
			executionProviders: [...new Set([...rows.providers.flatMap((row) => strings(row.execution_providers_json)), ...rows.executions.map((row) => text(row.execution_provider_id)).filter(Boolean)])],
			metrics: Object.entries(summary.values).map(([key, value]) => ({
				key: key as AgentLabMetricKey, value,
				secondary: key === 'agents' ? `${summary.activeAgentIds.size} active` : key === 'workdays' ? `${summary.activeWorkdays} active` : null,
				semantic: key === 'agents' ? 'configured' : ['workdays', 'systemEvents'].includes(key) ? 'exact-total' : key === 'running' ? 'instantaneous' : 'cumulative', observedAt: generatedAt,
			})),
		};
		return { overview, rows, artifacts: artifactRows };
	}

	activity(rows: Awaited<ReturnType<typeof sourceRows>>): AgentLabActivityInterval[] {
		return rows.executions.flatMap((row) => {
			const startedAt = iso(row.started_at);
			if (!startedAt) return [];
			const configuredAgent = rows.agents.find((candidate) => text(candidate.project_id) === text(row.project_id) && text(candidate.agentSlug, candidate.slug) === text(row.agent_id));
			const agentClass = rows.classes.find((candidate) => text(candidate.id) === text(row.project_agent_class_id));
			return [{
				id: text(row.id), stateVersion: count(row.assignment_state_version), projectId: text(row.project_id),
				projectName: text(row.project_name, 'Project'), agentId: text(row.agent_id, 'unassigned'),
				agentName: text(configuredAgent?.name, configuredAgent?.title, configuredAgent?.agentSlug, agentClass?.name, row.agent_id, 'Unassigned agent'), agentClassId: text(row.project_agent_class_id),
				activityProfile: activityProfile(row), assignmentId: text(row.provider_assignment_id), executionId: text(row.id),
				status: text(row.status, row.assignment_status, 'unknown'), startedAt,
				finishedAt: iso(row.completed_at ?? row.failed_at ?? row.assignment_returned_at),
			}];
		});
	}

	series(rows: Awaited<ReturnType<typeof sourceRows>>, day: { start: string; end: string }, observedAt = new Date()): AgentLabMetricPoint[] {
		const bucketMs = 5 * 60_000;
		const start = Date.parse(day.start); const end = Math.min(observedAt.getTime(), Date.parse(day.end));
		const points: AgentLabMetricPoint[] = [];
		const projectIds = rows.projects.map((row) => text(row.id));
		const stats = (values: number[], semantic: 'configured' | 'cumulative' | 'instantaneous' | 'exact-total', exactTotal: number, timestamp: string) => {
			if (semantic === 'exact-total') return { semantic, exactTotal, mean: exactTotal, standardDeviation: null, low: exactTotal, high: exactTotal, sampleSize: 1, observedAt: timestamp };
			const sample = values.length ? values : [0]; const mean = sample.reduce((sum, value) => sum + value, 0) / sample.length;
			const standardDeviation = Math.sqrt(sample.reduce((sum, value) => sum + (value - mean) ** 2, 0) / sample.length);
			return { semantic, exactTotal, mean, standardDeviation, low: Math.max(0, mean - standardDeviation), high: mean + standardDeviation, sampleSize: sample.length, observedAt: timestamp };
		};
		for (let at = start; at <= end; at += bucketMs) {
			const through = at + bucketMs;
			const within = (value: unknown) => { const parsed = Date.parse(String(value ?? '')); return Number.isFinite(parsed) && parsed < through; };
			const executionRows = rows.executions.filter((row) => within(row.started_at));
			const runningAt = (row: Row) => {
				const terminal = iso(row.completed_at ?? row.failed_at ?? (['cancelled'].includes(text(row.status)) ? row.updated_at : null));
				return within(row.started_at) && (!terminal || Date.parse(terminal) >= through);
			};
			const agentIdentities = rows.agents.map((row) => `${text(row.project_id)}:${text(row.agentSlug, row.slug)}`).filter((value) => !value.endsWith(':'));
			const values = {
				agents: new Set(agentIdentities).size,
				workdays: rows.workdays.filter((row) => text(row.status) === 'completed' && within(row.completed_at)).length,
				systemEvents: rows.events.filter((row) => within(row.created_at)).length,
				assignments: rows.assignments.filter((row) => within(row.created_at)).length,
				executions: executionRows.length,
				artifacts: artifacts(executionRows).length,
				passed: executionRows.filter((row) => text(row.status) === 'succeeded' && within(row.completed_at)).length,
				failed: executionRows.filter((row) => text(row.status) === 'failed' && within(row.failed_at)).length,
				running: executionRows.filter(runningAt).length,
			};
			const byProject = (source: Row[], predicate: (row: Row) => boolean) => projectIds.map((projectId) => source.filter((row) => text(row.project_id) === projectId && predicate(row)).length);
			const timestamp = new Date(at).toISOString();
			points.push({ id: timestamp, stateVersion: rows.events.filter((row) => within(row.created_at)).length + rows.executions.filter((row) => within(row.updated_at)).length, timestamp, values, statistics: {
				agents: stats(projectIds.map((projectId) => rows.agents.filter((row) => text(row.project_id) === projectId).length), 'configured', values.agents, timestamp),
				workdays: stats([values.workdays], 'exact-total', values.workdays, timestamp), systemEvents: stats([values.systemEvents], 'exact-total', values.systemEvents, timestamp),
				assignments: stats(byProject(rows.assignments, (row) => within(row.created_at)), 'cumulative', values.assignments, timestamp), executions: stats(byProject(rows.executions, (row) => within(row.started_at)), 'cumulative', values.executions, timestamp),
				artifacts: stats(projectIds.map((projectId) => executionRows.filter((row) => text(row.project_id) === projectId).reduce((sum, row) => sum + artifacts([row]).length, 0)), 'cumulative', values.artifacts, timestamp),
				passed: stats(byProject(executionRows, (row) => text(row.status) === 'succeeded' && within(row.completed_at)), 'cumulative', values.passed, timestamp),
				failed: stats(byProject(executionRows, (row) => text(row.status) === 'failed' && within(row.failed_at)), 'cumulative', values.failed, timestamp),
				running: stats(byProject(executionRows, runningAt), 'instantaneous', values.running, timestamp),
			} });
		}
		return points;
	}

	entities(kind: AgentLabEntityKind, snapshot: Awaited<ReturnType<AgentLabProjectionService['snapshot']>>): AgentLabEntitySummary[] {
		if (!snapshot) return [];
		const { rows } = snapshot;
		const base = (row: Row, selectedKind: AgentLabEntityKind, title: string, description: string, includeActivity = false, identity = text(row.id)): AgentLabEntitySummary => ({
			id: identity, kind: selectedKind, title, description, status: text(row.status) || null,
			projectId: text(row.project_id) || null, projectName: text(row.project_name) || null, activityProfile: includeActivity ? activityProfile(row) : null, occurredAt: iso(row.created_at),
		});
		if (kind === 'agents') return rows.classes.map((row) => base(row, kind, text(row.name, row.slug, 'Agent class'), text(row.slug, 'Configured agent class')));
		if (kind === 'workdays') return rows.workdays.map((row) => base(row, kind, text(row.scenario_id, 'Workday'), 'Bounded team operating session'));
		if (kind === 'events') return rows.events.map((row) => base(row, kind, text(row.title, row.event_type, 'System event'), text(row.message, row.event_type)));
		if (kind === 'assignments') return rows.assignments.map((row) => base(row, kind, text(row.agent_id, 'Assignment'), text(row.lifecycle_reason, row.handler_id, 'Agent assignment'), true));
		if (kind === 'executions') return rows.executions.map((row) => base(row, kind, text(row.agent_id, 'Execution'), `${activityProfile(row)} execution`, true));
		return snapshot.artifacts.map((row) => base(row, 'artifacts', text(row.contentPath, row.path, row.id, 'Artifact'), text(row.model, row.artifactKind, 'Generated content'), false, artifactIdentity(row)));
	}
}
