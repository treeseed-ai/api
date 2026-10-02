import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { compileWorkday } from '@treeseed/sdk/agent-capacity';
import type { CapacityGovernanceDatabase } from '../../../../../../../src/api/capacity/database.ts';
import { CapacityWorkdayRunRepository } from '../../../../../../../src/api/capacity/repositories/capacity/workdays/workday-run.ts';
import { CapacityWorkdayRunWriteRepository } from '../../../../../../../src/api/capacity/repositories/capacity/workdays/workday-run-write.ts';
import { compileCapacityWorkdayRunRecord } from '../../../../../../../src/api/capacity/services/capacity/workdays/scheduling/workday-run-service.ts';
import { splitPostgresSqlStatements } from '../../../../../../../src/api/persistence/postgres-sql-statements.ts';

export const now = '2026-10-02T21:01:00.000Z';
export const reportRef = { kind: 'treedx' as const, projectId: 'project', repository: 'team-library',
	commit: 'a'.repeat(40), path: 'notes/workday-report.mdx' };
export const reportResult = { schemaVersion: 'treeseed.assignment-result/v1', id: 'result-report', assignmentId: 'assignment-report',
	status: 'completed', summary: 'Isolated SQL component input, not live report evidence.', references: [reportRef],
	verification: [], diagnostics: [], usage: { elapsedSeconds: 1 }, completedAt: now };

/** Original owning DDL and real repositories; no lifecycle query or write is mocked. */
export async function closeoutDatabase() {
	const db = new PGlite();
	try {
		const tables = ['capacity_workday_runs', 'capacity_provider_assignments', 'capacity_reservations', 'audit_events'];
		const initial = splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0000_control_plane.sql', 'utf8'));
		for (const table of tables) {
			const statements = initial.filter(sql => sql.startsWith(`CREATE TABLE "${table}" (`));
			if (statements.length !== 1) throw new Error(`Missing or duplicate original DDL: ${table}`);
			await db.exec(statements[0]!);
		}
		for (const migration of ['0023_living_execution_graph.sql', '0031_workday_execution_mode_authority.sql']) {
			for (const statement of splitPostgresSqlStatements(readFileSync(`drizzle/control-plane/${migration}`, 'utf8'))) {
				await db.exec(statement);
			}
		}
		const query = async (sql: string, parameters: unknown[] = []) => {
			let index = 0;
			return db.query<Record<string, unknown>>(sql.replace(/\?/gu, () => `$${++index}`), parameters);
		};
		const database = {
			ensureInitialized: async () => undefined,
			all: async (sql: string, parameters: unknown[] = []) => (await query(sql, parameters)).rows,
			first: async (sql: string, parameters: unknown[] = []) => (await query(sql, parameters)).rows[0] ?? null,
			run: query,
			batch: (operations: Array<{ query: string; params?: unknown[] }>) => db.transaction(async transaction => {
				const results = [];
				for (const operation of operations) {
					let index = 0;
					const result = await transaction.query<Record<string, unknown>>(
						operation.query.replace(/\?/gu, () => `$${++index}`), operation.params ?? []);
					results.push({ results: result.rows });
				}
				return results;
			}),
		};
		const owner = database as unknown as CapacityGovernanceDatabase;
		const reads = new CapacityWorkdayRunRepository(owner), writes = new CapacityWorkdayRunWriteRepository(owner);
		const plan = { ...compileWorkday({ id: 'workday', teamId: 'team', policyId: 'default', policyRevision: 1,
			executionMode: 'simulation', startsAt: '2026-10-02T21:00:00.000Z', agentIds: [],
			policy: { durationSeconds: 60, planningPercent: 20, maximumConcurrency: 5, communicationConcurrency: 5 } }),
			state: 'closing', closingAt: now };
		await writes.create(compileCapacityWorkdayRunRecord('team', { id: 'workday', status: 'running',
			executionMode: 'simulation', startedAt: plan.startsAt,
			parameters: { durationSeconds: 60, appliedPlan: plan } }, { now }));
		await query(`INSERT INTO execution_nodes (id,team_id,project_id,workday_id,kind,source_ref_json,rule_revision,
			node_revision,agent_class,status,graph_revision_created,graph_revision_updated,created_at,updated_at)
			VALUES ('report-node','team','project','workday','reporting','{}',1,1,'closeout-author','completed',1,1,?,?)`, [now, now]);
		await query(`INSERT INTO capacity_provider_assignments (id,membership_id,team_id,project_id,capacity_provider_id,
			project_agent_class_id,work_day_id,mode,status,execution_node_id,assignment_result_json,completed_at,created_at,updated_at)
			VALUES ('assignment-report','membership','team','project','provider','closeout-author','workday','acting',
			'completed','report-node',?,?,?,?)`, [JSON.stringify(reportResult), now, now, now]);
		// The fixture begins after content integration. It does not simulate or claim a native TreeDX read-back.
		await query(`INSERT INTO audit_events (id,actor_type,event_type,target_type,target_id,data_json,created_at)
			VALUES ('integrated-input','service','assignment.content.integrated','capacity_provider_assignment',
			'assignment-report','{}',?)`, [now]);
		await query(`INSERT INTO capacity_reservations (id,idempotency_key,admission_token,membership_id,capacity_provider_id,
			project_agent_class_id,assignment_id,mode,team_id,project_id,work_day_id,state,requested_seconds,reserved_seconds,
			active_seconds,elapsed_seconds,created_at,updated_at)
			VALUES ('reservation','reservation','token','membership','provider','closeout-author','assignment-report',
			'acting','team','project','workday','consumed',10,10,1,1,?,?)`, [now, now]);
		return { db, reads, query, store: { ...database,
			updateCapacityWorkdayRun: async (teamId: string, runId: string, input: Record<string, unknown>) => {
				const current = await reads.get(teamId, runId);
				if (!current) return null;
				return writes.update({ ...current, ...input }, current.status);
			},
		} };
	} catch (error) { await db.close(); throw error; }
}
