import { describe, expect, it } from 'vitest';
import { executePostgresBatch } from '../../../../../../src/api/support/control-plane-postgres.ts';
import { recoverExpiredProviderAssignments } from '../../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-recovery-service.ts';
import { cancellationDatabase, cancelNow } from './cancellation-fixture.ts';

async function transactionalRecovery(started = false) {
	const fixture = await cancellationDatabase('leased', started);
	const transactionalOwner = Object.assign(fixture.owner, { db: { transaction: async <T>(run: (client: Parameters<typeof executePostgresBatch>[0]) => Promise<T>) =>
		fixture.db.transaction(transaction => run(transaction as unknown as Parameters<typeof executePostgresBatch>[0])) } });
	return { ...fixture, transactionalOwner };
}

// REAL original SQL/service/row lock/transaction. Native PGlite transactions
// do NOT establish independent PostgreSQL connection concurrency or provider teardown.
describe('expired assignment recovery through original SQL and transaction authority', () => {
	it('late recovery retains unknown executed usage and the original attempt without a fabricated zero settlement or a reopened ready node', async () => {
		const { db, transactionalOwner, query, assignment, snapshot } = await transactionalRecovery(true);
		try {
			// Supplied reporting clock after the ORIGINAL 90-second recovery grace;
			// never a refreshed lease, productive deadline or measured zero usage.
			const now = new Date(Date.parse(assignment.leaseExpiresAt!) + 90_001).toISOString(), before = await snapshot();
			const result = await recoverExpiredProviderAssignments(transactionalOwner, { now, teamId: 'team', providerId: 'provider' });
			expect(result).toEqual({ scanned: 1, recovered: 1, safeRetries: 0, terminalFailures: 0, completed: 0, operatorActions: 1,
				results: [{ assignmentId: assignment.id, disposition: 'operator-action', status: 'expired', reasonCode: 'expired_lease_execution_usage_unknown' }] });
			const after = await snapshot();
			for (const table of ['capacity_reservations', 'capacity_usage_actuals', 'capacity_ledger_entries', 'capacity_admission_counters', 'capacity_reservation_counter_claims'])
				expect(after[table]).toEqual(before[table]);
			const row = (await query('SELECT * FROM capacity_provider_assignments WHERE id=?', [assignment.id])).rows[0]!;
			expect(JSON.parse(String(row.assignment_attempt_json))).toEqual({ ...assignment.assignmentAttempt,
				status: 'expired', finishedAt: now });
			expect(JSON.parse(String(row.capacity_envelope_json))).toEqual(assignment.capacityEnvelope);
			expect(row).toMatchObject({ status: 'expired', lease_state: 'expired', lease_token: null, lease_expires_at: null,
				attempt_count: assignment.attemptCount, state_version: assignment.stateVersion + 1, lifecycle_code: 'expired_lease_execution_usage_unknown' });
			expect((await query('SELECT status,node_revision FROM execution_nodes WHERE id=?', [assignment.executionNodeId])).rows)
				.toEqual([{ status: 'failed', node_revision: assignment.executionNodeRevision }]);
			const audit = (await query('SELECT action,resource_id,idempotency_key FROM capacity_audit_events ORDER BY id')).rows;
			expect(audit).toEqual([{ action: 'capacity-assignment.recovery.operator-action', resource_id: assignment.id,
				idempotency_key: `lease-recovery:${assignment.id}:${assignment.stateVersion}` }]);
			expect(await recoverExpiredProviderAssignments(transactionalOwner, { now, teamId: 'team', providerId: 'provider' }))
				.toMatchObject({ scanned: 0, recovered: 0, results: [] });
			expect(await snapshot()).toEqual(after);
			expect((await query('SELECT action,resource_id,idempotency_key FROM capacity_audit_events ORDER BY id')).rows).toEqual(audit);
		} finally { await db.close(); }
	});
	it('leaves executing leases available only for bounded terminal reporting without granting productive time', async () => {
		const { db, owner, snapshot } = await cancellationDatabase('leased', true);
		try {
			const before = await snapshot();
			expect(await recoverExpiredProviderAssignments(owner, { now: cancelNow, teamId: 'team', providerId: 'provider' }))
				.toMatchObject({ scanned: 0, recovered: 0, results: [] });
			expect(await snapshot()).toEqual(before);
		} finally { await db.close(); }
	});
	it('reconciles a preparation-only expired lease without rewriting its attempt and settles the released reservation once', async () => {
		const { db, transactionalOwner, query, assignment, snapshot } = await transactionalRecovery();
		try {
			// The adapter exposes the SAME real transactional query client to the
			// existing PostgreSQL owner; it does not replace any lifecycle SQL.
			const before = await snapshot();
			const result = await recoverExpiredProviderAssignments(transactionalOwner, { now: cancelNow, teamId: 'team', providerId: 'provider' })
				.catch(async error => { expect(await snapshot()).toEqual(before); throw error; });
			expect(result).toMatchObject({ scanned: 1, recovered: 1, terminalFailures: 1 });
			const row = (await query('SELECT attempt_count,assignment_attempt_json,status,lease_token FROM capacity_provider_assignments')).rows[0]!;
			expect(row.attempt_count).toBe(assignment.attemptCount);
			expect(JSON.parse(String(row.assignment_attempt_json))).toEqual({ ...assignment.assignmentAttempt,
				status: 'failed', finishedAt: cancelNow });
			expect(row.status).toBe('failed'); expect(row.lease_token).toBeNull();
			expect((await query('SELECT COUNT(*) AS total FROM capacity_ledger_entries')).rows).toEqual([{ total: 1 }]);
			expect(await recoverExpiredProviderAssignments(transactionalOwner, { now: cancelNow, teamId: 'team', providerId: 'provider' }))
				.toMatchObject({ scanned: 0, recovered: 0 });
		} finally { await db.close(); }
	});
});
