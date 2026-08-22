import { randomUUID } from 'node:crypto';
import { validateWorkdayTimePolicy, type CapacityWorkdayRunRecord, type CapacityWorkdayScheduleRecord } from '@treeseed/sdk/agent-capacity';
import { normalizeWorkdayAgentSelection } from '../../../../policy/workdays/workday.ts';
import type { CapacityGovernanceDatabase } from '../../../../database.ts';
import { CapacityGovernanceError } from '../../../../database.ts';
import type { WorkdayProject } from '../policy/workday-project-policy.ts';

type Row = Record<string, unknown>;
type Status = CapacityWorkdayScheduleRecord['status'];
const TERMINAL_RUNS = new Set(['completed', 'cancelled', 'failed', 'degraded']);
const SCHEDULE_STATUSES = new Set<Status>(['active', 'paused', 'completed', 'failed']);

function json<T>(value: unknown, fallback: T): T { try { return typeof value === 'string' ? JSON.parse(value) as T : value as T; } catch { return fallback; } }
function text(value: unknown, fallback = '') { return typeof value === 'string' && value.trim() ? value.trim() : fallback; }
function integer(value: unknown, fallback: number, minimum: number) { const parsed = Number(value ?? fallback); if (!Number.isInteger(parsed) || parsed < minimum) throw new CapacityGovernanceError('capacity_workday_schedule_value_invalid', `Schedule value must be an integer of at least ${minimum}.`, 400); return parsed; }
function strings(value: unknown) { return Array.isArray(value) ? [...new Set(value.map(String).map((entry) => entry.trim()).filter(Boolean))] : []; }
function publicationPolicy(value: unknown): CapacityWorkdayScheduleRecord['publicationPolicy'] {
	const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
	return { bookIds: strings(input.bookIds), target: input.target === 'production' ? 'production' : 'staging', cohortMode: 'accepted',
		requireTechnicalReview: input.requireTechnicalReview !== false, requireAudienceReview: input.requireAudienceReview !== false,
		requireGraphReviewWhenStructural: input.requireGraphReviewWhenStructural !== false, simulatedHumanApproval: input.simulatedHumanApproval === true };
}
function timePolicy(value: unknown, planningOnly: boolean) {
	const candidate = value && typeof value === 'object' && !Array.isArray(value) ? value : { cooperativePlanningPercent: planningOnly ? 90 : 25, governedExecutionPercent: planningOnly ? 0 : 65, reservePercent: 10 };
	const validation = validateWorkdayTimePolicy(candidate);
	if (!validation.ok || !validation.value) throw new CapacityGovernanceError('capacity_workday_time_policy_invalid', 'Workday time policy must contain Plan, Execute, and Reserve percentages totaling 100.', 400, { diagnostics: validation.diagnostics });
	if (planningOnly && validation.value.governedExecutionPercent !== 0) throw new CapacityGovernanceError('capacity_workday_planning_only_execution_invalid', 'Planning-only schedules require zero governed execution time.', 400);
	return validation.value;
}
export function serializeWorkdaySchedule(row: Row | null): CapacityWorkdayScheduleRecord | null {
	if (!row) return null; const status = String(row.status) as Status;
	if (!SCHEDULE_STATUSES.has(status)) throw new CapacityGovernanceError('capacity_workday_schedule_corrupt', 'Schedule status is invalid.', 500);
	return { id: String(row.id), teamId: String(row.team_id), projectIds: json(row.project_ids_json, []), status, purpose: String(row.purpose),
		capacityProviderId: String(row.capacity_provider_id), agentSelection: normalizeWorkdayAgentSelection(json(row.agent_selection_json, {})),
		cadenceSeconds: Number(row.cadence_seconds), durationSeconds: Number(row.duration_seconds), maxActiveAssignments: Number(row.max_active_assignments),
		availableSeconds: Number(row.available_seconds), timePolicy: timePolicy(json(row.time_policy_json, {}), Number(row.planning_only) === 1), planningOnly: Number(row.planning_only) === 1,
		publicationPolicy: publicationPolicy(json(row.publication_policy_json, {})), lastRunId: row.last_run_id ? String(row.last_run_id) : null,
		nextRunAt: String(row.next_run_at), stateVersion: Number(row.state_version), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}

interface ScheduleStore extends CapacityGovernanceDatabase {
	getCapacityWorkdayRun(teamId: string, runId: string): Promise<CapacityWorkdayRunRecord | null>;
	createCapacityWorkdayRun(teamId: string, input: Row): Promise<CapacityWorkdayRunRecord>;
	listTeamProjects(teamId: string): Promise<WorkdayProject[]>;
}

export class CapacityWorkdayScheduleService {
	constructor(private readonly store: ScheduleStore) {}
	async get(teamId: string, id: string) { await this.store.ensureInitialized(); return serializeWorkdaySchedule(await this.store.first('SELECT * FROM capacity_workday_schedules WHERE id = ? AND team_id = ?', [id, teamId])); }
	async list(teamId: string) { await this.store.ensureInitialized(); return (await this.store.all('SELECT * FROM capacity_workday_schedules WHERE team_id = ? ORDER BY created_at DESC, id DESC LIMIT 200', [teamId])).map(serializeWorkdaySchedule); }
	async create(teamId: string, input: Row) {
		await this.store.ensureInitialized(); const now = new Date().toISOString(); const projectIds = strings(input.projectIds);
		if (!projectIds.length) throw new CapacityGovernanceError('capacity_workday_schedule_projects_required', 'A schedule requires at least one project id.', 400);
		if (input.availableCredits !== undefined) throw new CapacityGovernanceError('capacity_workday_schedule_legacy_credits_rejected', 'Recurring schedules use agent time, not credits.', 409);
		const durationSeconds = integer(input.durationSeconds, 1800, 60); const maxActiveAssignments = integer(input.maxActiveAssignments, 3, 1);
		const availableSeconds = integer(input.availableSeconds, durationSeconds * maxActiveAssignments, 1); const planningOnly = input.planningOnly !== false; const policy = timePolicy(input.timePolicy, planningOnly);
		const id = text(input.id, randomUUID()); const nextRunAt = text(input.nextRunAt, now); if (!Number.isFinite(Date.parse(nextRunAt))) throw new CapacityGovernanceError('capacity_workday_schedule_time_invalid', 'nextRunAt must be a valid ISO timestamp.', 400);
		await this.store.run(`INSERT INTO capacity_workday_schedules (id, team_id, capacity_provider_id, status, purpose, project_ids_json, agent_selection_json, cadence_seconds, duration_seconds, max_active_assignments, available_seconds, time_policy_json, planning_only, publication_policy_json, last_run_id, next_run_at, state_version, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 1, ?, ?)`,
			[id, teamId, text(input.capacityProviderId), text(input.purpose, 'Recurring editorial workday'), JSON.stringify(projectIds), JSON.stringify(normalizeWorkdayAgentSelection(input.agentSelection)), integer(input.cadenceSeconds, 3600, 60), durationSeconds, maxActiveAssignments, availableSeconds, JSON.stringify(policy), planningOnly ? 1 : 0, JSON.stringify(publicationPolicy(input.publicationPolicy)), nextRunAt, now, now]);
		return this.get(teamId, id);
	}
	async update(teamId: string, id: string, input: Row) {
		const current = await this.get(teamId, id); if (!current) return null;
		const expected = integer(input.stateVersion, current.stateVersion, 1); if (expected !== current.stateVersion) throw new CapacityGovernanceError('capacity_workday_schedule_version_stale', 'Schedule changed after inspection.', 409);
		const status = input.status === undefined ? current.status : String(input.status) as Status; if (!SCHEDULE_STATUSES.has(status)) throw new CapacityGovernanceError('capacity_workday_schedule_status_invalid', 'Schedule status is invalid.', 400);
		const next = { ...current, status, purpose: text(input.purpose, current.purpose), projectIds: input.projectIds ? strings(input.projectIds) : current.projectIds,
			agentSelection: input.agentSelection ? normalizeWorkdayAgentSelection(input.agentSelection) : current.agentSelection,
			cadenceSeconds: integer(input.cadenceSeconds, current.cadenceSeconds, 60), durationSeconds: integer(input.durationSeconds, current.durationSeconds, 60),
			maxActiveAssignments: integer(input.maxActiveAssignments, current.maxActiveAssignments, 1), availableSeconds: integer(input.availableSeconds, current.availableSeconds, 1),
			planningOnly: input.planningOnly === undefined ? current.planningOnly : input.planningOnly === true,
			publicationPolicy: input.publicationPolicy ? publicationPolicy(input.publicationPolicy) : current.publicationPolicy,
			nextRunAt: text(input.nextRunAt, current.nextRunAt), stateVersion: current.stateVersion + 1, updatedAt: new Date().toISOString() };
		const nextTimePolicy = timePolicy(input.timePolicy ?? current.timePolicy, next.planningOnly);
		await this.store.run(`UPDATE capacity_workday_schedules SET status = ?, purpose = ?, project_ids_json = ?, agent_selection_json = ?, cadence_seconds = ?, duration_seconds = ?, max_active_assignments = ?, available_seconds = ?, time_policy_json = ?, planning_only = ?, publication_policy_json = ?, next_run_at = ?, state_version = ?, updated_at = ? WHERE id = ? AND team_id = ? AND state_version = ?`,
			[next.status, next.purpose, JSON.stringify(next.projectIds), JSON.stringify(next.agentSelection), next.cadenceSeconds, next.durationSeconds, next.maxActiveAssignments, next.availableSeconds, JSON.stringify(nextTimePolicy), next.planningOnly ? 1 : 0, JSON.stringify(next.publicationPolicy), next.nextRunAt, next.stateVersion, next.updatedAt, id, teamId, current.stateVersion]);
		const updated = await this.get(teamId, id); if (updated?.stateVersion !== next.stateVersion) throw new CapacityGovernanceError('capacity_workday_schedule_version_stale', 'Schedule changed concurrently.', 409); return updated;
	}
	async tick(teamId: string, id: string, now = new Date().toISOString()) {
		let schedule = await this.get(teamId, id); if (!schedule) return null; if (schedule.status !== 'active') return { schedule, run: null, action: 'inactive' };
		if (schedule.lastRunId) { const last = await this.store.getCapacityWorkdayRun(teamId, schedule.lastRunId); if (last && !TERMINAL_RUNS.has(last.status)) return { schedule, run: last, action: 'active_run' }; if (!last) return this.createClaimedRun(schedule, schedule.lastRunId, now); }
		if (Date.parse(schedule.nextRunAt) > Date.parse(now)) return { schedule, run: null, action: 'not_due' };
		const runId = `schedule-${schedule.id}-${schedule.stateVersion + 1}`; const nextRunAt = new Date(Date.parse(now) + schedule.cadenceSeconds * 1000).toISOString();
		await this.store.run(`UPDATE capacity_workday_schedules SET last_run_id = ?, next_run_at = ?, state_version = state_version + 1, updated_at = ? WHERE id = ? AND team_id = ? AND status = 'active' AND state_version = ? AND next_run_at <= ?`, [runId, nextRunAt, now, id, teamId, schedule.stateVersion, now]);
		schedule = await this.get(teamId, id); if (!schedule || schedule.lastRunId !== runId) return { schedule, run: schedule?.lastRunId ? await this.store.getCapacityWorkdayRun(teamId, schedule.lastRunId) : null, action: 'concurrent_tick' };
		return this.createClaimedRun(schedule, runId, now);
	}
	async tickDue(now = new Date().toISOString()) {
		await this.store.ensureInitialized();
		const rows = await this.store.all(`SELECT * FROM capacity_workday_schedules WHERE status = 'active' ORDER BY next_run_at ASC, id ASC LIMIT 201`);
		if (rows.length > 200) throw new CapacityGovernanceError('capacity_workday_schedule_bound_exceeded', 'Active workday schedules exceed the maintenance bound.', 409);
		let created = 0; const failures: Row[] = [];
		for (const row of rows) {
			const schedule = serializeWorkdaySchedule(row)!;
			try { const result = await this.tick(schedule.teamId, schedule.id, now); if (result?.action === 'created') created += 1; }
			catch (error) { failures.push({ scheduleId: schedule.id, error: error instanceof Error ? error.message : String(error), code: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'schedule_tick_failed' }); }
		}
		return { considered: rows.length, created, failures };
	}
	private async createClaimedRun(schedule: CapacityWorkdayScheduleRecord, runId: string, now: string) {
		const existing = await this.store.getCapacityWorkdayRun(schedule.teamId, runId); if (existing) return { schedule, run: existing, action: 'replayed' };
		const allProjects = await this.store.listTeamProjects(schedule.teamId); const projects = schedule.projectIds.map((id) => allProjects.find((project) => project.id === id)).filter((project): project is WorkdayProject => Boolean(project));
		if (projects.length !== schedule.projectIds.length) throw new CapacityGovernanceError('capacity_workday_schedule_project_missing', 'A scheduled project is unavailable.', 409);
		const run = await this.store.createCapacityWorkdayRun(schedule.teamId, { id: runId, capacityProviderId: schedule.capacityProviderId, scenarioId: schedule.purpose, status: 'running', environment: 'local', startedAt: now,
			parameters: { purpose: schedule.purpose, projects: projects.map((project) => project.slug ?? project.id), durationSeconds: schedule.durationSeconds, maxActiveAssignments: schedule.maxActiveAssignments, availableSeconds: schedule.availableSeconds, timePolicy: schedule.timePolicy, planningOnly: schedule.planningOnly, agentSelection: schedule.agentSelection, publicationPolicy: schedule.publicationPolicy, scheduleId: schedule.id } });
		return { schedule: await this.get(schedule.teamId, schedule.id), run, action: 'created' };
	}
}
