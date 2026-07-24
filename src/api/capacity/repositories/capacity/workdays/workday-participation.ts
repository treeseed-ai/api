import type {
	CapacityWorkdayParticipationCycleRecord,
	CapacityWorkdayParticipationCycleStatus,
	CapacityWorkdayParticipationEntryRecord,
	CapacityWorkdayParticipationEntryStatus,
} from '@treeseed/sdk/agent-capacity';
import { decodeDurableJsonObject } from '../../../durable-json.ts';
import type { CapacityGovernanceDatabase, CapacityDatabaseOperation } from '../../../database.ts';
import { CapacityGovernanceError } from '../../../database.ts';

type Row = Record<string, unknown>;
const CYCLE_STATUSES = new Set<CapacityWorkdayParticipationCycleStatus>(['open', 'covered', 'closed']);
const ENTRY_STATUSES = new Set<CapacityWorkdayParticipationEntryStatus>(['pending', 'assigned', 'completed', 'excluded', 'blocked']);

function required(row: Row, column: string, owner: string): string {
	const value = row[column];
	if (typeof value !== 'string' || !value) throw new CapacityGovernanceError(
		'capacity_workday_participation_corrupt', `${owner} has invalid ${column}.`, 500,
		{ id: typeof row.id === 'string' ? row.id : null, column },
	);
	return value;
}
function nullable(value: unknown): string | null { return typeof value === 'string' && value ? value : null; }

export function serializeParticipationCycleRow(row: Row | null): CapacityWorkdayParticipationCycleRecord | null {
	if (!row) return null;
	const status = required(row, 'status', 'Participation cycle') as CapacityWorkdayParticipationCycleStatus;
	const cycleNumber = Number(row.cycle_number);
	if (!CYCLE_STATUSES.has(status) || !Number.isInteger(cycleNumber) || cycleNumber < 1) throw new CapacityGovernanceError(
		'capacity_workday_participation_corrupt', 'Participation cycle has invalid status or number.', 500,
		{ cycleId: String(row.id ?? ''), status, cycleNumber: row.cycle_number ?? null },
	);
	return {
		id: required(row, 'id', 'Participation cycle'), teamId: required(row, 'team_id', 'Participation cycle'),
		projectId: required(row, 'project_id', 'Participation cycle'), workdayRunId: required(row, 'workday_run_id', 'Participation cycle'),
		cycleNumber, status, openedAt: required(row, 'opened_at', 'Participation cycle'), coveredAt: nullable(row.covered_at),
		closedAt: nullable(row.closed_at), createdAt: required(row, 'created_at', 'Participation cycle'), updatedAt: required(row, 'updated_at', 'Participation cycle'),
	};
}

export function serializeParticipationEntryRow(row: Row | null): CapacityWorkdayParticipationEntryRecord | null {
	if (!row) return null;
	const status = required(row, 'status', 'Participation entry') as CapacityWorkdayParticipationEntryStatus;
	if (!ENTRY_STATUSES.has(status)) throw new CapacityGovernanceError(
		'capacity_workday_participation_corrupt', 'Participation entry has unknown status.', 500,
		{ entryId: String(row.id ?? ''), status },
	);
	return {
		id: required(row, 'id', 'Participation entry'), cycleId: required(row, 'cycle_id', 'Participation entry'),
		teamId: required(row, 'team_id', 'Participation entry'), projectId: required(row, 'project_id', 'Participation entry'),
		workdayRunId: required(row, 'workday_run_id', 'Participation entry'), agentId: required(row, 'agent_id', 'Participation entry'),
		projectAgentClassId: required(row, 'project_agent_class_id', 'Participation entry'), status,
		reasonCode: nullable(row.reason_code), demandId: nullable(row.demand_id), assignmentId: nullable(row.assignment_id),
		coveredAt: nullable(row.covered_at),
		metadata: decodeDurableJsonObject(row.metadata_json, { owner: 'capacity workday participation entry', ownerId: String(row.id ?? ''), column: 'metadata_json' }),
		createdAt: required(row, 'created_at', 'Participation entry'), updatedAt: required(row, 'updated_at', 'Participation entry'),
	};
}

export interface ParticipationAgentInput {
	agentId: string;
	projectAgentClassId: string;
	eligible: boolean;
	reasonCode?: string | null;
	metadata?: Record<string, unknown>;
}

export class CapacityWorkdayParticipationRepository {
	constructor(private readonly database: CapacityGovernanceDatabase) {}

	async ensureOpenCycle(input: {
		teamId: string; projectId: string; workdayRunId: string; agents: ParticipationAgentInput[]; now: string;
	}): Promise<{ cycle: CapacityWorkdayParticipationCycleRecord; entries: CapacityWorkdayParticipationEntryRecord[] }> {
		await this.database.ensureInitialized();
		const latest = serializeParticipationCycleRow(await this.database.first(
			`SELECT * FROM capacity_workday_participation_cycles WHERE workday_run_id = ? AND project_id = ? ORDER BY cycle_number DESC LIMIT 1`,
			[input.workdayRunId, input.projectId],
		));
		let cycleNumber = latest?.cycleNumber ?? 1;
		if (latest) {
			const missingAgentOperations = input.agents.map((agent): CapacityDatabaseOperation => ({
				query: `INSERT INTO capacity_workday_participation_entries (id, cycle_id, team_id, project_id, workday_run_id, agent_id,
				 project_agent_class_id, status, reason_code, covered_at, metadata_json, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (cycle_id, agent_id) DO NOTHING`,
				params: [
					`entry:${latest.id}:${agent.agentId}`, latest.id, input.teamId, input.projectId, input.workdayRunId, agent.agentId,
					agent.projectAgentClassId, agent.eligible ? 'pending' : 'excluded', agent.eligible ? null : agent.reasonCode ?? 'agent_ineligible',
					agent.eligible ? null : input.now, JSON.stringify(agent.metadata ?? {}), input.now, input.now,
				],
			}));
			if (missingAgentOperations.length) await this.database.batch(missingAgentOperations);
			const unresolved = await this.database.first<{ total?: unknown }>(
				`SELECT COUNT(*) AS total FROM capacity_workday_participation_entries WHERE cycle_id = ? AND status IN ('pending','assigned','blocked')`,
				[latest.id],
			);
			if (Number(unresolved?.total ?? 0) === 0) {
				await this.database.run(
					`UPDATE capacity_workday_participation_cycles SET status = 'closed', covered_at = COALESCE(covered_at, ?), closed_at = COALESCE(closed_at, ?), updated_at = ? WHERE id = ? AND status != 'closed'`,
					[input.now, input.now, input.now, latest.id],
				);
				cycleNumber = latest.cycleNumber + 1;
			} else {
				return { cycle: latest, entries: await this.listEntries(latest.id) };
			}
		}
		const cycleId = `cycle:${input.workdayRunId}:${input.projectId}:${cycleNumber}`;
		const operations: CapacityDatabaseOperation[] = [{
			query: `INSERT INTO capacity_workday_participation_cycles (id, team_id, project_id, workday_run_id, cycle_number, status, opened_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?) ON CONFLICT (workday_run_id, project_id, cycle_number) DO NOTHING`,
			params: [cycleId, input.teamId, input.projectId, input.workdayRunId, cycleNumber, input.now, input.now, input.now],
		}];
		for (const agent of input.agents) operations.push({
			query: `INSERT INTO capacity_workday_participation_entries (id, cycle_id, team_id, project_id, workday_run_id, agent_id,
			 project_agent_class_id, status, reason_code, covered_at, metadata_json, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (cycle_id, agent_id) DO NOTHING`,
			params: [
				`entry:${cycleId}:${agent.agentId}`, cycleId, input.teamId, input.projectId, input.workdayRunId, agent.agentId,
				agent.projectAgentClassId, agent.eligible ? 'pending' : 'excluded', agent.eligible ? null : agent.reasonCode ?? 'agent_ineligible',
				agent.eligible ? null : input.now, JSON.stringify(agent.metadata ?? {}), input.now, input.now,
			],
		});
		await this.database.batch(operations);
		const cycle = serializeParticipationCycleRow(await this.database.first(`SELECT * FROM capacity_workday_participation_cycles WHERE id = ? LIMIT 1`, [cycleId]));
		if (!cycle) throw new CapacityGovernanceError('capacity_workday_participation_persistence_failed', 'Participation cycle was not persisted.', 500, { cycleId });
		return { cycle, entries: await this.listEntries(cycle.id) };
	}

	async listEntries(cycleId: string): Promise<CapacityWorkdayParticipationEntryRecord[]> {
		return (await this.database.all(
			`SELECT * FROM capacity_workday_participation_entries WHERE cycle_id = ? ORDER BY agent_id ASC`, [cycleId],
		)).map((row) => serializeParticipationEntryRow(row)!);
	}

	async bindDemand(entryId: string, demandId: string, now: string): Promise<CapacityWorkdayParticipationEntryRecord | null> {
		await this.database.run(
			`UPDATE capacity_workday_participation_entries SET status = 'assigned', demand_id = ?, updated_at = ?
			 WHERE id = ? AND status = 'pending' AND demand_id IS NULL`, [demandId, now, entryId],
		);
		return serializeParticipationEntryRow(await this.database.first(`SELECT * FROM capacity_workday_participation_entries WHERE id = ? LIMIT 1`, [entryId]));
	}

	async bindAssignment(demandId: string, assignmentId: string, now: string): Promise<void> {
		await this.database.run(
			`UPDATE capacity_workday_participation_entries SET assignment_id = ?, updated_at = ? WHERE demand_id = ? AND status = 'assigned'`,
			[assignmentId, now, demandId],
		);
	}

	async markCovered(assignmentId: string, status: 'completed' | 'blocked', reasonCode: string | null, now: string): Promise<void> {
		await this.database.run(
			`UPDATE capacity_workday_participation_entries SET status = ?, reason_code = ?, covered_at = ?, updated_at = ?
			 WHERE assignment_id = ? AND status = 'assigned'`, [status, reasonCode, now, now, assignmentId],
		);
	}
}
