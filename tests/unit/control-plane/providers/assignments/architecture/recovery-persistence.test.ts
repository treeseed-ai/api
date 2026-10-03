import { describe, expect, it } from 'vitest';
import { executePostgresBatch } from '../../../../../../src/api/support/control-plane-postgres.ts';
import { recoverExpiredProviderAssignments } from '../../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-recovery-service.ts';
import { cancellationDatabase, cancelNow } from './cancellation-fixture.ts';

// REAL original SQL/service/row lock/transaction. Native PGlite transactions
// do NOT establish independent PostgreSQL connection concurrency or provider teardown.
describe('expired assignment recovery through original SQL and transaction authority', () => {
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
		const { db, owner, query, assignment, snapshot } = await cancellationDatabase();
		try {
			// The adapter exposes the SAME real transactional query client to the
			// existing PostgreSQL owner; it does not replace any lifecycle SQL.
			const transactionalOwner = Object.assign(owner, { db: { transaction: async <T>(run: (client: Parameters<typeof executePostgresBatch>[0]) => Promise<T>) =>
				db.transaction(transaction => run(transaction as unknown as Parameters<typeof executePostgresBatch>[0])) } });
			const before = await snapshot();
			const result = await recoverExpiredProviderAssignments(transactionalOwner, { now: cancelNow, teamId: 'team', providerId: 'provider' })
				.catch(async error => { expect(await snapshot()).toEqual(before); throw error; });
			expect(result).toMatchObject({ scanned: 1, recovered: 1, terminalFailures: 1 });
			const row = (await query('SELECT attempt_count,assignment_attempt_json,status,lease_token FROM capacity_provider_assignments')).rows[0]!;
			expect(row.attempt_count).toBe(assignment.attemptCount);
			expect(JSON.parse(String(row.assignment_attempt_json))).toEqual(assignment.assignmentAttempt);
			expect(row.status).toBe('failed'); expect(row.lease_token).toBeNull();
			expect((await query('SELECT COUNT(*) AS total FROM capacity_ledger_entries')).rows).toEqual([{ total: 1 }]);
			expect(await recoverExpiredProviderAssignments(transactionalOwner, { now: cancelNow, teamId: 'team', providerId: 'provider' }))
				.toMatchObject({ scanned: 0, recovered: 0 });
		} finally { await db.close(); }
	});
});
