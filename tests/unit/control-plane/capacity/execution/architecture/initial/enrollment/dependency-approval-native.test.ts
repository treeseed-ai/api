import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256 } from '../../../../../../../../src/api/capacity/security.ts';
import { CapacityGovernanceError } from '../../../../../../../../src/api/capacity/database.ts';
import { dependencyRegistration } from './dependency-registration-fixture.ts';

type Fixture = Awaited<ReturnType<typeof dependencyRegistration>>;
async function registered(f: Fixture) {
	expect((await f.evaluate()).eligible).toBe(true); const response = await f.register(); expect(response.status).toBe(200); const value: unknown = await response.json();
	if (!value || typeof value !== 'object' || !('data' in value)) throw new Error('Original public registration data missing');
	return CONTROL_PLANE_OPERATIONS.providers.register.schema.output.parse(value.data);
}
function within(f: Fixture) { expect(Date.now()).toBeLessThanOrEqual(Date.parse(f.attempt.deadline)); }

// Public signed registration is genuine; approval below is the ORIGINAL owning
// service/SQL with a supplied actor, NOT authenticated operator HTTP or governance.
describe('real owning registration approval and original SQL', () => {
	it('original approval denies missing foreign rejected and cancelled genuine registration requests preserving all terminal history and enrollment authority', async () => {
		for (const test of ['missing', 'foreign', 'rejected', 'cancelled'] as const) {
			const f = await dependencyRegistration(); try {
				const pending = await registered(f), registeredState = await f.registrationState(), custody = await f.custody(); let team = 'team', request = pending.id;
				if (test === 'missing') request = 'absent-registered-request';
				if (test === 'foreign') { await f.query(`INSERT INTO teams (id,slug,name,created_at,updated_at) VALUES ('foreign-approval-team','foreign-approval-team','Supplied foreign team input',?,?)`, [f.now, f.now]); team = 'foreign-approval-team'; }
				if (test === 'rejected') { const rejected = await f.authenticator.reject('team', pending.id, 'supplied-operator', ' genuine rejection reason ', 'original-reject'); expect(rejected).toMatchObject({ id: pending.id, status: 'rejected', rejectionReason: 'genuine rejection reason', membershipId: null }); }
				if (test === 'cancelled') { const cancelled = await f.authenticator.cancel('team', pending.id, 'supplied-operator', 'original-cancel'); expect(cancelled).toMatchObject({ id: pending.id, status: 'cancelled', membershipId: null }); }
				const before = await f.registrationState(), input = { team, request, actor: 'supplied-operator', key: `denied-${test}-approval`, alias: 'renamed-provider' }, original = structuredClone(input);
				if (test === 'rejected' || test === 'cancelled') {
					const action = test === 'rejected' ? 'reject' : 'cancel', key = test === 'rejected' ? 'original-reject' : 'original-cancel';
					expect(before.requests.find(row => row.id === pending.id)).toMatchObject({ status: test, membership_id: null, transition_action: action, transition_idempotency_key: key });
					expect(before.audit).toHaveLength(registeredState.audit.length + 1); expect(before.audit.filter(row => row.resource_id === pending.id && row.action === `provider-registration.${test}`)).toHaveLength(1);
					for (const row of registeredState.audit) expect(before.audit).toContainEqual(row); for (const row of registeredState.requests.filter(row => row.id !== pending.id)) expect(before.requests).toContainEqual(row);
					expect({ ...before, requests: registeredState.requests, audit: registeredState.audit }).toEqual(registeredState);
				}
				let error: unknown; try { await f.authenticator.approve(input.team, input.request, input.actor, input.key, input.alias); } catch (caught) { error = caught; }
				expect(error).toBeInstanceOf(CapacityGovernanceError); expect(error).toMatchObject({ status: test === 'missing' || test === 'foreign' ? 404 : 409, code: test === 'missing' || test === 'foreign' ? 'provider_registration_not_found' : 'provider_registration_not_pending' });
				expect(await f.registrationState()).toEqual(before); expect(await f.custody()).toEqual(custody); expect(input).toEqual(original); within(f);
				if (test === 'rejected' || test === 'cancelled') {
					const key = test === 'rejected' ? 'original-reject' : 'original-cancel', result = test === 'rejected' ? await f.authenticator.reject('team', pending.id, 'supplied-operator', 'genuine rejection reason', key) : await f.authenticator.cancel('team', pending.id, 'supplied-operator', key);
					expect(result).toMatchObject({ id: pending.id, status: test, membershipId: null }); expect(await f.registrationState()).toEqual(before); within(f);
				}
			} finally { await f.close(); }
		}
	});
	it('original approval expires a supplied elapsed genuine request without enrollment or audit and repeated denial retains exactly the original expiry transition', async () => {
		const f = await dependencyRegistration(); try {
			const pending = await registered(f), custody = await f.custody(), expiresAt = new Date().toISOString();
			// Only a fresh request expiry INPUT is changed. No fake API clock, wait,
			// productive deadline extension, or claim of natural seven-day expiry.
			await f.query('UPDATE capacity_provider_registration_requests SET expires_at=? WHERE id=?', [expiresAt, pending.id]);
			const before = await f.registrationState(), original = before.requests.find(row => row.id === pending.id); expect(original).toBeDefined();
			const started = Date.now(); let error: unknown; try { await f.authenticator.approve('team', pending.id, 'supplied-operator', 'elapsed-approval', 'renamed-provider'); } catch (caught) { error = caught; }
			const received = Date.now(); expect(error).toBeInstanceOf(CapacityGovernanceError); expect(error).toMatchObject({ status: 409, code: 'provider_registration_not_pending' });
			const after = await f.registrationState(), expired = after.requests.find(row => row.id === pending.id); expect(expired).toEqual({ ...original, status: 'expired', updated_at: expired?.updated_at });
			expect(typeof expired?.updated_at).toBe('string'); expect(Date.parse(String(expired?.updated_at))).toBeGreaterThanOrEqual(started); expect(Date.parse(String(expired?.updated_at))).toBeLessThanOrEqual(received); expect(Date.parse(expiresAt)).toBeLessThanOrEqual(started);
			expect(after.requests).toHaveLength(before.requests.length); for (const row of before.requests.filter(row => row.id !== pending.id)) expect(after.requests).toContainEqual(row);
			expect({ ...after, requests: before.requests }).toEqual(before); expect(await f.custody()).toEqual(custody); within(f);
			for (const key of ['elapsed-approval', 'another-elapsed-approval']) {
				let repeat: unknown; try { await f.authenticator.approve('team', pending.id, 'supplied-operator', key, 'renamed-provider'); } catch (caught) { repeat = caught; }
				expect(repeat).toBeInstanceOf(CapacityGovernanceError); expect(repeat).toMatchObject({ status: 409, code: 'provider_registration_not_pending' }); expect(await f.registrationState()).toEqual(after); expect(await f.custody()).toEqual(custody); within(f);
			}
		} finally { await f.close(); }
	});
	it('competing original approve reject and cancel operations have one durable winner audit and immutable enrollment across distinct and reused review keys', async () => {
		for (const action of ['reject', 'cancel'] as const) for (const shared of [false, true]) {
			const f = await dependencyRegistration(); try {
				const pending = await registered(f), before = await f.registrationState(), custody = await f.custody(), approveKey = 'competing-approve', otherKey = shared ? approveKey : `competing-${action}`, actor = 'supplied-operator', alias = 'renamed-provider', reason = 'competing review reason';
				const calls = [f.authenticator.approve('team', pending.id, actor, approveKey, alias), action === 'reject' ? f.authenticator.reject('team', pending.id, actor, reason, otherKey) : f.authenticator.cancel('team', pending.id, actor, otherKey)];
				const outcomes = await Promise.allSettled(calls); expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1);
				const winnerIndex = outcomes.findIndex(result => result.status === 'fulfilled'), winner = outcomes[winnerIndex]; if (!winner || winner.status !== 'fulfilled' || !winner.value) throw new Error('Original competing review winner missing');
				const value = CONTROL_PLANE_OPERATIONS.providers.register.schema.output.parse(winner.value), winningAction = winnerIndex === 0 ? 'approve' : action, key = winnerIndex === 0 ? approveKey : otherKey;
				const status = winningAction === 'approve' ? 'approved' : winningAction === 'reject' ? 'rejected' : 'cancelled'; expect(value).toMatchObject({ id: pending.id, teamId: pending.teamId, providerId: pending.providerId, status });
				const loser = outcomes[1 - winnerIndex]; if (!loser || loser.status !== 'rejected') throw new Error('Original competing review denial missing'); const cause: unknown = loser.reason; expect(cause).toBeInstanceOf(CapacityGovernanceError); if (!(cause instanceof CapacityGovernanceError)) throw new Error('Original competing review governance cause missing'); expect(cause.status).toBe(409);
				expect(shared ? ['provider_registration_not_pending', 'provider_registration_state_conflict', 'idempotency_key_conflict'] : ['provider_registration_not_pending', 'provider_registration_state_conflict']).toContain(cause.code);
				const after = await f.registrationState(), old = before.requests.find(row => row.id === pending.id); expect(old).toBeDefined(); expect(after.requests).toHaveLength(before.requests.length);
				const digest = sha256(canonicalJson(winningAction === 'approve' ? { action: 'approve', teamAlias: alias } : winningAction === 'reject' ? { action: 'reject', reason } : { action: 'cancel' }));
				expect(after.requests.find(row => row.id === pending.id)).toEqual({ ...old, status, reviewed_at: winningAction === 'cancel' ? old?.reviewed_at : value.reviewedAt, reviewed_by_id: winningAction === 'cancel' ? old?.reviewed_by_id : actor, rejection_reason: winningAction === 'reject' ? reason : old?.rejection_reason, membership_id: winningAction === 'approve' ? value.membershipId : old?.membership_id, updated_at: value.updatedAt, transition_action: winningAction, transition_idempotency_key: key, transition_request_digest: digest });
				for (const row of before.requests.filter(row => row.id !== pending.id)) expect(after.requests).toContainEqual(row);
				expect(after.memberships).toHaveLength(before.memberships.length + (winningAction === 'approve' ? 1 : 0)); expect(after.authorizations).toHaveLength(before.authorizations.length + (winningAction === 'approve' ? 1 : 0));
				if (winningAction === 'approve') {
					expect(value.membershipId).toBeTruthy(); expect(after.memberships.filter(row => row.id === value.membershipId)).toHaveLength(1); expect(after.memberships.find(row => row.id === value.membershipId)).toMatchObject({ team_id: pending.teamId, capacity_provider_id: pending.providerId, status: 'approved', team_alias: alias, approved_by_id: actor });
					expect(after.authorizations.filter(row => row.membership_id === value.membershipId)).toHaveLength(1); expect(after.authorizations.find(row => row.membership_id === value.membershipId)).toMatchObject({ team_id: pending.teamId, capacity_provider_id: pending.providerId, generation: 1, status: 'pending', idempotency_key: `approval:${pending.id}` });
				} else { expect(value.membershipId).toBeNull(); expect(after.memberships).toEqual(before.memberships); expect(after.authorizations).toEqual(before.authorizations); }
				expect(after.audit).toHaveLength(before.audit.length + 1); expect(after.audit.filter(row => row.resource_id === pending.id && row.action !== 'provider-registration.requested')).toHaveLength(1);
				expect(after.audit.find(row => row.resource_id === pending.id && row.action === `provider-registration.${status}`)).toMatchObject({ team_id: pending.teamId, capacity_provider_id: pending.providerId, actor_id: actor, idempotency_key: key });
				for (const field of ['memberships', 'authorizations', 'audit'] as const) for (const row of before[field]) expect(after[field]).toContainEqual(row);
				expect({ ...after, requests: before.requests, memberships: before.memberships, authorizations: before.authorizations, audit: before.audit }).toEqual(before);
				const replay = winningAction === 'approve' ? await f.authenticator.approve('team', pending.id, actor, key, alias) : winningAction === 'reject' ? await f.authenticator.reject('team', pending.id, actor, reason, key) : await f.authenticator.cancel('team', pending.id, actor, key);
				expect(replay).toEqual(value); expect(await f.registrationState()).toEqual(after); expect(await f.custody()).toEqual(custody); within(f);
			} finally { await f.close(); }
		}
	});
	it('original approval of a genuinely registered identity creates exactly one membership and pending credential authorization with exact replay and changed alias conflict', async () => {
		const f = await dependencyRegistration(); try {
			const pending = await registered(f), before = await f.registrationState(), custody = await f.custody(), input = { team: 'team', request: pending.id, actor: 'supplied-operator', key: 'original-approval', alias: 'renamed-provider' }, original = structuredClone(input);
			const started = Date.now(), approved = CONTROL_PLANE_OPERATIONS.providers.requests.approve.schema.output.parse(await f.authenticator.approve(input.team, input.request, input.actor, input.key, input.alias)), received = Date.now(); within(f);
			expect(approved).toEqual({ ...pending, status: 'approved', reviewedAt: approved.reviewedAt, reviewedById: input.actor, membershipId: approved.membershipId, updatedAt: approved.updatedAt });
			expect(typeof approved.membershipId).toBe('string'); expect(approved.membershipId).toBeTruthy(); expect(typeof approved.reviewedAt).toBe('string');
			expect(Date.parse(String(approved.reviewedAt))).toBeGreaterThanOrEqual(started); expect(Date.parse(String(approved.reviewedAt))).toBeLessThanOrEqual(received);
			const after = await f.registrationState(); expect(after.requests).toHaveLength(before.requests.length); const old = before.requests.find(row => row.id === pending.id), current = after.requests.find(row => row.id === pending.id); expect(old).toBeDefined();
			expect(current).toEqual({ ...old, status: 'approved', reviewed_at: approved.reviewedAt, reviewed_by_id: input.actor, membership_id: approved.membershipId, updated_at: approved.updatedAt,
				transition_action: 'approve', transition_idempotency_key: input.key, transition_request_digest: sha256(canonicalJson({ action: 'approve', teamAlias: input.alias })) });
			expect(after.memberships).toHaveLength(before.memberships.length + 1); expect(after.memberships.find(row => row.id === approved.membershipId)).toMatchObject({ team_id: input.team, capacity_provider_id: pending.providerId, status: 'approved', team_alias: input.alias, approved_by_id: input.actor, approved_at: approved.reviewedAt });
			expect(after.authorizations).toHaveLength(before.authorizations.length + 1); expect(after.authorizations.filter(row => row.membership_id === approved.membershipId)).toHaveLength(1);
			expect(after.authorizations.find(row => row.membership_id === approved.membershipId)).toMatchObject({ team_id: input.team, capacity_provider_id: pending.providerId, generation: 1, idempotency_key: `approval:${pending.id}`, status: 'pending', created_by_type: 'team-principal', created_by_id: input.actor });
			expect(after.audit).toHaveLength(before.audit.length + 1); const audits = after.audit.filter(row => row.action === 'provider-registration.approved' && row.resource_id === pending.id); expect(audits).toHaveLength(1);
			expect(audits[0]).toMatchObject({ team_id: input.team, capacity_provider_id: pending.providerId, membership_id: approved.membershipId, actor_type: 'team-principal', actor_id: input.actor, idempotency_key: input.key, metadata_json: canonicalJson({ membershipOnly: true }) });
			for (const key of ['memberships', 'authorizations', 'audit'] as const) for (const row of before[key]) expect(after[key]).toContainEqual(row);
			expect({ ...after, requests: before.requests, memberships: before.memberships, authorizations: before.authorizations, audit: before.audit }).toEqual(before);
			expect(await f.authenticator.approve(input.team, input.request, input.actor, input.key, input.alias)).toEqual(approved); expect(await f.registrationState()).toEqual(after);
			await expect(f.authenticator.approve(input.team, input.request, input.actor, input.key, 'changed-alias')).rejects.toMatchObject({ status: 409, code: 'idempotency_key_conflict' }); expect(await f.registrationState()).toEqual(after);
			expect(input).toEqual(original); expect(await f.custody()).toEqual(custody); within(f);
		} finally { await f.close(); }
	});
	it('concurrent same key original approvals return one immutable membership authorization and audit without duplicate enrollment or financial mutation', async () => {
		const f = await dependencyRegistration(); try {
			const pending = await registered(f), before = await f.registrationState(), custody = await f.custody(), input = { team: 'team', request: pending.id, actor: 'supplied-operator', key: 'concurrent-approval', alias: 'renamed-provider' }, original = structuredClone(input);
			const [first, second] = await Promise.all([f.authenticator.approve(input.team, input.request, input.actor, input.key, input.alias), f.authenticator.approve(input.team, input.request, input.actor, input.key, input.alias)]); expect(second).toEqual(first);
			expect(first).toMatchObject({ id: pending.id, teamId: input.team, providerId: pending.providerId, status: 'approved', reviewedById: input.actor }); expect(first.membershipId).toBeTruthy();
			const after = await f.registrationState(); expect(after.requests).toHaveLength(before.requests.length); expect(after.memberships).toHaveLength(before.memberships.length + 1); expect(after.authorizations).toHaveLength(before.authorizations.length + 1); expect(after.audit).toHaveLength(before.audit.length + 1);
			expect(after.memberships.filter(row => row.id === first.membershipId && row.capacity_provider_id === pending.providerId && row.team_id === input.team)).toHaveLength(1);
			expect(after.authorizations.filter(row => row.membership_id === first.membershipId && row.status === 'pending' && row.generation === 1)).toHaveLength(1);
			expect(after.audit.filter(row => row.action === 'provider-registration.approved' && row.resource_id === pending.id && row.idempotency_key === input.key)).toHaveLength(1);
			for (const key of ['memberships', 'authorizations', 'audit'] as const) for (const row of before[key]) expect(after[key]).toContainEqual(row);
			expect({ ...after, requests: before.requests, memberships: before.memberships, authorizations: before.authorizations, audit: before.audit }).toEqual(before);
			expect(await f.authenticator.approve(input.team, input.request, input.actor, input.key, input.alias)).toEqual(first); expect(await f.registrationState()).toEqual(after);
			expect(input).toEqual(original); expect(await f.custody()).toEqual(custody); within(f);
		} finally { await f.close(); }
	});
	it('native membership insertion failure rolls back the original approval request membership authorization transaction before same facts retry creates one enrollment', async () => {
		const f = await dependencyRegistration(); try {
			const pending = await registered(f), before = await f.registrationState(), custody = await f.custody(), key = 'approval-transaction-recovery';
			await f.db.exec(`CREATE FUNCTION interrupt_approval_member() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'original approval member insertion interrupted'; END $$;
				CREATE TRIGGER interrupt_approval_member BEFORE INSERT ON capacity_provider_team_memberships FOR EACH ROW EXECUTE FUNCTION interrupt_approval_member();`);
			let error: unknown; try { await f.authenticator.approve('team', pending.id, 'supplied-operator', key, 'renamed-provider'); } catch (caught) { error = caught; }
			expect(error).toMatchObject({ code: 'P0001', message: 'original approval member insertion interrupted' }); expect(await f.registrationState()).toEqual(before); expect(await f.custody()).toEqual(custody); within(f);
			await f.db.exec('DROP TRIGGER interrupt_approval_member ON capacity_provider_team_memberships; DROP FUNCTION interrupt_approval_member();');
			const approved = await f.authenticator.approve('team', pending.id, 'supplied-operator', key, 'renamed-provider'), after = await f.registrationState(); expect(approved.status).toBe('approved'); expect(approved.membershipId).toBeTruthy();
			expect(after.requests.find(row => row.id === pending.id)).toMatchObject({ status: 'approved', membership_id: approved.membershipId, transition_idempotency_key: key });
			expect(after.memberships).toHaveLength(before.memberships.length + 1); expect(after.authorizations).toHaveLength(before.authorizations.length + 1); expect(after.audit).toHaveLength(before.audit.length + 1);
			expect(after.memberships.filter(row => row.id === approved.membershipId && row.capacity_provider_id === pending.providerId)).toHaveLength(1); expect(after.authorizations.filter(row => row.membership_id === approved.membershipId && row.status === 'pending' && row.generation === 1)).toHaveLength(1);
			expect(after.audit.filter(row => row.action === 'provider-registration.approved' && row.resource_id === pending.id)).toHaveLength(1);
			for (const field of ['memberships', 'authorizations', 'audit'] as const) for (const row of before[field]) expect(after[field]).toContainEqual(row);
			expect({ ...after, requests: before.requests, memberships: before.memberships, authorizations: before.authorizations, audit: before.audit }).toEqual(before);
			expect(await f.authenticator.approve('team', pending.id, 'supplied-operator', key, 'renamed-provider')).toEqual(approved); expect(await f.registrationState()).toEqual(after); expect(await f.custody()).toEqual(custody); within(f);
		} finally { await f.close(); }
	});
	it('native late approval audit failure retains committed membership and pending authorization before exact same key retry recovers one missing audit without rewriting failed history', async () => {
		const f = await dependencyRegistration(); try {
			const pending = await registered(f), before = await f.registrationState(), custody = await f.custody(), key = 'approval-audit-recovery';
			await f.db.exec(`CREATE FUNCTION interrupt_approval_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
				IF NEW.action='provider-registration.approved' THEN RAISE EXCEPTION 'original approval audit interrupted'; END IF; RETURN NEW; END $$;
				CREATE TRIGGER interrupt_approval_audit BEFORE INSERT ON capacity_audit_events FOR EACH ROW EXECUTE FUNCTION interrupt_approval_audit();`);
			let error: unknown; try { await f.authenticator.approve('team', pending.id, 'supplied-operator', key, 'renamed-provider'); } catch (caught) { error = caught; }
			expect(error).toMatchObject({ code: 'P0001', message: 'original approval audit interrupted' }); const failed = await f.registrationState(), request = failed.requests.find(row => row.id === pending.id); expect(request).toMatchObject({ status: 'approved', transition_idempotency_key: key });
			expect(failed.memberships).toHaveLength(before.memberships.length + 1); expect(failed.authorizations).toHaveLength(before.authorizations.length + 1); expect(failed.audit).toEqual(before.audit);
			expect(failed.memberships.filter(row => row.id === request?.membership_id && row.capacity_provider_id === pending.providerId)).toHaveLength(1);
			expect(failed.authorizations.filter(row => row.membership_id === request?.membership_id && row.status === 'pending' && row.generation === 1)).toHaveLength(1);
			for (const field of ['memberships', 'authorizations'] as const) for (const row of before[field]) expect(failed[field]).toContainEqual(row);
			expect({ ...failed, requests: before.requests, memberships: before.memberships, authorizations: before.authorizations }).toEqual(before); expect(await f.custody()).toEqual(custody); within(f);
			await f.db.exec('DROP TRIGGER interrupt_approval_audit ON capacity_audit_events; DROP FUNCTION interrupt_approval_audit();');
			const approved = await f.authenticator.approve('team', pending.id, 'supplied-operator', key, 'renamed-provider'), after = await f.registrationState(); expect(approved).toMatchObject({ id: pending.id, status: 'approved', membershipId: request?.membership_id });
			expect(after.audit).toHaveLength(failed.audit.length + 1); expect(after.audit.filter(row => row.action === 'provider-registration.approved' && row.resource_id === pending.id && row.idempotency_key === key)).toHaveLength(1);
			for (const row of failed.audit) expect(after.audit).toContainEqual(row); expect({ ...after, audit: failed.audit }).toEqual(failed);
			expect(await f.authenticator.approve('team', pending.id, 'supplied-operator', key, 'renamed-provider')).toEqual(approved); expect(await f.registrationState()).toEqual(after); expect(await f.custody()).toEqual(custody); within(f);
		} finally { await f.close(); }
	});
});
