import type { CapacityWorkdayRunRecord,CapacityWorkdayRunStatus } from '@treeseed/sdk/agent-capacity';
import type { CapacityGovernanceDatabase } from '../../../database.ts';
import { CapacityWorkdayRunRepository } from './workday-run.ts';

export class CapacityWorkdayRunWriteRepository {
	private readonly reads: CapacityWorkdayRunRepository;
	constructor(private readonly database: CapacityGovernanceDatabase) { this.reads = new CapacityWorkdayRunRepository(database); }
	private insertOperation(value: CapacityWorkdayRunRecord) {
		return { query: `INSERT INTO capacity_workday_runs (id, team_id, capacity_provider_id, scenario_id, status, environment, execution_mode, execution_kind, trigger_kind, hidden, requested_by_id,
			parameters_json, summary_json, metrics_json, expected_json, actual_json, report_refs_json, error_json, started_at, completed_at, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, params: [value.id, value.teamId, value.capacityProviderId, value.scenarioId, value.status,
			value.environment, value.executionMode, value.executionKind ?? 'workday', value.triggerKind ?? 'scheduled', value.hidden ? 1 : 0, value.requestedById, JSON.stringify(value.parameters), JSON.stringify(value.summary), JSON.stringify(value.metrics), JSON.stringify(value.expected),
			JSON.stringify(value.actual), JSON.stringify(value.reportRefs), JSON.stringify(value.error), value.startedAt, value.completedAt, value.createdAt, value.updatedAt] };
	}

	async create(value: CapacityWorkdayRunRecord): Promise<CapacityWorkdayRunRecord> {
		await this.database.ensureInitialized();
		const operation = this.insertOperation(value);
		await this.database.run(operation.query, operation.params);
		return (await this.reads.get(value.teamId, value.id))!;
	}

	async update(value: CapacityWorkdayRunRecord, expectedStatus: CapacityWorkdayRunStatus): Promise<CapacityWorkdayRunRecord | null> {
		await this.database.ensureInitialized();
		const results = await this.database.batch([{ query: `UPDATE capacity_workday_runs SET capacity_provider_id = ?, scenario_id = ?, status = ?, environment = ?, execution_mode = ?, execution_kind = ?, trigger_kind = ?, hidden = ?,
			parameters_json = ?, summary_json = ?, metrics_json = ?, expected_json = ?, actual_json = ?, report_refs_json = ?, error_json = ?, started_at = ?, completed_at = ?, updated_at = ?
			WHERE id = ? AND team_id = ? AND status = ? RETURNING id`, params: [value.capacityProviderId, value.scenarioId, value.status, value.environment, value.executionMode, value.executionKind ?? 'workday', value.triggerKind ?? 'scheduled', value.hidden ? 1 : 0,
			JSON.stringify(value.parameters), JSON.stringify(value.summary), JSON.stringify(value.metrics), JSON.stringify(value.expected), JSON.stringify(value.actual),
			JSON.stringify(value.reportRefs), JSON.stringify(value.error), value.startedAt, value.completedAt, value.updatedAt, value.id, value.teamId, expectedStatus] }]);
		if (!(results as Array<{ results?: Row[] }>)[0]?.results?.[0]) return null;
		return this.reads.get(value.teamId, value.id);
	}

}
