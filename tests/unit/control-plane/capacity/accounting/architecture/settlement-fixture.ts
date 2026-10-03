import { readFileSync } from 'node:fs';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { assignment } from '../../execution/fixtures/assignment.ts';
import { closeoutDatabase } from '../../execution/graph/architecture/closeout-sql-fixture.ts';
import { splitPostgresSqlStatements } from '../../../../../../src/api/persistence/postgres-sql-statements.ts';
import type { CapacityGovernanceDatabase } from '../../../../../../src/api/capacity/database.ts';
import type { CapacitySettlementRequest } from '../../../../../../src/api/capacity/services/capacity/accounting/settlement-service.ts';

export const frozenAttempt = assignmentAttemptSchema.parse({ ...assignment, id: 'assignment-report',
	idempotencyKey: 'assignment-report', agentClass: 'configured-builder', nodeId: 'report-node',
	status: 'completed', createdAt: '2026-10-02T21:00:00.000Z', deadline: '2026-10-02T21:00:03.000Z',
	sourceRef: { ...assignment.sourceRef, repository: 'team-library', commit: 'a'.repeat(40), path: 'proposals/work.mdx' },
	authorityRefs: [{ ...assignment.authorityRefs[0], store: 'treedx', repository: 'team-library',
		commit: 'a'.repeat(40), path: 'decisions/work.mdx' }],
	effectiveProfile: { ...assignment.effectiveProfile, profileRef: { ...assignment.effectiveProfile.profileRef,
		id: 'configured-builder', repository: 'team-library', commit: 'a'.repeat(40), path: 'agents/builder.yaml' } } });

export const terminalUsage: CapacitySettlementRequest = { settlementKey: 'settlement-report', teamId: 'team',
	membershipId: 'membership', reservationId: 'reservation', assignmentId: frozenAttempt.id, assignmentAttempt: 1,
	activeSeconds: 2, elapsedSeconds: 3, source: 'isolated-settlement-input',
	usageActual: { executionProviderId: frozenAttempt.provider.executionProviderId,
		modelName: frozenAttempt.provider.modelConfigurationId, businessModel: 'isolated-provider-input',
		nativeUsage: { activeSeconds: 2, tokens: 7 }, inputTokens: 7 } };

/** Real original DDL, unique guards and transactional SQL. Inputs are isolated,
 * not generated provider usage, canonical Settlements or live admission proof. */
export async function settlementDatabase() {
	const base = await closeoutDatabase();
	try {
		const initial = splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0000_control_plane.sql', 'utf8'));
		for (const table of ['capacity_usage_actuals', 'capacity_ledger_entries', 'capacity_admission_counters', 'capacity_reservation_counter_claims']) {
			const ddl = initial.filter(sql => sql.startsWith(`CREATE TABLE "${table}" (`));
			if (ddl.length !== 1) throw new Error(`Missing original ${table} DDL`);
			await base.db.exec(ddl[0]!);
		}
		for (const name of ['idx_capacity_ledger_settlement_key', 'idx_capacity_ledger_reservation_phase',
			'idx_capacity_usage_actuals_idempotency', 'idx_capacity_usage_actuals_attempt_dimension', 'idx_capacity_reservation_counter_claim']) {
			const ddl = initial.filter(sql => sql.startsWith(`CREATE UNIQUE INDEX "${name}" `));
			if (ddl.length !== 1) throw new Error(`Missing original ${name} index`);
			await base.db.exec(ddl[0]!);
		}
		await base.db.exec(readFileSync('drizzle/control-plane/0033_settle_actual_usage_without_approval.sql', 'utf8'));
		await base.query(`UPDATE capacity_provider_assignments SET project_agent_class_id=?,assignment_attempt_json=?,attempt_count=1
			WHERE id=?`, [frozenAttempt.agentClass, JSON.stringify(frozenAttempt), frozenAttempt.id]);
		await base.query(`UPDATE capacity_reservations SET state='consuming',project_agent_class_id=?,reserved_seconds=2,
			requested_seconds=2,active_seconds=0,elapsed_seconds=0 WHERE id='reservation'`, [frozenAttempt.agentClass]);
		const at = frozenAttempt.createdAt;
		await base.query(`INSERT INTO capacity_admission_counters (id,team_id,scope,scope_id,period_key,hard_limit,committed_amount,created_at,updated_at)
			VALUES ('seconds','team','model-active-seconds','provider','day',3,2,?,?),
			('concurrency','team','concurrency','provider','current',1,1,?,?)`, [at, at, at, at]);
		await base.query(`INSERT INTO capacity_reservation_counter_claims (reservation_id,counter_id,reserved_amount,release_policy,created_at,updated_at)
			VALUES ('reservation','seconds',2,'period',?,?),('reservation','concurrency',1,'assignment-terminal',?,?)`, [at, at, at, at]);
		const snapshot = async () => {
			const result: Record<string, unknown> = {};
			for (const table of ['capacity_provider_assignments', 'capacity_reservations', 'capacity_usage_actuals',
				'capacity_ledger_entries', 'capacity_admission_counters', 'capacity_reservation_counter_claims']) {
				result[table] = (await base.query(`SELECT * FROM ${table} ORDER BY 1`)).rows;
			}
			return result;
		};
		return { ...base, owner: base.store as unknown as CapacityGovernanceDatabase, snapshot };
	} catch (error) { await base.db.close(); throw error; }
}
