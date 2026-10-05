import assert from 'node:assert/strict';
import { dependencyLease } from '../leasing/dependency-lease-fixture.ts';
import { ControlPlaneStore } from '../../../../../../../../src/api/persistence/store.ts';
import { leaseNextProviderAssignment } from '../../../../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-lease-service.ts';

// Actual original store/synthesis/recovery/lease SQL. No lifecycle method, query,
// clock or serializer is mocked. Principal and reviewed predecessor rows remain
// INPUTS, not wire authentication, native model output or provider usage.
export async function dependencyPoll() {
	const f = await dependencyLease(() => new Date().toISOString(), true);
	try {
		class Statement {
			constructor(readonly sql: string, readonly params: unknown[]) {}
			async run() { const result = await f.query(this.sql, this.params); return { success: true, meta: { changes: result.affectedRows ?? result.rows.length } }; }
			async first() { return (await f.query(this.sql, this.params)).rows[0] ?? null; }
			async all() { return { results: (await f.query(this.sql, this.params)).rows }; }
		}
		const store = new ControlPlaneStore({ TREESEED_ENVIRONMENT: 'test' }, {
			prepare: (sql: string) => ({ bind: (...params: unknown[]) => new Statement(sql, params) }),
			batch: (statements: unknown[]) => f.db.transaction(async transaction => {
				for (const statement of statements) {
					assert.ok(statement instanceof Statement); let index = 0;
					await transaction.query(statement.sql.replace(/\?/gu, () => `$${++index}`), statement.params);
				}
			}),
		});
		store.initializationPromise = Promise.resolve(); // Original schema already applied; no unrelated owner seeding.
		await f.query('UPDATE capacity_provider_availability_sessions SET execution_providers_json=? WHERE id=?',
			[JSON.stringify([{ id: f.attempt.provider.executionProviderId, runtimeBuild: f.attempt.provider.runtimeBuild,
				status: 'available', maxConcurrentRunners: 1, capabilities: f.attempt.requiredCapabilities,
				lanes: [{ id: 'workday', purpose: 'workday', maxConcurrentRunners: 1 }] }]), 'session']);
		const request = { providerSessionId: 'session', runnerId: 'dependent-runner', leaseSeconds: 30, laneId: 'workday', lanePurpose: 'workday' as const };
		const poll = (input = request, principal = f.principal) => leaseNextProviderAssignment(store, principal, input);
		const custody = async () => ({ attempt: (await f.repository.get(f.principal.teamId, f.attempt.id))?.assignmentAttempt,
			predecessors: (await f.repository.get(f.principal.teamId, f.attempt.id))?.workspaceContext.predecessorResults,
			reservations: (await f.query('SELECT * FROM capacity_reservations ORDER BY id')).rows,
			usage: (await f.query('SELECT * FROM capacity_usage_actuals ORDER BY id')).rows,
			ledger: (await f.query('SELECT * FROM capacity_ledger_entries ORDER BY id')).rows,
			edges: (await f.query('SELECT * FROM execution_edges ORDER BY id')).rows });
		const snapshot = async () => ({ ...await f.snapshot(), audit: (await f.query('SELECT * FROM capacity_audit_events ORDER BY id')).rows });
		// Fail the future test if setup consumed the ORIGINAL window; never skip,
		// extend/rewrite deadline, create a late fixture or use fake clocks.
		assert.ok(Date.now() < Date.parse(f.attempt.deadline), 'Original three-second poll authority elapsed during setup');
		return { ...f, store, request, poll, custody, snapshot };
	} catch (error) { await f.db.close(); throw error; }
}
