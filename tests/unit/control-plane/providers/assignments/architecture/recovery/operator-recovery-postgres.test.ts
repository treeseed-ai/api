import { describe, expect, it } from 'vitest';
import { postgresGraph } from '../../../../capacity/execution/graph/architecture/living/living-postgres-fixture.ts';
import { cancellationDatabase } from '../cancellation-fixture.ts';
import { OperatorAssignmentService } from '../../../../../../../src/api/capacity/services/capacity/assignments/observability/operator-assignment-service.ts';
import { createAssignmentService } from '../../../../../../../src/api/control-plane/repositories/capacity/assignment-service.ts';
import { createAssignmentOperations } from '../../../../../../../src/api/control-plane/catalog/capacity/assignments.ts';
import { OperationRegistry } from '../../../../../../../src/api/control-plane/catalog/operation-registry.ts';

describe('unresolved recovery with independent native PostgreSQL connections', () => {
	it('native PostgreSQL public recovery rolls back an interrupted audit then serializes independent matching operator calls without measurements or historical rewrites', async () => {
		const native = await postgresGraph();
		try {
			// Controlled original owning fixture inputs, not fabricated provider charges.
			const supplied = await cancellationDatabase('expired');
			try {
				const now = supplied.attempt.createdAt;
				await native.left.pool.query(`INSERT INTO projects (id,team_id,slug,name,created_at,updated_at) VALUES ('project','team','project','Project',$1,$1)`, [now]);
				for (const id of ['isolated-class-row', supplied.attempt.agentClass]) await native.left.pool.query(
					`INSERT INTO project_agent_classes (id,team_id,project_id,slug,name,created_at,updated_at) VALUES ($1,'team','project',$1,$1,$2,$2)`, [id, now]);
				await native.left.pool.query(`INSERT INTO capacity_providers (id,fingerprint,public_jwk_json,display_name,created_at,updated_at) VALUES ('provider','recovery-input','{}','Controlled recovery provider',$1,$1)`, [now]);
				await native.left.pool.query(`INSERT INTO capacity_provider_team_memberships (id,team_id,capacity_provider_id,approved_at,approved_by_id,created_at,updated_at) VALUES ('membership','team','provider',$1,'operator',$1,$1)`, [now]);
				await native.left.pool.query(`INSERT INTO capacity_execution_providers (id,capacity_provider_id,display_name,adapter,native_unit,max_concurrent_runners,created_at,updated_at) VALUES ($1,'provider','Controlled executor','codex','seconds',1,$2,$2)`, [supplied.attempt.provider.executionProviderId, now]);
				await supplied.query("UPDATE capacity_provider_assignments SET lease_state='expired',metadata_json=? WHERE id=?",
					[JSON.stringify({ leaseRecovery: { disposition: 'operator-action' } }), supplied.assignment.id]);
				for (const table of ['capacity_workday_runs', 'execution_nodes', 'capacity_reservations', 'capacity_provider_assignments',
					'capacity_admission_counters', 'capacity_reservation_counter_claims']) {
					const current = await native.left.pool.query<{ column_name: string }>('SELECT column_name FROM information_schema.columns WHERE table_schema=\'public\' AND table_name=$1', [table]);
					const names = new Set(current.rows.map(column => column.column_name));
					for (const row of (await supplied.query(`SELECT * FROM ${table}`)).rows) {
						// Full owning migrations remove retired nullable columns that the
						// older original-DDL fixture still exposes. Never discard a fact.
						for (const column of Object.keys(row).filter(name => !names.has(name))) {
							const emptyRetired = column === 'decision_input_json' ? '{}' : column === 'allocation_slice_ids_json' ? '[]' : null;
							expect(row[column], `${table}.${column}`).toBe(emptyRetired);
						}
						const columns = Object.keys(row).filter(name => names.has(name)), values = columns.map(name => row[name]);
						await native.left.pool.query(`INSERT INTO ${table} (${columns.map(name => `"${name}"`).join(',')}) VALUES (${values.map((_, index) => `$${index + 1}`).join(',')})`, values);
					}
				}
			} finally { await supplied.db.close(); }
			const audit = () => native.left.pool.query('SELECT * FROM capacity_audit_events ORDER BY id');
			const assignments = () => native.left.pool.query('SELECT * FROM capacity_provider_assignments ORDER BY id');
			const held = (await assignments()).rows;
			const calls = [native.left, native.right].map(db => {
				const store = { db, ensureInitialized: async () => {},
					run: async (sql: string, params: unknown[] = []) => { await db.prepare(sql).bind(...params).run(); },
					first: <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => db.prepare(sql).bind(...params).first<T>(),
					all: async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.prepare(sql).bind(...params).all<T>()).results,
					batch: (operations: Array<{ query: string; params?: unknown[] }>) => db.batch(operations) };
				const operator = new OperatorAssignmentService(store);
				const service = createAssignmentService({ ...store, recoverCapacityAssignment: (team: string, id: string, body: Record<string, unknown>) => operator.recover(team, id, body) });
				const registry = new OperationRegistry(createAssignmentOperations({ assignments: service }));
				return () => registry.require('assignments.recover').handler({ path: { teamId: 'team', assignmentId: 'assignment-report' }, query: {},
					body: { expectedStateVersion: 1, reason: 'Original native usage unavailable' } }, { interface: 'rest', requestId: 'native-recovery',
					principal: { id: 'operator', roles: ['admin'] }, idempotencyKey: 'independent-recovery' });
			});
			await native.left.pool.query(`CREATE FUNCTION interrupt_operator_recovery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'independent audit interruption'; END $$;
				CREATE TRIGGER interrupt_operator_recovery BEFORE INSERT ON capacity_audit_events FOR EACH ROW EXECUTE FUNCTION interrupt_operator_recovery();`);
			await expect(calls[0]!()).rejects.toThrow('independent audit interruption');
			expect((await assignments()).rows).toEqual(held); expect((await audit()).rows).toEqual([]);
			expect((await native.left.pool.query('SELECT id,committed_amount FROM capacity_admission_counters ORDER BY id')).rows)
				.toEqual([{ id: 'concurrency', committed_amount: 1 }, { id: 'seconds', committed_amount: 2 }]);
			await native.left.pool.query('DROP TRIGGER interrupt_operator_recovery ON capacity_audit_events');
			const results = await Promise.all(calls.map(call => call())); expect(results[0]).toEqual(results[1]);
			expect(results[0]).toMatchObject({ usageStatus: 'unresolved', settled: false }); expect((await audit()).rows).toHaveLength(1);
			expect((await assignments()).rows).toEqual(held);
			expect((await native.left.pool.query('SELECT id,committed_amount FROM capacity_admission_counters ORDER BY id')).rows)
				.toEqual([{ id: 'concurrency', committed_amount: 0 }, { id: 'seconds', committed_amount: 2 }]);
			expect((await native.left.pool.query('SELECT * FROM capacity_usage_actuals')).rows).toEqual([]);
			expect((await native.left.pool.query('SELECT * FROM capacity_ledger_entries')).rows).toEqual([]);
			expect(await calls[0]!()).toEqual(results[0]);
		} finally { await native.close(); }
	});
});
