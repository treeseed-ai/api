import type { CapacityWorkdayRunRecord, CapacityWorkdayRunStatus } from '@treeseed/sdk/agent-capacity';
import type { CapacityGovernanceDatabase } from '../../../database.ts';
import { CapacityGovernanceError } from '../../../database.ts';
import { CapacityWorkdayRunRepository } from './workday-run.ts';

type Row = Record<string, unknown>;

export class CapacityWorkdayRunWriteRepository {
	private readonly reads: CapacityWorkdayRunRepository;
	constructor(private readonly database: CapacityGovernanceDatabase) { this.reads = new CapacityWorkdayRunRepository(database); }
	private insertOperation(value: CapacityWorkdayRunRecord) {
		return { query: `INSERT INTO capacity_workday_runs (id, team_id, capacity_provider_id, scenario_id, status, environment, requested_by_id,
			parameters_json, summary_json, metrics_json, expected_json, actual_json, report_refs_json, error_json, started_at, completed_at, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, params: [value.id, value.teamId, value.capacityProviderId, value.scenarioId, value.status,
			value.environment, value.requestedById, JSON.stringify(value.parameters), JSON.stringify(value.summary), JSON.stringify(value.metrics), JSON.stringify(value.expected),
			JSON.stringify(value.actual), JSON.stringify(value.reportRefs), JSON.stringify(value.error), value.startedAt, value.completedAt, value.createdAt, value.updatedAt] };
	}

	async create(value: CapacityWorkdayRunRecord): Promise<CapacityWorkdayRunRecord> {
		await this.database.ensureInitialized();
		const operation = this.insertOperation(value);
		await this.database.run(operation.query, operation.params);
		return (await this.reads.get(value.teamId, value.id))!;
	}

	async replaceLocal(value: CapacityWorkdayRunRecord): Promise<{ run: CapacityWorkdayRunRecord; supersededRunIds: string[] }> {
		await this.database.ensureInitialized();
		const now = value.updatedAt;
		const results = await this.database.batch([
			{ query: `SELECT id FROM teams WHERE id = ? FOR UPDATE`, params: [value.teamId] },
			{ query: `SELECT DISTINCT stale_run.id FROM capacity_workday_runs stale_run
				LEFT JOIN capacity_workday_demands stale_demand ON stale_demand.workday_run_id = stale_run.id
				LEFT JOIN capacity_provider_assignments stale_assignment ON stale_assignment.id = stale_demand.assignment_id
				 AND stale_assignment.status NOT IN ('completed','failed','expired','returned')
				WHERE stale_run.team_id = ? AND (CAST(? AS text) IS NULL OR stale_run.capacity_provider_id = CAST(? AS text))
				 AND (stale_run.status = 'running' OR stale_assignment.id IS NOT NULL)
				ORDER BY stale_run.id ASC`, params: [value.teamId, value.capacityProviderId, value.capacityProviderId] },
			{ query: `UPDATE capacity_workday_runs SET status = 'failed', summary_json = ?, metrics_json = ?, error_json = ?, completed_at = COALESCE(completed_at, ?), updated_at = ?
				WHERE team_id = ? AND (CAST(? AS text) IS NULL OR capacity_provider_id = CAST(? AS text)) AND status = 'running'`, params: [
				JSON.stringify({ status: 'failed', reason: 'superseded_by_new_local_workday', supersededByRunId: value.id }), JSON.stringify({ status: 'failed', score: 0 }),
				JSON.stringify({ code: 'superseded_by_new_local_workday', message: 'Closed stale running local workday before scheduling a new run for the same team/provider.', supersededByRunId: value.id }),
				now, now, value.teamId, value.capacityProviderId, value.capacityProviderId,
			] },
			this.insertOperation(value),
		]) as Array<{ results?: Row[] }>;
		const supersededRunIds = (results[1]?.results ?? []).map((row) => String(row.id));
		const run = await this.reads.get(value.teamId, value.id);
		if (!run) throw new CapacityGovernanceError('capacity_workday_run_create_conflict', 'Capacity workday successor was not persisted.', 409, { runId: value.id });
		return { run, supersededRunIds };
	}

	async update(value: CapacityWorkdayRunRecord, expectedStatus: CapacityWorkdayRunStatus): Promise<CapacityWorkdayRunRecord | null> {
		await this.database.ensureInitialized();
		const results = await this.database.batch([{ query: `UPDATE capacity_workday_runs SET capacity_provider_id = ?, scenario_id = ?, status = ?, environment = ?,
			parameters_json = ?, summary_json = ?, metrics_json = ?, expected_json = ?, actual_json = ?, report_refs_json = ?, error_json = ?, started_at = ?, completed_at = ?, updated_at = ?
			WHERE id = ? AND team_id = ? AND status = ? RETURNING id`, params: [value.capacityProviderId, value.scenarioId, value.status, value.environment,
			JSON.stringify(value.parameters), JSON.stringify(value.summary), JSON.stringify(value.metrics), JSON.stringify(value.expected), JSON.stringify(value.actual),
			JSON.stringify(value.reportRefs), JSON.stringify(value.error), value.startedAt, value.completedAt, value.updatedAt, value.id, value.teamId, expectedStatus] }]);
		if (!(results as Array<{ results?: Row[] }>)[0]?.results?.[0]) return null;
		return this.reads.get(value.teamId, value.id);
	}

}
