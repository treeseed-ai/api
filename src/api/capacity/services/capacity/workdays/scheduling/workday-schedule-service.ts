import { randomUUID } from 'node:crypto';
import type { CapacityWorkdayRunRecord, CapacityWorkdayScheduleRecord } from '@treeseed/sdk/agent-capacity';
import { parsePublicWorkdayIntent, WorkdayPreflightService } from './workday-preflight-service.ts';
import type { WorkdayStartReceipt } from '@treeseed/sdk/operator-contracts';
import type { CapacityGovernanceDatabase } from '../../../../database.ts';
import { CapacityGovernanceError } from '../../../../database.ts';

type Row = Record<string, unknown>;
type Status = CapacityWorkdayScheduleRecord['status'];
const TERMINAL_RUNS = new Set(['completed', 'cancelled', 'failed', 'degraded']);
const SCHEDULE_STATUSES = new Set<Status>(['active', 'paused', 'completed', 'failed']);

function json<T>(value: unknown, fallback: T): T { try { return typeof value === 'string' ? JSON.parse(value) as T : value as T; } catch { return fallback; } }
function text(value: unknown, fallback = '') { return typeof value === 'string' && value.trim() ? value.trim() : fallback; }
function integer(value: unknown, fallback: number, minimum: number) { const parsed = Number(value ?? fallback); if (!Number.isInteger(parsed) || parsed < minimum) throw new CapacityGovernanceError('capacity_workday_schedule_value_invalid', `Schedule value must be an integer of at least ${minimum}.`, 400); return parsed; }
function inputKeys(input: Row, allowed: string[]) {
	const unexpected = Object.keys(input).filter(key => !allowed.includes(key));
	if (unexpected.length) throw new CapacityGovernanceError('capacity_workday_schedule_fields_invalid', `Unsupported schedule fields: ${unexpected.join(', ')}. Use canonical workday intent.`, 400);
}
export function serializeWorkdaySchedule(row: Row | null): CapacityWorkdayScheduleRecord | null {
	if (!row) return null; const status = String(row.status) as Status;
	if (!SCHEDULE_STATUSES.has(status)) throw new CapacityGovernanceError('capacity_workday_schedule_corrupt', 'Schedule status is invalid.', 500);
	return { id: String(row.id), teamId: String(row.team_id), status, purpose: String(row.purpose),
		cadenceSeconds: Number(row.cadence_seconds), intent: parsePublicWorkdayIntent(String(row.team_id), json(row.intent_json, {})),
		lastRunId: row.last_run_id ? String(row.last_run_id) : null,
		nextRunAt: String(row.next_run_at), stateVersion: Number(row.state_version), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}

interface ScheduleStore extends CapacityGovernanceDatabase {
	getCapacityWorkdayRun(teamId: string, runId: string): Promise<CapacityWorkdayRunRecord | null>;
	createCapacityWorkdayRun(teamId: string, input: Row): Promise<CapacityWorkdayRunRecord>;
	preflightCapacityWorkdayRunRequest(teamId: string, input: Row): Promise<Row>;
}

export class CapacityWorkdayScheduleService {
	constructor(private readonly store: ScheduleStore) {}
	async get(teamId: string, id: string) { await this.store.ensureInitialized(); return serializeWorkdaySchedule(await this.store.first('SELECT * FROM capacity_workday_schedules WHERE id = ? AND team_id = ?', [id, teamId])); }
	async list(teamId: string) { await this.store.ensureInitialized(); return (await this.store.all('SELECT * FROM capacity_workday_schedules WHERE team_id = ? ORDER BY created_at DESC, id DESC LIMIT 200', [teamId])).map(serializeWorkdaySchedule); }
	async create(teamId: string, input: Row) {
		inputKeys(input, ['id', 'purpose', 'intent', 'cadenceSeconds', 'nextRunAt']);
		await this.store.ensureInitialized(); const now = new Date().toISOString();
		const intent = parsePublicWorkdayIntent(teamId, input.intent as Row ?? {});
		const id = text(input.id, randomUUID()); const nextRunAt = text(input.nextRunAt, now); if (!Number.isFinite(Date.parse(nextRunAt))) throw new CapacityGovernanceError('capacity_workday_schedule_time_invalid', 'nextRunAt must be a valid ISO timestamp.', 400);
		await this.store.run(`INSERT INTO capacity_workday_schedules (id, team_id, status, purpose, cadence_seconds, intent_json, last_run_id, next_run_at, state_version, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?, NULL, ?, 1, ?, ?)`,
			[id, teamId, text(input.purpose, 'Recurring workday'), integer(input.cadenceSeconds, 3600, 60), JSON.stringify(intent), nextRunAt, now, now]);
		return this.get(teamId, id);
	}
	async update(teamId: string, id: string, input: Row) {
		inputKeys(input, ['stateVersion', 'status', 'purpose', 'intent', 'cadenceSeconds', 'nextRunAt']);
		const current = await this.get(teamId, id); if (!current) return null;
		const expected = integer(input.stateVersion, current.stateVersion, 1); if (expected !== current.stateVersion) throw new CapacityGovernanceError('capacity_workday_schedule_version_stale', 'Schedule changed after inspection.', 409);
		const status = input.status === undefined ? current.status : String(input.status) as Status; if (!SCHEDULE_STATUSES.has(status)) throw new CapacityGovernanceError('capacity_workday_schedule_status_invalid', 'Schedule status is invalid.', 400);
		const next = { ...current, status, purpose: text(input.purpose, current.purpose),
			intent: input.intent === undefined ? current.intent : parsePublicWorkdayIntent(teamId, input.intent as Row),
			cadenceSeconds: integer(input.cadenceSeconds, current.cadenceSeconds, 60),
			nextRunAt: text(input.nextRunAt, current.nextRunAt), stateVersion: current.stateVersion + 1, updatedAt: new Date().toISOString() };
		if (!Number.isFinite(Date.parse(next.nextRunAt))) throw new CapacityGovernanceError('capacity_workday_schedule_time_invalid', 'nextRunAt must be a valid ISO timestamp.', 400);
		await this.store.run(`UPDATE capacity_workday_schedules SET status = ?, purpose = ?, cadence_seconds = ?, intent_json = ?, next_run_at = ?, state_version = ?, updated_at = ? WHERE id = ? AND team_id = ? AND state_version = ?`,
			[next.status, next.purpose, next.cadenceSeconds, JSON.stringify(next.intent), next.nextRunAt, next.stateVersion, next.updatedAt, id, teamId, current.stateVersion]);
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
		const idempotencyKey = `workday-schedule:${schedule.id}:${runId}`;
		const saved = await this.store.first(`SELECT response_json FROM capacity_operation_receipts WHERE team_id = ? AND operation = 'workday.start' AND idempotency_key = ? LIMIT 1`, [schedule.teamId, idempotencyKey]);
		let receipt: WorkdayStartReceipt;
		if (saved) receipt = json(saved.response_json, null)!;
		else {
			const service = new WorkdayPreflightService(this.store);
			const { endsAt, ...intent } = schedule.intent;
			const preflight = await service.preflight(schedule.teamId, parsePublicWorkdayIntent(schedule.teamId, { ...intent, startsAt: schedule.updatedAt,
				...(endsAt ? { durationSeconds: Math.floor((Date.parse(endsAt) - Date.parse(intent.startsAt)) / 1000) } : {}) }), null, runId);
			receipt = await service.start(schedule.teamId, { preflightId: preflight.id, preflightDigest: preflight.preflightDigest, idempotencyKey }, null);
		}
		await this.store.run(`UPDATE capacity_workday_schedules SET last_run_id = ?, updated_at = ? WHERE id = ? AND team_id = ? AND last_run_id = ?`, [receipt.workdayId, now, schedule.id, schedule.teamId, runId]);
		return { schedule: await this.get(schedule.teamId, schedule.id), run: await this.store.getCapacityWorkdayRun(schedule.teamId, receipt.workdayId), action: saved ? 'replayed' : 'created' };
	}
}
