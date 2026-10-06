import { randomUUID } from 'node:crypto';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { describe, expect, it } from 'vitest';
import { dependencyRevocation } from './dependency-revocation-fixture.ts';

type Fixture = Awaited<ReturnType<typeof dependencyRevocation>>;
function within(f: Fixture) { expect(Date.now()).toBeLessThanOrEqual(Date.parse(f.attempt.deadline)); }
async function pendingCancellation(f: Fixture) {
	const row = await f.repository.get('team', f.attempt.id); expect(row).toMatchObject({ status: 'failed', leaseState: 'released', leaseToken: null, assignmentAttempt: f.attempt,
		workspaceContext: { predecessorResults: [f.actor, f.review] } });
	const ledger = (await f.query('SELECT * FROM capacity_ledger_entries WHERE assignment_id=?', [f.attempt.id])).rows;
	const usage = (await f.query('SELECT * FROM capacity_usage_actuals WHERE assignment_id=?', [f.attempt.id])).rows;
	expect(ledger).toHaveLength(1); expect(usage).toHaveLength(1);
	expect(ledger[0]).toMatchObject({ assignment_id: f.attempt.id, reservation_id: f.attempt.reservationId, team_id: 'team', membership_id: 'membership', active_seconds: 0, elapsed_seconds: 0,
		source: 'provider_membership_revoked', phase: 'task_completed_actual_settlement' });
	expect(usage[0]).toMatchObject({ assignment_id: f.attempt.id, assignment_attempt: 1, accounting_mode: 'aggregate', active_seconds: 0, elapsed_seconds: 0 });
	expect((await f.query('SELECT * FROM capacity_reservations WHERE id=?', [f.attempt.reservationId])).rows[0]).toMatchObject({ state: 'consumed', active_seconds: 0, elapsed_seconds: 0 });
}

describe('real credential revocation and authenticated membership leave', () => {
	it('first concurrent original credential revocation commits one immutable credential token fence and audit while retaining pending assignment and finance', async () => {
		const f = await dependencyRevocation(); try {
			expect((await f.evaluate()).eligible).toBe(true); const custody = await f.custody(), before = await f.revocationState();
			const [first, second] = await Promise.all([f.revoke(), f.revoke()]); expect(first).toEqual(second); expect(first).toMatchObject({ id: 'token-credential', status: 'revoked' });
			const after = await f.revocationState(); expect(after.credentials.find(row => row.id === 'token-credential')).toMatchObject({ status: 'revoked', revoke_idempotency_key: f.revokeKey });
			expect(after.tokens.find(row => row.id === f.authenticated.principal.accessTokenId)?.status).toBe('revoked');
			for (const row of before.tokens.filter(value => value.credential_id !== 'token-credential')) expect(after.tokens).toContainEqual(row);
			expect(after.audit.filter(row => row.action === 'provider-credential.revoked')).toHaveLength(1);
			expect({ ...after, credentials: before.credentials, tokens: before.tokens, audit: before.audit }).toEqual(before);
			await f.revoke(); expect(await f.revocationState()).toEqual(after);
			expect((await f.request(f.requestBody, { token: f.token })).status).toBe(401); expect(await f.revocationState()).toEqual(after);
			expect((await f.issue(f.proof({ ...f.payload, jti: randomUUID() }))).status).toBe(403); expect(await f.revocationState()).toEqual(after);
			for (const row of before.audit) expect(after.audit).toContainEqual(row); expect(await f.custody()).toEqual(custody); within(f);
		} finally { await f.close(); }
	});
	it('foreign team member credential and missing authenticated leave authority deny after genuine issued token baseline with whole auth neutral state unchanged', async () => {
		const f = await dependencyRevocation(); try {
			expect((await f.evaluate()).eligible).toBe(true);
			for (const target of ['team', 'member', 'credential', 'key', 'leave-token'] as const) {
				const before = await f.revocationState(), custody = await f.custody();
				if (target === 'leave-token') expect((await f.leave(f.leaveKey, 'tspa_unknown_wrong')).status).toBe(401);
				else await expect(f.revoke(target === 'key' ? '' : f.revokeKey, target === 'team' ? 'foreign-team' : 'team', target === 'member' ? 'foreign-member' : 'membership', target === 'credential' ? 'foreign-credential' : 'token-credential'))
					.rejects.toMatchObject({ status: target === 'key' ? 400 : 404 });
				expect(await f.revocationState()).toEqual(before); expect(await f.custody()).toEqual(custody); within(f);
			}
		} finally { await f.close(); }
	});
	it('actual credential revocation racing authenticated poll cannot admit a new lease after the committed token fence and retains any original claim custody', async () => {
		const f = await dependencyRevocation(); try {
			const custody = await f.custody(); const [response, revoked] = await Promise.all([f.request(f.requestBody, { token: f.token }), f.revoke()]);
			expect([200, 401]).toContain(response.status);
			if (response.status === 200) {
				const value: unknown = await response.json(); if (!value || typeof value !== 'object' || !('data' in value)) throw new Error('Original poll data missing');
				const data = CONTROL_PLANE_OPERATIONS.providers.nextAssignment.schema.output.parse(value.data);
				if (data.assignment) { expect(data.assignment).toMatchObject({ id: f.attempt.id, assignmentAttempt: f.attempt, workspaceContext: { predecessorResults: [f.actor, f.review] } });
					const row = await f.repository.get('team', f.attempt.id); expect(row?.status).toBe('leased'); expect(data.leaseToken === row?.leaseToken).toBe(true);
					expect(Date.parse(row?.claimedAt ?? '')).toBeLessThanOrEqual(Date.parse(revoked.revokedAt ?? ''));
					expect(Date.parse(row?.leaseExpiresAt ?? '')).toBeLessThanOrEqual(Date.parse(f.attempt.deadline)); }
			}
			const after = await f.revocationState(); expect((await f.request(f.requestBody, { token: f.token })).status).toBe(401);
			expect(await f.revocationState()).toEqual(after); expect(await f.custody()).toEqual(custody); within(f);
		} finally { await f.close(); }
	});
	it('native credential token update interruption rolls back the whole revocation transaction and exact original key retry fences once without deleting history', async () => {
		const f = await dependencyRevocation(); try {
			const before = await f.revocationState(), custody = await f.custody(); await f.db.exec(`CREATE FUNCTION interrupt_revocation_token() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
				IF NEW.status='revoked' THEN RAISE EXCEPTION 'revocation token interruption'; END IF; RETURN NEW; END $$;
				CREATE TRIGGER interrupt_revocation_token BEFORE UPDATE ON capacity_provider_access_tokens FOR EACH ROW EXECUTE FUNCTION interrupt_revocation_token();`);
			await expect(f.revoke()).rejects.toThrow('revocation token interruption'); expect(await f.revocationState()).toEqual(before);
			await f.db.exec('DROP TRIGGER interrupt_revocation_token ON capacity_provider_access_tokens; DROP FUNCTION interrupt_revocation_token();');
			expect(await f.revoke()).toMatchObject({ status: 'revoked' }); const after = await f.revocationState();
			expect(after.audit.filter(row => row.action === 'provider-credential.revoked')).toHaveLength(1); for (const row of before.audit) expect(after.audit).toContainEqual(row);
			expect(await f.custody()).toEqual(custody); within(f);
		} finally { await f.close(); }
	});
	it('late credential revocation audit interruption retains exact revoked credential tokens and same key recovery records only the missing audit', async () => {
		const f = await dependencyRevocation(); try {
			const custody = await f.custody(); await f.db.exec(`CREATE FUNCTION interrupt_revocation_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
				IF NEW.action='provider-credential.revoked' THEN RAISE EXCEPTION 'revocation audit interruption'; END IF; RETURN NEW; END $$;
				CREATE TRIGGER interrupt_revocation_audit BEFORE INSERT ON capacity_audit_events FOR EACH ROW EXECUTE FUNCTION interrupt_revocation_audit();`);
			await expect(f.revoke()).rejects.toThrow('revocation audit interruption'); const failed = await f.revocationState();
			expect(failed.credentials.find(row => row.id === 'token-credential')?.status).toBe('revoked'); expect(failed.tokens.find(row => row.id === f.authenticated.principal.accessTokenId)?.status).toBe('revoked');
			await f.db.exec('DROP TRIGGER interrupt_revocation_audit ON capacity_audit_events; DROP FUNCTION interrupt_revocation_audit();');
			await f.revoke(); const recovered = await f.revocationState(); expect({ ...recovered, audit: failed.audit }).toEqual(failed);
			expect(recovered.audit.filter(row => row.action === 'provider-credential.revoked')).toHaveLength(1); for (const row of failed.audit) expect(recovered.audit).toContainEqual(row);
			expect(await f.custody()).toEqual(custody); within(f);
		} finally { await f.close(); }
	});
	it('actual authenticated membership leave settles only unstarted pending authority once retains both predecessor results and denies all old bearer polling', async () => {
		const f = await dependencyRevocation(); try {
			const original = await f.repository.get('team', f.attempt.id); expect(original?.status).toBe('pending'); expect(original?.leaseToken).toBeNull();
			expect(original?.claimedAt).toBeNull(); expect(original?.runnerId).toBeNull();
			const before = await f.revocationState(), response = await f.leave(); expect(response.status).toBe(200); await pendingCancellation(f);
			const after = await f.revocationState(); expect(after.memberships.find(row => row.id === 'membership')?.status).toBe('revoked'); expect(after.credentials.every(row => row.status === 'revoked')).toBe(true);
			expect(after.tokens.every(row => row.status === 'revoked')).toBe(true); expect(after.audit.filter(row => row.action === 'provider-membership.revoked')).toHaveLength(1);
			await f.authenticator.leaveMembership(f.authenticated.principal, f.leaveKey); expect(await f.revocationState()).toEqual(after);
			expect((await f.leave()).status).toBe(401); expect((await f.request(f.requestBody, { token: f.token })).status).toBe(401); expect(await f.revocationState()).toEqual(after);
			for (const old of before.financial.capacity_provider_assignments.filter(row => row.id !== f.attempt.id)) expect(after.financial.capacity_provider_assignments).toContainEqual(old);
			expect(after.accounts).toEqual(before.accounts); expect(after.sessions).toEqual(before.sessions); expect(after.edges).toEqual(before.edges);
			for (const old of before.audit) expect(after.audit).toContainEqual(old); within(f);
		} finally { await f.close(); }
	});
	it('membership leave token interruption retains committed revoked membership and rolls back credential token batch before same frozen owning input recovery closes pending work once', async () => {
		const f = await dependencyRevocation(); try {
			expect((await f.repository.get('team', f.attempt.id))?.status).toBe('pending'); const before = await f.revocationState();
			await f.db.exec(`CREATE FUNCTION interrupt_leave_token() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
				IF NEW.status='revoked' THEN RAISE EXCEPTION 'leave token interruption'; END IF; RETURN NEW; END $$;
				CREATE TRIGGER interrupt_leave_token BEFORE UPDATE ON capacity_provider_access_tokens FOR EACH ROW EXECUTE FUNCTION interrupt_leave_token();`);
			expect((await f.leave()).status).toBe(500); const failed = await f.revocationState(); expect(failed.memberships.find(row => row.id === 'membership')?.status).toBe('revoked');
			expect({ ...failed, memberships: before.memberships }).toEqual(before);
			await f.db.exec('DROP TRIGGER interrupt_leave_token ON capacity_provider_access_tokens; DROP FUNCTION interrupt_leave_token();');
			expect((await f.leave()).status).toBe(401); expect(await f.revocationState()).toEqual(failed);
			// Recovery tests the original owning service with the ORIGINAL actually
			// authenticated frozen input. NOT renewed bearer auth/public recovery.
			await f.authenticator.leaveMembership(f.authenticated.principal, f.leaveKey); await pendingCancellation(f); const recovered = await f.revocationState();
			expect(recovered.credentials.every(row => row.status === 'revoked')).toBe(true); expect(recovered.tokens.every(row => row.status === 'revoked')).toBe(true);
			expect(recovered.audit.filter(row => row.action === 'provider-membership.revoked')).toHaveLength(1); for (const row of failed.audit) expect(recovered.audit).toContainEqual(row);
			await f.authenticator.leaveMembership(f.authenticated.principal, f.leaveKey); expect(await f.revocationState()).toEqual(recovered); within(f);
		} finally { await f.close(); }
	});
});
