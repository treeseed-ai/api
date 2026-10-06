import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { generateKeyPair } from 'jose';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { canonicalJson, sha256 } from '../../../../../../../../src/api/capacity/security.ts';
import { encodeConfirmation } from '../../../../../../../../src/api/control-plane/confirmation/confirmation-service.ts';
import { dependencyOperator } from './dependency-operator-fixture.ts';
import { eventObserved } from '../../../../../realtime/architecture/session-postgres-fixture.ts';

// REAL owning current resource HTTP + JWT verification + independent native
// PostgreSQL authorization/approval/read-back. NOT external issuer issuance,
// browser enrollment, live team governance, provider dispatch, or Settlement.
const record = z.record(z.string(), z.unknown());
const rows = (state: Record<string, unknown[]>, table: string) => {
	expect(state).toHaveProperty(table); return state[table]!.map(value => record.parse(value));
};
function unchangedExcept(before: Record<string, unknown[]>, after: Record<string, unknown[]>, tables: string[]) {
	expect(Object.keys(after)).toEqual(Object.keys(before));
	for (const table of Object.keys(before)) if (!tables.includes(table)) expect(after[table], table).toEqual(before[table]);
}
function additions(before: Record<string, unknown[]>, after: Record<string, unknown[]>, table: string, count: number) {
	const previous = rows(before, table), current = rows(after, table); expect(current).toHaveLength(previous.length + count);
	for (const value of previous) expect(current).toContainEqual(value);
	return current.filter(value => !previous.some(old => JSON.stringify(old) === JSON.stringify(value)));
}
async function denial(response: Response, status: number, code: string) {
	expect(response.status).toBe(status); const payload: unknown = await response.json(); expect(payload).toMatchObject({ status, code });
	expect(JSON.stringify(payload)).not.toContain('IdentityAuthenticationError');
}

function rejectionReadback(before: Record<string, unknown[]>, after: Record<string, unknown[]>, id: string, reason: string, key: string, started: string, received: string) {
	const old = rows(before, 'capacity_provider_registration_requests'), current = rows(after, 'capacity_provider_registration_requests'); expect(current).toHaveLength(old.length);
	const previous = old.find(row => row.id === id), rejected = current.find(row => row.id === id); expect(previous).toBeDefined(); expect(rejected).toBeDefined();
	const reviewedAt = z.string().parse(rejected?.reviewed_at), updatedAt = z.string().parse(rejected?.updated_at);
	expect(reviewedAt >= started && reviewedAt <= received && updatedAt >= started && updatedAt <= received).toBe(true);
	expect(rejected).toEqual({ ...previous, status: 'rejected', reviewed_at: reviewedAt, reviewed_by_id: 'mapped-operator', rejection_reason: reason.trim(), updated_at: updatedAt, transition_action: 'reject', transition_idempotency_key: key, transition_request_digest: sha256(canonicalJson({ action: 'reject', reason: reason.trim() })) });
	for (const row of old) if (row.id !== id) expect(current).toContainEqual(row);
	return rejected;
}

function confirmationReadback(before: Record<string, unknown[]>, after: Record<string, unknown[]>, confirmation: Parameters<typeof encodeConfirmation>[0], started: string, received: string) {
	const row = additions(before, after, 'operation_confirmation_nonces', 1)[0]!, consumedAt = z.string().parse(row.consumed_at);
	expect(row).toEqual({ nonce: confirmation.nonce, principal_id: 'mapped-operator', client_id: 'renamed-client', operation_id: confirmation.operationId, arguments_digest: confirmation.argumentsDigest, expires_at: confirmation.expiresAt, consumed_at: consumedAt });
	expect(consumedAt >= started && consumedAt <= received).toBe(true);
}

function rejectionAudit(row: Record<string, unknown>, providerId: string, requestId: string, key: string, reason: string, started: string, received: string) {
	const id = z.string().min(1).parse(row.id), createdAt = z.string().parse(row.created_at);
	expect(row).toEqual({ id, team_id: 'team', capacity_provider_id: providerId, membership_id: null, actor_type: 'team-principal', actor_id: 'mapped-operator', action: 'provider-registration.rejected', resource_type: 'provider-registration-request', resource_id: requestId, request_id: requestId, idempotency_key: key, before_fingerprint: null, after_fingerprint: null, metadata_json: canonicalJson({ reason: reason.trim() }), created_at: createdAt });
	expect(createdAt >= started && createdAt <= received).toBe(true);
}

it('current authenticated PostgreSQL review waits for native team policy and denies approval or rejection after membership revocation without a terminal transition', async () => {
	for (const action of ['approve', 'reject'] as const) {
		const f = await dependencyOperator(); let holder: PoolClient | undefined, original: Promise<Response> | undefined, settled = false;
		try {
			const registered = await f.register(), rest = CONTROL_PLANE_OPERATIONS.providers.requests[action].descriptor.rest; assert.ok(rest); expect(rest.method).toBe('POST');
			const path = rest.path.replace('{teamId}', 'team').replace('{requestId}', registered.request.id), body = action === 'approve' ? { teamAlias: 'revocation-race-provider' } : { reason: 'Revoked operator cannot reject' }, key = `native-policy-revocation-${action}`;
			const inputs = structuredClone({ body, payload: registered.inputs.payload, registration: registered.inputs.body });
			const within = () => { assert.ok(Date.now() < Date.parse(registered.inputs.payload.expiresAt), 'Original three-second registration proof elapsed'); expect({ body, payload: registered.inputs.payload, registration: registered.inputs.body }).toEqual(inputs); };
			within(); const before = await f.state(); expect(await f.state(f.right)).toEqual(before);
			const confirmation = await f.challenge(path, registered.credential, body, key); expect(await f.state()).toEqual(before); within();
			const membership = rows(before, 'team_memberships').find(row => row.id === 'operator-team-membership'); assert.ok(membership); expect(membership.status).toBe('active');
			const relation = await f.right.pool.query<{ oid: number }>("SELECT oid::int AS oid FROM pg_class WHERE oid='public.team_memberships'::regclass"); expect(relation.rows).toHaveLength(1); const oid = relation.rows[0]!.oid;
			holder = await f.right.pool.connect(); const identity = await holder.query<{ name: string; pid: number }>('SELECT current_database() AS name, pg_backend_pid() AS pid'); expect(identity.rows).toHaveLength(1);
			const holderPid = identity.rows[0]!.pid; expect(identity.rows[0]!.name).toBe(f.name); assert.ok(Number.isSafeInteger(holderPid) && holderPid > 0);
			await holder.query('BEGIN'); await holder.query('LOCK TABLE public.team_memberships IN ACCESS EXCLUSIVE MODE');
			const started = new Date().toISOString(); original = f.post(path, registered.credential, body, key, encodeConfirmation(confirmation)); void original.then(() => { settled = true; }, () => { settled = true; });
			const policyQuery = "SELECT * FROM team_memberships WHERE team_id = $1 AND user_id = $2 AND status = 'active' LIMIT 1";
			let policyPid: number | undefined;
			await eventObserved(async () => {
				within(); if (settled) { const response = await original!; throw new Error(`Original review settled before native policy barrier: ${response.status}`); }
				const waiting = await f.right.pool.query<{ pid: number; blockers: number[] }>("SELECT pid,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname=$1 AND backend_type='client backend' AND wait_event_type='Lock' AND query=$2", [f.name, policyQuery]);
				if (waiting.rows.length === 0) return false; expect(waiting.rows).toHaveLength(1); const row = waiting.rows[0]!; assert.ok(Number.isSafeInteger(row.pid) && row.pid > 0 && row.pid !== holderPid); expect(row.blockers).toEqual([holderPid]); policyPid = row.pid; return true;
			});
			const locks = await f.right.pool.query<{ pid: number; mode: string; granted: boolean }>('SELECT pid,mode,granted FROM pg_locks WHERE database=(SELECT oid FROM pg_database WHERE datname=$1) AND relation=$2 AND pid=ANY($3::int[]) ORDER BY pid,mode', [f.name, oid, [holderPid, policyPid]]);
			expect(locks.rows).toHaveLength(2); expect(locks.rows).toContainEqual({ pid: holderPid, mode: 'AccessExclusiveLock', granted: true }); expect(locks.rows).toContainEqual({ pid: policyPid, mode: 'AccessShareLock', granted: false }); expect(settled).toBe(false);
			// This read-back uses the allocated holder ONLY for its locked table.
			// Other tables are read independently through both owning pools; full
			// independent team-table read-back is required before and after the lock.
			const blockedState = async (database: typeof f.left) => {
				const tables = await database.pool.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"); expect(tables.rows.map(row => row.tablename)).toEqual(Object.keys(before));
				const state: Record<string, unknown[]> = {};
				for (const { tablename } of tables.rows) {
					const sql = `SELECT to_jsonb(t) AS value FROM "${tablename.replaceAll('"', '""')}" t`;
					const values = tablename === 'team_memberships' ? await holder!.query<{ value: unknown }>(sql) : await database.pool.query<{ value: unknown }>(sql);
					state[tablename] = values.rows.map(row => row.value).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
				} return state;
			};
			const blocked = await blockedState(f.left), observed = new Date().toISOString(); unchangedExcept(before, blocked, ['operation_confirmation_nonces']); confirmationReadback(before, blocked, confirmation, started, observed); expect(await blockedState(f.right)).toEqual(blocked); within(); expect(settled).toBe(false);
			// Native revocation is a deliberately changed authority INPUT in this
			// fresh test DB, NOT public administrative governance or enrollment.
			const changed = await holder.query<{ value: unknown }>("UPDATE team_memberships SET status='revoked' WHERE id=$1 AND team_id=$2 AND user_id=$3 AND status='active' RETURNING to_jsonb(team_memberships) AS value", ['operator-team-membership', 'team', 'mapped-operator']);
			expect(changed.rows).toEqual([{ value: { ...membership, status: 'revoked' } }]); within();
			await holder.query('COMMIT'); holder.release(); holder = undefined;
			await denial(await original, 403, 'provider_team_management_denied'); within();
			const expected = structuredClone(blocked); expected.team_memberships = expected.team_memberships!.map(value => { const row = record.parse(value); return row.id === membership.id ? { ...row, status: 'revoked' } : value; }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
			const denied = await f.state(); expect(denied).toEqual(expected); expect(await f.state(f.right)).toEqual(denied);
			expect((await f.right.pool.query('SELECT pid,mode,granted FROM pg_locks WHERE database=(SELECT oid FROM pg_database WHERE datname=$1) AND relation=$2 AND pid=ANY($3::int[])', [f.name, oid, [holderPid, policyPid]])).rows).toEqual([]); within();
			await denial(await f.post(path, registered.credential, body, key, encodeConfirmation(confirmation)), 409, 'confirmation_invalid'); expect(await f.state()).toEqual(denied); within();
			const fresh = await f.challenge(path, registered.credential, body, key); expect(fresh.nonce).not.toBe(confirmation.nonce); expect(await f.state()).toEqual(denied);
			const retryStarted = new Date().toISOString(); await denial(await f.post(path, registered.credential, body, key, encodeConfirmation(fresh)), 403, 'provider_team_management_denied'); const retryReceived = new Date().toISOString(), retried = await f.state();
			unchangedExcept(denied, retried, ['operation_confirmation_nonces']); confirmationReadback(denied, retried, fresh, retryStarted, retryReceived); expect(await f.state(f.right)).toEqual(retried); within();
		} finally {
			try { if (holder) { try { await holder.query('ROLLBACK'); } finally { holder.release(); holder = undefined; } } if (original) { await eventObserved(() => settled); await Promise.allSettled([original]); } }
			finally { await f.close(); }
		}
	}
});

it('current authenticated PostgreSQL identical rejection races share one terminal result only for the bound key with one audit and no enrollment or unbound replay', async () => {
	for (const sameKey of [true, false]) {
		const f = await dependencyOperator(); let holder: PoolClient | undefined; const pending: Promise<Response>[] = [], settled: boolean[] = [];
		const stillPending = async () => { for (let index = 0; index < settled.length; index++) if (settled[index]) { const response = await pending[index]!; throw new Error(`Original identical rejection response ${index} completed before native barrier release with status ${response.status}`); } };
		try {
			const registered = await f.register(), path = CONTROL_PLANE_OPERATIONS.providers.requests.reject.descriptor.rest.path.replace('{teamId}', 'team').replace('{requestId}', registered.request.id), body = { reason: '  Identical native rejection reason  ' }, competingBody = structuredClone(body), key = 'native-identical-rejection', competingKey = sameKey ? key : 'native-distinct-identical-rejection';
			const original = structuredClone({ body, competingBody, payload: registered.inputs.payload, registration: registered.inputs.body }), within = () => { assert.ok(Date.now() < Date.parse(registered.inputs.payload.expiresAt), 'Original registration expiry elapsed during identical rejection race'); expect({ body, competingBody, payload: registered.inputs.payload, registration: registered.inputs.body }).toEqual(original); };
			const before = await f.state(); expect(await f.state(f.right)).toEqual(before); within();
			const confirmation = await f.challenge(path, registered.credential, body, key), competingConfirmation = await f.challenge(path, registered.credential, competingBody, competingKey); expect(confirmation.nonce).not.toBe(competingConfirmation.nonce); expect(confirmation.argumentsDigest).toBe(competingConfirmation.argumentsDigest); expect(await f.state()).toEqual(before); within();
			// Original row-lock ownership, not simultaneous promise scheduling.
			// The only test barrier is in this fixture's allocated fresh database.
			await f.left.pool.query('CREATE FUNCTION operator_identical_rejection_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(403,251); RETURN NEW; END $$');
			await f.left.pool.query("CREATE TRIGGER operator_identical_rejection_barrier BEFORE UPDATE ON capacity_provider_registration_requests FOR EACH ROW WHEN (OLD.status='pending' AND NEW.status='rejected') EXECUTE FUNCTION operator_identical_rejection_barrier()");
			holder = await f.right.pool.connect(); const owned = await holder.query<{ name: string; pid: number }>('SELECT current_database() AS name, pg_backend_pid() AS pid'); expect(owned.rows).toHaveLength(1); const held = owned.rows[0]!; expect(held.name).toBe(f.name); expect(Number.isSafeInteger(held.pid) && held.pid > 0).toBe(true);
			await holder.query('BEGIN'); await holder.query('SELECT pg_advisory_xact_lock(403,251)'); within();
			const start = new Date().toISOString(), firstRequest = f.post(path, registered.credential, body, key, encodeConfirmation(confirmation)); pending.push(firstRequest); settled.push(false); void firstRequest.then(() => { settled[0] = true; }, () => { settled[0] = true; });
			let first: { pid: number; blockers: number[] } | undefined;
			await eventObserved(async () => { within(); await stillPending(); const blocked = (await f.right.pool.query<{ pid: number; blockers: number[] }>("SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend' AND wait_event_type='Lock' AND query LIKE $1", ["%UPDATE capacity_provider_registration_requests SET status = 'rejected'%"])).rows; first = blocked.find(row => row.blockers.includes(held.pid)); return blocked.length === 1 && Boolean(first); });
			assert.ok(first); const firstPid = first.pid; expect(Number.isSafeInteger(firstPid) && firstPid > 0 && firstPid !== held.pid).toBe(true); expect(first.blockers).toEqual([held.pid]); expect(settled).toEqual([false]);
			const firstBlocked = await f.state(); unchangedExcept(before, firstBlocked, ['operation_confirmation_nonces']); confirmationReadback(before, firstBlocked, confirmation, start, new Date().toISOString()); expect(await f.state(f.right)).toEqual(firstBlocked); within();
			const competingStart = new Date().toISOString(), secondRequest = f.post(path, registered.credential, competingBody, competingKey, encodeConfirmation(competingConfirmation)); pending.push(secondRequest); settled.push(false); void secondRequest.then(() => { settled[1] = true; }, () => { settled[1] = true; });
			let overlap: Array<{ pid: number; blockers: number[] }> = [];
			await eventObserved(async () => { within(); await stillPending(); overlap = (await f.right.pool.query<{ pid: number; blockers: number[] }>("SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend' AND wait_event_type='Lock' AND query LIKE $1 ORDER BY pid", ["%UPDATE capacity_provider_registration_requests SET status = 'rejected'%"])).rows; return overlap.length === 2 && overlap.some(row => row.pid === firstPid && row.blockers.includes(held.pid)) && overlap.some(row => row.pid !== firstPid && row.blockers.includes(firstPid)); });
			const second = overlap.find(row => row.pid !== firstPid)!; expect(Number.isSafeInteger(second.pid) && second.pid > 0 && second.pid !== held.pid).toBe(true); expect(second.blockers).toEqual([firstPid]); expect(overlap.find(row => row.pid === firstPid)!.blockers).toEqual([held.pid]); expect(settled).toEqual([false, false]);
			const blocked = await f.state(); unchangedExcept(firstBlocked, blocked, ['operation_confirmation_nonces']); confirmationReadback(firstBlocked, blocked, competingConfirmation, competingStart, new Date().toISOString()); expect(await f.state(f.right)).toEqual(blocked); within();
			await holder.query('ROLLBACK'); holder.release(); holder = undefined;
			const responses = await Promise.all(pending), received = new Date().toISOString(); expect(responses[0]!.status).toBe(200); const envelope = z.object({ data: record }).parse(await responses[0]!.json());
			if (sameKey) { expect(responses[1]!.status).toBe(200); expect(await responses[1]!.json()).toEqual(envelope); } else await denial(responses[1]!, 409, 'provider_registration_state_conflict');
			const after = await f.state(); unchangedExcept(blocked, after, ['capacity_provider_registration_requests', 'capacity_audit_events']); const saved = rejectionReadback(blocked, after, registered.request.id, body.reason, key, start, received);
			expect(envelope.data).toMatchObject({ id: registered.request.id, teamId: 'team', providerId: registered.request.providerId, status: 'rejected', reviewedById: 'mapped-operator', reviewedAt: saved?.reviewed_at, updatedAt: saved?.updated_at, rejectionReason: body.reason.trim(), membershipId: null }); rejectionAudit(additions(blocked, after, 'capacity_audit_events', 1)[0]!, registered.request.providerId, registered.request.id, key, body.reason, start, received); expect(await f.state(f.right)).toEqual(after); within();
			expect((await f.right.pool.query("SELECT pid FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid=403 AND objid=251 AND objsubid=2")).rows).toEqual([]);
			await f.left.pool.query('DROP TRIGGER operator_identical_rejection_barrier ON capacity_provider_registration_requests'); await f.left.pool.query('DROP FUNCTION operator_identical_rejection_barrier()'); expect((await f.right.pool.query("SELECT tgname FROM pg_trigger WHERE tgname='operator_identical_rejection_barrier' AND NOT tgisinternal")).rows).toEqual([]); expect((await f.right.pool.query("SELECT proname FROM pg_proc WHERE proname='operator_identical_rejection_barrier' AND pronamespace='public'::regnamespace")).rows).toEqual([]);
			await denial(await f.post(path, registered.credential, body, key, encodeConfirmation(confirmation)), 409, 'confirmation_invalid'); await denial(await f.post(path, registered.credential, competingBody, competingKey, encodeConfirmation(competingConfirmation)), 409, 'confirmation_invalid'); expect(await f.state()).toEqual(after); within();
			const fresh = await f.challenge(path, registered.credential, body, key); expect(await f.state()).toEqual(after); const replayStart = new Date().toISOString(), replay = await f.post(path, registered.credential, body, key, encodeConfirmation(fresh)), replayReceived = new Date().toISOString(); expect(replay.status).toBe(200); expect(await replay.json()).toEqual(envelope);
			const replayed = await f.state(); unchangedExcept(after, replayed, ['operation_confirmation_nonces']); confirmationReadback(after, replayed, fresh, replayStart, replayReceived); expect(await f.state(f.right)).toEqual(replayed); within();
			const unboundKey = 'fresh-unbound-terminal-rejection', unbound = await f.challenge(path, registered.credential, competingBody, unboundKey); expect(await f.state()).toEqual(replayed); const deniedStart = new Date().toISOString(), denied = await f.post(path, registered.credential, competingBody, unboundKey, encodeConfirmation(unbound)), deniedReceived = new Date().toISOString(); await denial(denied, 409, 'provider_registration_not_pending');
			const final = await f.state(); unchangedExcept(replayed, final, ['operation_confirmation_nonces']); confirmationReadback(replayed, final, unbound, deniedStart, deniedReceived); expect(await f.state(f.right)).toEqual(final); within();
		} finally {
			try { if (holder) await holder.query('ROLLBACK'); await eventObserved(() => settled.every(Boolean)); await Promise.allSettled(pending); }
			finally { try { holder?.release(); } finally { await f.close(); } }
		}
	}
});

it('current authenticated PostgreSQL approval wins natively blocked rejection and changed alias races with exact enrollment digest audit and immutable confirmed replay', async () => {
	for (const competitor of ['distinct-rejection', 'reused-rejection', 'changed-approval'] as const) {
		const f = await dependencyOperator(); let holder: PoolClient | undefined; const pending: Promise<Response>[] = [], settled: boolean[] = [];
		const stillPending = async () => { for (let index = 0; index < settled.length; index++) if (settled[index]) { const response = await pending[index]!; throw new Error(`Original approval race response ${index} completed before native barrier release with status ${response.status}`); } };
		try {
			const registered = await f.register(), path = registered.approvalPath, body = { teamAlias: 'Native winning enrollment' }, changedApproval = competitor === 'changed-approval', competingBody: Record<string, unknown> = changedApproval ? { teamAlias: 'Changed losing enrollment' } : { reason: 'Forbidden losing rejection' }, key = 'native-winning-approval', reusedKey = competitor !== 'distinct-rejection', competingKey = reusedKey ? key : 'native-losing-rejection', competingPath = changedApproval ? path : CONTROL_PLANE_OPERATIONS.providers.requests.reject.descriptor.rest.path.replace('{teamId}', 'team').replace('{requestId}', registered.request.id);
			const original = structuredClone({ body, competingBody, payload: registered.inputs.payload, registration: registered.inputs.body }), within = () => { assert.ok(Date.now() < Date.parse(registered.inputs.payload.expiresAt), 'Original registration expiry elapsed during native approval race'); expect({ body, competingBody, payload: registered.inputs.payload, registration: registered.inputs.body }).toEqual(original); };
			const before = await f.state(); expect(await f.state(f.right)).toEqual(before); within();
			const confirmation = await f.challenge(path, registered.credential, body, key), competingConfirmation = await f.challenge(competingPath, registered.credential, competingBody, competingKey); expect(confirmation.nonce).not.toBe(competingConfirmation.nonce); expect(confirmation.argumentsDigest).not.toBe(competingConfirmation.argumentsDigest); expect(await f.state()).toEqual(before); within();
			// Only this fresh owning database; native approval holds its request
			// row lock while waiting for the allocated transaction holder.
			await f.left.pool.query('CREATE FUNCTION operator_approval_race_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(401,249); RETURN NEW; END $$');
			await f.left.pool.query("CREATE TRIGGER operator_approval_race_barrier BEFORE UPDATE ON capacity_provider_registration_requests FOR EACH ROW WHEN (OLD.status='pending' AND NEW.status='approved') EXECUTE FUNCTION operator_approval_race_barrier()");
			holder = await f.right.pool.connect(); const owned = await holder.query<{ name: string; pid: number }>('SELECT current_database() AS name, pg_backend_pid() AS pid'); expect(owned.rows).toHaveLength(1); const held = owned.rows[0]!; expect(held.name).toBe(f.name); expect(Number.isSafeInteger(held.pid) && held.pid > 0).toBe(true);
			await holder.query('BEGIN'); await holder.query('SELECT pg_advisory_xact_lock(401,249)'); within();
			const start = new Date().toISOString(), approval = f.post(path, registered.credential, body, key, encodeConfirmation(confirmation)); pending.push(approval); settled.push(false); void approval.then(() => { settled[0] = true; }, () => { settled[0] = true; });
			let first: { pid: number; blockers: number[] } | undefined;
			await eventObserved(async () => { within(); await stillPending(); const blocked = (await f.right.pool.query<{ pid: number; blockers: number[] }>("SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend' AND wait_event_type='Lock' AND query LIKE $1", ["%UPDATE capacity_provider_registration_requests SET status = 'approved'%"])).rows; first = blocked.find(row => row.blockers.includes(held.pid)); return blocked.length === 1 && Boolean(first); });
			assert.ok(first); const approvalPid = first.pid; expect(Number.isSafeInteger(approvalPid) && approvalPid > 0 && approvalPid !== held.pid).toBe(true); expect(first.blockers).toEqual([held.pid]); expect(settled).toEqual([false]);
			const firstBlocked = await f.state(); unchangedExcept(before, firstBlocked, ['operation_confirmation_nonces']); confirmationReadback(before, firstBlocked, confirmation, start, new Date().toISOString()); expect(await f.state(f.right)).toEqual(firstBlocked); within();
			const competingStarted = new Date().toISOString(), competing = f.post(competingPath, registered.credential, competingBody, competingKey, encodeConfirmation(competingConfirmation)); pending.push(competing); settled.push(false); void competing.then(() => { settled[1] = true; }, () => { settled[1] = true; });
			let overlap: Array<{ pid: number; blockers: number[]; query: string }> = [];
			await eventObserved(async () => { within(); await stillPending(); overlap = (await f.right.pool.query<{ pid: number; blockers: number[]; query: string }>("SELECT pid, pg_blocking_pids(pid) AS blockers, query FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend' AND wait_event_type='Lock' AND query LIKE $1 ORDER BY pid", ['%UPDATE capacity_provider_registration_requests SET status =%'])).rows; return overlap.length === 2 && overlap.some(row => row.pid === approvalPid && row.blockers.includes(held.pid)) && overlap.some(row => row.pid !== approvalPid && row.query.includes(changedApproval ? "status = 'approved'" : "status = 'rejected'") && row.blockers.includes(approvalPid)); });
			const losing = overlap.find(row => row.pid !== approvalPid)!; expect(Number.isSafeInteger(losing.pid) && losing.pid > 0 && losing.pid !== held.pid).toBe(true); expect(losing.blockers).toEqual([approvalPid]); expect(overlap.find(row => row.pid === approvalPid)!.blockers).toEqual([held.pid]); expect(settled).toEqual([false, false]);
			const blocked = await f.state(); unchangedExcept(firstBlocked, blocked, ['operation_confirmation_nonces']); confirmationReadback(firstBlocked, blocked, competingConfirmation, competingStarted, new Date().toISOString()); expect(await f.state(f.right)).toEqual(blocked); within();
			await holder.query('ROLLBACK'); holder.release(); holder = undefined;
			const responses = await Promise.all(pending), received = new Date().toISOString(); expect(responses[0]!.status).toBe(200); const result = z.object({ data: record }).parse(await responses[0]!.json()).data; await denial(responses[1]!, 409, 'provider_registration_state_conflict');
			const after = await f.state(); unchangedExcept(blocked, after, ['capacity_provider_registration_requests', 'capacity_provider_team_memberships', 'capacity_provider_credential_issuance_authorizations', 'capacity_audit_events']);
			const oldRequests = rows(blocked, 'capacity_provider_registration_requests'), requests = rows(after, 'capacity_provider_registration_requests'), previous = oldRequests.find(row => row.id === registered.request.id), saved = requests.find(row => row.id === registered.request.id); expect(previous).toBeDefined(); expect(saved).toBeDefined(); expect(requests).toHaveLength(oldRequests.length);
			const memberId = z.string().min(1).parse(saved?.membership_id), reviewedAt = z.string().parse(saved?.reviewed_at), updatedAt = z.string().parse(saved?.updated_at); expect(reviewedAt >= start && reviewedAt <= received && updatedAt >= start && updatedAt <= received).toBe(true);
			expect(saved).toEqual({ ...previous, status: 'approved', reviewed_at: reviewedAt, reviewed_by_id: 'mapped-operator', membership_id: memberId, transition_action: 'approve', transition_idempotency_key: key, transition_request_digest: sha256(canonicalJson({ action: 'approve', teamAlias: body.teamAlias })), updated_at: updatedAt }); for (const row of oldRequests) if (row.id !== registered.request.id) expect(requests).toContainEqual(row);
			expect(result).toMatchObject({ id: registered.request.id, teamId: 'team', providerId: registered.request.providerId, status: 'approved', reviewedById: 'mapped-operator', reviewedAt, updatedAt, rejectionReason: null, membershipId: memberId });
			const member = additions(blocked, after, 'capacity_provider_team_memberships', 1)[0]!;
			expect(member).toEqual({ id: memberId, team_id: 'team', capacity_provider_id: registered.request.providerId, status: 'approved', team_alias: body.teamAlias, approved_at: reviewedAt, approved_by_id: 'mapped-operator', suspended_at: null, revoked_at: null, revoked_by_id: null, status_idempotency_key: null, status_request_digest: null, metadata_json: '{}', created_at: reviewedAt, updated_at: reviewedAt });
			const authorization = additions(blocked, after, 'capacity_provider_credential_issuance_authorizations', 1)[0]!, authorizationId = z.string().min(1).parse(authorization.id); expect(authorizationId).not.toBe(memberId);
			expect(authorization).toEqual({ id: authorizationId, membership_id: memberId, team_id: 'team', capacity_provider_id: registered.request.providerId, generation: 1, idempotency_key: `approval:${registered.request.id}`, status: 'pending', issued_credential_id: null, created_by_type: 'team-principal', created_by_id: 'mapped-operator', created_at: reviewedAt, updated_at: reviewedAt });
			const audit = additions(blocked, after, 'capacity_audit_events', 1)[0]!, auditId = z.string().min(1).parse(audit.id);
			expect(audit).toEqual({ id: auditId, team_id: 'team', capacity_provider_id: registered.request.providerId, membership_id: memberId, actor_type: 'team-principal', actor_id: 'mapped-operator', action: 'provider-registration.approved', resource_type: 'provider-registration-request', resource_id: registered.request.id, request_id: registered.request.id, idempotency_key: key, before_fingerprint: null, after_fingerprint: null, metadata_json: canonicalJson({ membershipOnly: true }), created_at: reviewedAt }); expect(await f.state(f.right)).toEqual(after); within();
			expect((await f.right.pool.query("SELECT pid FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid=401 AND objid=249 AND objsubid=2")).rows).toEqual([]);
			await f.left.pool.query('DROP TRIGGER operator_approval_race_barrier ON capacity_provider_registration_requests'); await f.left.pool.query('DROP FUNCTION operator_approval_race_barrier()'); expect((await f.right.pool.query("SELECT tgname FROM pg_trigger WHERE tgname='operator_approval_race_barrier' AND NOT tgisinternal")).rows).toEqual([]); expect((await f.right.pool.query("SELECT proname FROM pg_proc WHERE proname='operator_approval_race_barrier' AND pronamespace='public'::regnamespace")).rows).toEqual([]);
			await denial(await f.post(path, registered.credential, body, key, encodeConfirmation(confirmation)), 409, 'confirmation_invalid'); await denial(await f.post(competingPath, registered.credential, competingBody, competingKey, encodeConfirmation(competingConfirmation)), 409, 'confirmation_invalid'); expect(await f.state()).toEqual(after); within();
			const fresh = await f.challenge(path, registered.credential, body, key); expect(await f.state()).toEqual(after); const replayStart = new Date().toISOString(), replay = await f.post(path, registered.credential, body, key, encodeConfirmation(fresh)), replayReceived = new Date().toISOString(); expect(replay.status).toBe(200); expect(await replay.json()).toEqual({ data: result });
			const replayed = await f.state(); unchangedExcept(after, replayed, ['operation_confirmation_nonces']); confirmationReadback(after, replayed, fresh, replayStart, replayReceived); expect(await f.state(f.right)).toEqual(replayed); within();
			const retry = await f.challenge(competingPath, registered.credential, competingBody, competingKey); expect(await f.state()).toEqual(replayed); const retryStart = new Date().toISOString(), retryResponse = await f.post(competingPath, registered.credential, competingBody, competingKey, encodeConfirmation(retry)), retryReceived = new Date().toISOString(); await denial(retryResponse, 409, reusedKey ? 'idempotency_key_conflict' : 'provider_registration_not_pending');
			const final = await f.state(); unchangedExcept(replayed, final, ['operation_confirmation_nonces']); confirmationReadback(replayed, final, retry, retryStart, retryReceived); expect(await f.state(f.right)).toEqual(final); within();
		} finally {
			try { if (holder) await holder.query('ROLLBACK'); await eventObserved(() => settled.every(Boolean)); await Promise.allSettled(pending); }
			finally { try { holder?.release(); } finally { await f.close(); } }
		}
	}
});

it('current authenticated PostgreSQL rejection wins natively blocked competing approval and changed reason races with exact key digest custody one audit no enrollment residue and immutable confirmed replay', async () => {
	for (const competitor of ['distinct-approval', 'reused-approval', 'changed-rejection'] as const) {
		const f = await dependencyOperator(); let holder: PoolClient | undefined; const pending: Promise<Response>[] = [], settled: boolean[] = [];
		const stillPending = async () => { for (let index = 0; index < settled.length; index++) if (settled[index]) { const response = await pending[index]!; throw new Error(`Original review response ${index} completed before native barrier release with status ${response.status}`); } };
		try {
			const registered = await f.register(), path = CONTROL_PLANE_OPERATIONS.providers.requests.reject.descriptor.rest.path.replace('{teamId}', 'team').replace('{requestId}', registered.request.id), body = { reason: '  Native winning rejection  ' }, changedRejection = competitor === 'changed-rejection', approval: Record<string, unknown> = changedRejection ? { reason: 'Changed competing rejection reason' } : { teamAlias: 'Forbidden losing enrollment' }, key = 'native-winning-rejection', reusedKey = competitor !== 'distinct-approval', approvalKey = reusedKey ? key : 'native-losing-approval', competingPath = changedRejection ? path : registered.approvalPath;
			const original = structuredClone({ body, approval, payload: registered.inputs.payload, registration: registered.inputs.body }), within = () => { assert.ok(Date.now() < Date.parse(registered.inputs.payload.expiresAt), 'Original registration expiry elapsed during native review race'); expect({ body, approval, payload: registered.inputs.payload, registration: registered.inputs.body }).toEqual(original); };
			const before = await f.state(); expect(await f.state(f.right)).toEqual(before); within();
			const rejectionConfirmation = await f.challenge(path, registered.credential, body, key), approvalConfirmation = await f.challenge(competingPath, registered.credential, approval, approvalKey); expect(rejectionConfirmation.nonce).not.toBe(approvalConfirmation.nonce); expect(rejectionConfirmation.argumentsDigest).not.toBe(approvalConfirmation.argumentsDigest); expect(await f.state()).toEqual(before); within();
			// ONLY the allocated fresh database: original rejection UPDATE owns
			// its row lock before this native transaction barrier is released.
			await f.left.pool.query('CREATE FUNCTION operator_review_race_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(399,247); RETURN NEW; END $$');
			await f.left.pool.query("CREATE TRIGGER operator_review_race_barrier BEFORE UPDATE ON capacity_provider_registration_requests FOR EACH ROW WHEN (OLD.status='pending' AND NEW.status='rejected') EXECUTE FUNCTION operator_review_race_barrier()");
			holder = await f.right.pool.connect(); const owned = await holder.query<{ name: string; pid: number }>('SELECT current_database() AS name, pg_backend_pid() AS pid'); expect(owned.rows).toHaveLength(1); const held = owned.rows[0]!; expect(held.name).toBe(f.name); expect(Number.isSafeInteger(held.pid) && held.pid > 0).toBe(true);
			await holder.query('BEGIN'); await holder.query('SELECT pg_advisory_xact_lock(399,247)'); within();
			const start = new Date().toISOString(), rejection = f.post(path, registered.credential, body, key, encodeConfirmation(rejectionConfirmation)); pending.push(rejection); settled.push(false); void rejection.then(() => { settled[0] = true; }, () => { settled[0] = true; });
			let first: { pid: number; blockers: number[] } | undefined;
			await eventObserved(async () => { within(); await stillPending(); const blocked = (await f.right.pool.query<{ pid: number; blockers: number[] }>("SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend' AND wait_event_type='Lock' AND query LIKE $1", ["%UPDATE capacity_provider_registration_requests SET status = 'rejected'%"])).rows; first = blocked.find(row => row.blockers.includes(held.pid)); return blocked.length === 1 && Boolean(first); });
			assert.ok(first); const rejectionPid = first.pid; expect(Number.isSafeInteger(rejectionPid) && rejectionPid > 0 && rejectionPid !== held.pid).toBe(true); expect(first.blockers).toEqual([held.pid]); expect(settled).toEqual([false]);
			const rejectionBlocked = await f.state(); unchangedExcept(before, rejectionBlocked, ['operation_confirmation_nonces']); confirmationReadback(before, rejectionBlocked, rejectionConfirmation, start, new Date().toISOString()); expect(await f.state(f.right)).toEqual(rejectionBlocked); within();
			const approvalStarted = new Date().toISOString(), approvalRequest = f.post(competingPath, registered.credential, approval, approvalKey, encodeConfirmation(approvalConfirmation)); pending.push(approvalRequest); settled.push(false); void approvalRequest.then(() => { settled[1] = true; }, () => { settled[1] = true; });
			let overlap: Array<{ pid: number; blockers: number[]; query: string }> = [];
			await eventObserved(async () => { within(); await stillPending(); overlap = (await f.right.pool.query<{ pid: number; blockers: number[]; query: string }>("SELECT pid, pg_blocking_pids(pid) AS blockers, query FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend' AND wait_event_type='Lock' AND query LIKE $1 ORDER BY pid", ['%UPDATE capacity_provider_registration_requests SET status =%'])).rows; return overlap.length === 2 && overlap.some(row => row.pid === rejectionPid && row.blockers.includes(held.pid)) && overlap.some(row => row.pid !== rejectionPid && row.query.includes(changedRejection ? "status = 'rejected'" : "status = 'approved'") && row.blockers.includes(rejectionPid)); });
			const losing = overlap.find(row => row.pid !== rejectionPid)!; expect(Number.isSafeInteger(losing.pid) && losing.pid > 0 && losing.pid !== held.pid).toBe(true); expect(losing.blockers).toEqual([rejectionPid]); expect(overlap.find(row => row.pid === rejectionPid)!.blockers).toEqual([held.pid]); expect(settled).toEqual([false, false]);
			const blocked = await f.state(); unchangedExcept(rejectionBlocked, blocked, ['operation_confirmation_nonces']); confirmationReadback(rejectionBlocked, blocked, approvalConfirmation, approvalStarted, new Date().toISOString()); expect(await f.state(f.right)).toEqual(blocked); within();
			await holder.query('ROLLBACK'); holder.release(); holder = undefined;
			const responses = await Promise.all(pending), received = new Date().toISOString(); expect(responses[0]!.status).toBe(200); const result = z.object({ data: record }).parse(await responses[0]!.json()).data; await denial(responses[1]!, 409, 'provider_registration_state_conflict');
			const after = await f.state(); unchangedExcept(blocked, after, ['capacity_provider_registration_requests', 'capacity_audit_events']); const saved = rejectionReadback(blocked, after, registered.request.id, body.reason, key, start, received);
			expect(result).toMatchObject({ id: registered.request.id, teamId: 'team', providerId: registered.request.providerId, status: 'rejected', reviewedById: 'mapped-operator', reviewedAt: saved?.reviewed_at, updatedAt: saved?.updated_at, rejectionReason: body.reason.trim(), membershipId: null }); rejectionAudit(additions(blocked, after, 'capacity_audit_events', 1)[0]!, registered.request.providerId, registered.request.id, key, body.reason, start, received); expect(await f.state(f.right)).toEqual(after); within();
			expect((await f.right.pool.query("SELECT pid FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid=399 AND objid=247 AND objsubid=2")).rows).toEqual([]);
			await f.left.pool.query('DROP TRIGGER operator_review_race_barrier ON capacity_provider_registration_requests'); await f.left.pool.query('DROP FUNCTION operator_review_race_barrier()'); expect((await f.right.pool.query("SELECT tgname FROM pg_trigger WHERE tgname='operator_review_race_barrier' AND NOT tgisinternal")).rows).toEqual([]); expect((await f.right.pool.query("SELECT proname FROM pg_proc WHERE proname='operator_review_race_barrier' AND pronamespace='public'::regnamespace")).rows).toEqual([]);
			await denial(await f.post(path, registered.credential, body, key, encodeConfirmation(rejectionConfirmation)), 409, 'confirmation_invalid'); await denial(await f.post(competingPath, registered.credential, approval, approvalKey, encodeConfirmation(approvalConfirmation)), 409, 'confirmation_invalid'); expect(await f.state()).toEqual(after); within();
			const fresh = await f.challenge(path, registered.credential, body, key); expect(await f.state()).toEqual(after); const replayStart = new Date().toISOString(), replay = await f.post(path, registered.credential, body, key, encodeConfirmation(fresh)), replayReceived = new Date().toISOString(); expect(replay.status).toBe(200); expect(await replay.json()).toEqual({ data: result });
			const replayed = await f.state(); unchangedExcept(after, replayed, ['operation_confirmation_nonces']); confirmationReadback(after, replayed, fresh, replayStart, replayReceived); expect(await f.state(f.right)).toEqual(replayed); within();
			const retry = await f.challenge(competingPath, registered.credential, approval, approvalKey); expect(await f.state()).toEqual(replayed); const retryStart = new Date().toISOString(), retryResponse = await f.post(competingPath, registered.credential, approval, approvalKey, encodeConfirmation(retry)), retryReceived = new Date().toISOString(); await denial(retryResponse, 409, reusedKey ? 'idempotency_key_conflict' : 'provider_registration_not_pending');
			const final = await f.state(); unchangedExcept(replayed, final, ['operation_confirmation_nonces']); confirmationReadback(replayed, final, retry, retryStart, retryReceived); expect(await f.state(f.right)).toEqual(final); within();
		} finally {
			try { if (holder) await holder.query('ROLLBACK'); await eventObserved(() => settled.every(Boolean)); await Promise.allSettled(pending); }
			finally { try { holder?.release(); } finally { await f.close(); } }
		}
	}
});

it('current authenticated PostgreSQL rejection commits only exact terminal review audit and confirmation then refuses changed authority and approval while preserving immutable replay', async () => {
	const f = await dependencyOperator();
	try {
		const registered = await f.register(), path = CONTROL_PLANE_OPERATIONS.providers.requests.reject.descriptor.rest.path.replace('{teamId}', 'team').replace('{requestId}', registered.request.id), body = { reason: '  Native controlled rejection evidence  ' }, key = 'authenticated-rejection';
		const original = structuredClone({ body, payload: registered.inputs.payload, registration: registered.inputs.body }), within = () => { expect(Date.now() < Date.parse(registered.inputs.payload.expiresAt)).toBe(true); expect({ body, payload: registered.inputs.payload, registration: registered.inputs.body }).toEqual(original); };
		const before = await f.state(); expect(await f.state(f.right)).toEqual(before); within();
		await denial(await f.post(path, await f.token({ scope: 'treeseed:read' }), body, key), 403, 'oauth_scope_insufficient'); expect(await f.state()).toEqual(before);
		const confirmation = await f.challenge(path, registered.credential, body, key); expect(confirmation.operationId).toBe('providers.requests.reject'); expect(await f.state()).toEqual(before);
		await denial(await f.post(path, registered.credential, { reason: 'Changed confirmation-bound input' }, key, encodeConfirmation(confirmation)), 409, 'confirmation_invalid'); expect(await f.state()).toEqual(before);
		const started = new Date().toISOString(), response = await f.post(path, registered.credential, body, key, encodeConfirmation(confirmation)), received = new Date().toISOString();
		expect(response.status).toBe(200); const result = z.object({ data: record }).parse(await response.json()).data;
		expect(result).toMatchObject({ id: registered.request.id, teamId: 'team', providerId: registered.request.providerId, status: 'rejected', reviewedById: 'mapped-operator', rejectionReason: body.reason.trim(), membershipId: null });
		const after = await f.state(); unchangedExcept(before, after, ['operation_confirmation_nonces', 'capacity_provider_registration_requests', 'capacity_audit_events']);
		const saved = rejectionReadback(before, after, registered.request.id, body.reason, key, started, received); expect(result.reviewedAt).toBe(saved?.reviewed_at); expect(result.updatedAt).toBe(saved?.updated_at);
		confirmationReadback(before, after, confirmation, started, received);
		rejectionAudit(additions(before, after, 'capacity_audit_events', 1)[0]!, registered.request.providerId, registered.request.id, key, body.reason, started, received); expect(await f.state(f.right)).toEqual(after); within();
		await denial(await f.post(path, registered.credential, body, key, encodeConfirmation(confirmation)), 409, 'confirmation_invalid'); expect(await f.state()).toEqual(after);
		const replayConfirmation = await f.challenge(path, registered.credential, body, key), replayStarted = new Date().toISOString(); const replay = await f.post(path, registered.credential, body, key, encodeConfirmation(replayConfirmation)), replayReceived = new Date().toISOString(); expect(replay.status).toBe(200); expect(await replay.json()).toEqual({ data: result });
		let stable = await f.state(); unchangedExcept(after, stable, ['operation_confirmation_nonces']); confirmationReadback(after, stable, replayConfirmation, replayStarted, replayReceived); expect(await f.state(f.right)).toEqual(stable); within();
		for (const denied of [
			{ path, body: { reason: 'Changed review reason' }, key, code: 'idempotency_key_conflict' },
			{ path: registered.approvalPath, body: { teamAlias: 'Forbidden post-rejection enrollment' }, key, code: 'idempotency_key_conflict' },
			{ path: registered.approvalPath, body: { teamAlias: 'Forbidden post-rejection enrollment' }, key: 'distinct-after-rejection', code: 'provider_registration_not_pending' },
		]) {
			const challenge = await f.challenge(denied.path, registered.credential, denied.body, denied.key); expect(await f.state()).toEqual(stable);
			const denialStarted = new Date().toISOString(), deniedResponse = await f.post(denied.path, registered.credential, denied.body, denied.key, encodeConfirmation(challenge)), denialReceived = new Date().toISOString(); await denial(deniedResponse, 409, denied.code);
			const next = await f.state(); unchangedExcept(stable, next, ['operation_confirmation_nonces']); confirmationReadback(stable, next, challenge, denialStarted, denialReceived); expect(await f.state(f.right)).toEqual(next); stable = next; within();
		}
	} finally { await f.close(); }
});

it('current authenticated PostgreSQL late rejection audit failure retains terminal request and consumed confirmation then exact fresh confirmation recovers one missing audit with no enrollment or history rewrite', async () => {
	const f = await dependencyOperator();
	try {
		const registered = await f.register(), path = CONTROL_PLANE_OPERATIONS.providers.requests.reject.descriptor.rest.path.replace('{teamId}', 'team').replace('{requestId}', registered.request.id), body = { reason: '  Native rejection audit recovery  ' }, key = 'authenticated-rejection-recovery';
		const original = structuredClone({ body, payload: registered.inputs.payload, registration: registered.inputs.body }), within = () => { expect(Date.now() < Date.parse(registered.inputs.payload.expiresAt)).toBe(true); expect({ body, payload: registered.inputs.payload, registration: registered.inputs.body }).toEqual(original); };
		const before = await f.state(); expect(await f.state(f.right)).toEqual(before); within();
		await f.left.pool.query("CREATE FUNCTION operator_rejection_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Controlled native rejection audit interruption' USING ERRCODE='P0001'; END $$");
		await f.left.pool.query("CREATE TRIGGER operator_rejection_audit_failure BEFORE INSERT ON capacity_audit_events FOR EACH ROW WHEN (NEW.action = 'provider-registration.rejected') EXECUTE FUNCTION operator_rejection_audit_failure()");
		const confirmation = await f.challenge(path, registered.credential, body, key); expect(await f.state()).toEqual(before);
		const started = new Date().toISOString(), failure = await f.post(path, registered.credential, body, key, encodeConfirmation(confirmation)), received = new Date().toISOString(); expect(failure.status).toBe(500);
		const failed = await f.state(); unchangedExcept(before, failed, ['capacity_provider_registration_requests', 'operation_confirmation_nonces']);
		const rejected = rejectionReadback(before, failed, registered.request.id, body.reason, key, started, received);
		confirmationReadback(before, failed, confirmation, started, received); expect(await f.state(f.right)).toEqual(failed); within();
		await f.left.pool.query('DROP TRIGGER operator_rejection_audit_failure ON capacity_audit_events'); await f.left.pool.query('DROP FUNCTION operator_rejection_audit_failure()');
		expect((await f.right.pool.query("SELECT tgname FROM pg_trigger WHERE tgname='operator_rejection_audit_failure' AND NOT tgisinternal")).rows).toEqual([]);
		expect((await f.right.pool.query("SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='operator_rejection_audit_failure'")).rows).toEqual([]);
		await denial(await f.post(path, registered.credential, body, key, encodeConfirmation(confirmation)), 409, 'confirmation_invalid'); expect(await f.state()).toEqual(failed);
		const fresh = await f.challenge(path, registered.credential, body, key); expect(await f.state()).toEqual(failed);
		const recoveryStarted = new Date().toISOString(), recovery = await f.post(path, registered.credential, body, key, encodeConfirmation(fresh)), recoveryReceived = new Date().toISOString(); expect(recovery.status).toBe(200); const result = z.object({ data: record }).parse(await recovery.json()).data;
		expect(result).toMatchObject({ id: registered.request.id, teamId: 'team', providerId: registered.request.providerId, status: 'rejected', reviewedById: 'mapped-operator', reviewedAt: rejected?.reviewed_at, updatedAt: rejected?.updated_at, rejectionReason: body.reason.trim(), membershipId: null });
		const recovered = await f.state(); unchangedExcept(failed, recovered, ['operation_confirmation_nonces', 'capacity_audit_events']);
		confirmationReadback(failed, recovered, fresh, recoveryStarted, recoveryReceived);
		const recoveredAudit = additions(failed, recovered, 'capacity_audit_events', 1)[0]!;
		expect(recoveredAudit.created_at).toBe(rejected?.reviewed_at);
		rejectionAudit(recoveredAudit, registered.request.providerId, registered.request.id, key, body.reason, started, received); expect(await f.state(f.right)).toEqual(recovered); within();
		const finalConfirmation = await f.challenge(path, registered.credential, body, key), replayStarted = new Date().toISOString(), replay = await f.post(path, registered.credential, body, key, encodeConfirmation(finalConfirmation)), replayReceived = new Date().toISOString(); expect(replay.status).toBe(200); expect(await replay.json()).toEqual({ data: result });
		const replayed = await f.state(); unchangedExcept(recovered, replayed, ['operation_confirmation_nonces']); confirmationReadback(recovered, replayed, finalConfirmation, replayStarted, replayReceived); expect(await f.state(f.right)).toEqual(replayed); within();
	} finally { await f.close(); }
});

it('current authenticated operator resource approval enrolls a genuinely signed registration once with original confirmation SQL and independent PostgreSQL readback', async () => {
	const f = await dependencyOperator();
	try {
		const registered = await f.register(), body = { teamAlias: 'renamed-native-provider' }, key = 'authenticated-approval', original = structuredClone(body), before = await f.state();
		expect(await f.state(f.right)).toEqual(before);
		const authenticated = await f.authenticate(registered.credential);
		expect(authenticated.principal).toMatchObject({ id: 'mapped-operator', roles: ['renamed-operator-role'], permissions: ['*:*:*'], scopes: ['treeseed:read', 'treeseed:admin'] });
		expect(authenticated.credential).toMatchObject({ type: 'access_token', id: 'mapped-operator', oauthClientId: 'renamed-client' }); expect(await f.state()).toEqual(before);
		const confirmation = await f.challenge(registered.approvalPath, registered.credential, body, key); expect(confirmation.operationId).toBe('providers.requests.approve'); expect(await f.state()).toEqual(before);
		const started = new Date().toISOString(), response = await f.post(registered.approvalPath, registered.credential, body, key, encodeConfirmation(confirmation)), received = new Date().toISOString();
		expect(response.status).toBe(200); const result = z.object({ data: z.object({ id: z.string(), teamId: z.string(), providerId: z.string(), status: z.literal('approved'), membershipId: z.string(), reviewedById: z.string() }) }).parse(await response.json());
		expect(result.data).toMatchObject({ id: registered.request.id, teamId: 'team', providerId: registered.request.providerId, reviewedById: 'mapped-operator' });
		const after = await f.state(); expect(await f.state(f.right)).toEqual(after);
		unchangedExcept(before, after, ['operation_confirmation_nonces', 'capacity_provider_registration_requests', 'capacity_provider_team_memberships', 'capacity_provider_credential_issuance_authorizations', 'capacity_audit_events']);
		const nonces = additions(before, after, 'operation_confirmation_nonces', 1); expect(nonces[0]).toMatchObject({ nonce: confirmation.nonce, principal_id: 'mapped-operator', client_id: 'renamed-client', operation_id: 'providers.requests.approve', arguments_digest: confirmation.argumentsDigest, expires_at: confirmation.expiresAt });
		expect(nonces[0]!.consumed_at).toBeTypeOf('string'); expect(String(nonces[0]!.consumed_at) >= started && String(nonces[0]!.consumed_at) <= received).toBe(true);
		const members = additions(before, after, 'capacity_provider_team_memberships', 1); expect(members[0]).toMatchObject({ id: result.data.membershipId, team_id: 'team', capacity_provider_id: registered.request.providerId, status: 'approved', team_alias: body.teamAlias, approved_by_id: 'mapped-operator' });
		const authorizations = additions(before, after, 'capacity_provider_credential_issuance_authorizations', 1); expect(authorizations[0]).toMatchObject({ team_id: 'team', membership_id: result.data.membershipId, capacity_provider_id: registered.request.providerId, generation: 1, status: 'pending', idempotency_key: `approval:${registered.request.id}`, created_by_type: 'team-principal', created_by_id: 'mapped-operator', issued_credential_id: null });
		const audits = additions(before, after, 'capacity_audit_events', 1); expect(audits[0]).toMatchObject({ action: 'provider-registration.approved', actor_type: 'team-principal', actor_id: 'mapped-operator', resource_id: registered.request.id, idempotency_key: key });
		const oldRequests = rows(before, 'capacity_provider_registration_requests'), requests = rows(after, 'capacity_provider_registration_requests'); expect(requests).toHaveLength(oldRequests.length);
		for (const request of oldRequests) if (request.id !== registered.request.id) expect(requests).toContainEqual(request);
		const saved = requests.find(value => value.id === registered.request.id)!; expect(saved).toMatchObject({ status: 'approved', reviewed_by_id: 'mapped-operator', membership_id: result.data.membershipId, transition_idempotency_key: key });
		for (const [column, value] of Object.entries(oldRequests.find(value => value.id === saved.id)!)) if (!['status', 'reviewed_at', 'reviewed_by_id', 'membership_id', 'updated_at', 'transition_action', 'transition_idempotency_key', 'transition_request_digest'].includes(column)) expect(saved[column], column).toEqual(value);
		await denial(await f.post(registered.approvalPath, registered.credential, body, key, encodeConfirmation(confirmation)), 409, 'confirmation_invalid'); expect(await f.state()).toEqual(after);
		const fresh = await f.challenge(registered.approvalPath, registered.credential, body, key); expect(await f.state()).toEqual(after);
		const replay = await f.post(registered.approvalPath, registered.credential, body, key, encodeConfirmation(fresh)); expect(replay.status).toBe(200); expect(await replay.json()).toMatchObject({ data: result.data });
		const replayed = await f.state(); unchangedExcept(after, replayed, ['operation_confirmation_nonces']); additions(after, replayed, 'operation_confirmation_nonces', 1); expect(await f.state(f.right)).toEqual(replayed); expect(body).toEqual(original);
	} finally { await f.close(); }
});

it('current operator resource authentication and local scope or team revocation deny approval without enrollment and retain the exact native confirmation footprint', async () => {
	const f = await dependencyOperator();
	try {
		const registered = await f.register(), body = { teamAlias: 'denied-native-provider' }, key = 'denied-authenticated-approval', before = await f.state(), foreign = await generateKeyPair('RS256');
		for (const options of [{ issuer: 'https://foreign.example' }, { audience: 'https://foreign-api.example' }, { key: foreign.privateKey }, { expiry: Math.floor(Date.now() / 1000) - 1 }, { subject: 'unmapped-subject' }]) {
			const response = await f.post(registered.approvalPath, await f.token(options), body, key); expect(response.status).toBe(401); expect(response.headers.get('www-authenticate')).toContain('oauth-protected-resource/mcp'); expect(await response.text()).not.toContain('IdentityAuthenticationError');
			expect(await f.state()).toEqual(before); expect(await f.state(f.right)).toEqual(before);
		}
		await denial(await f.post(registered.approvalPath, await f.token({ scope: 'treeseed:read' }), body, key), 403, 'oauth_scope_insufficient'); expect(await f.state()).toEqual(before);
		// Signed roles/permissions never restore revoked local grants.
		await f.left.pool.query("DELETE FROM user_role_bindings WHERE id='operator-binding'"); const revoked = await f.state();
		await denial(await f.post(registered.approvalPath, registered.credential, body, key), 403, 'oauth_scope_insufficient'); expect(await f.state()).toEqual(revoked);
		// Restore only this deliberately changed INPUT to isolate team policy.
		await f.left.pool.query("INSERT INTO user_role_bindings(id,user_id,role_id,created_at) SELECT 'operator-binding','mapped-operator',id,$1 FROM roles WHERE key='renamed-operator-role'", [rows(before, 'user_role_bindings').find(row => row.id === 'operator-binding')!.created_at]); expect(await f.state()).toEqual(before);
		const confirmation = await f.challenge(registered.approvalPath, registered.credential, body, key); expect(await f.state()).toEqual(before);
		await f.left.pool.query("UPDATE team_memberships SET status='revoked' WHERE id='operator-team-membership'"); const teamRevoked = await f.state();
		await denial(await f.post(registered.approvalPath, registered.credential, body, key, encodeConfirmation(confirmation)), 403, 'provider_team_management_denied');
		const denied = await f.state(); unchangedExcept(teamRevoked, denied, ['operation_confirmation_nonces']); const nonce = additions(teamRevoked, denied, 'operation_confirmation_nonces', 1);
		expect(nonce[0]).toMatchObject({ nonce: confirmation.nonce, principal_id: 'mapped-operator', client_id: 'renamed-client', operation_id: 'providers.requests.approve' }); expect(await f.state(f.right)).toEqual(denied);
		await denial(await f.post(registered.approvalPath, registered.credential, body, key, encodeConfirmation(confirmation)), 409, 'confirmation_invalid'); expect(await f.state()).toEqual(denied);
	} finally { await f.close(); }
});

it('current authenticated approval confirmation rejects changed arguments client signature and operation before native enrollment then admits only the unchanged original request', async () => {
	const f = await dependencyOperator();
	try {
		const registered = await f.register(), body = { teamAlias: 'confirmation-bound-provider' }, key = 'confirmation-bound-approval', before = await f.state();
		const confirmation = await f.challenge(registered.approvalPath, registered.credential, body, key), original = structuredClone({ body, confirmation }); expect(await f.state()).toEqual(before);
		const cases = [
			{ path: registered.approvalPath, credential: registered.credential, body: { ...body, teamAlias: 'changed-alias' }, state: confirmation },
			{ path: registered.approvalPath, credential: await f.token({ client: 'different-client' }), body, state: confirmation },
			{ path: registered.approvalPath, credential: registered.credential, body, state: { ...confirmation, signature: `${confirmation.signature[0] === 'A' ? 'B' : 'A'}${confirmation.signature.slice(1)}` } },
			{ path: registered.approvalPath.replace(/\/approve$/u, '/reject'), credential: registered.credential, body: { reason: 'Controlled competing operation input' }, state: confirmation },
		];
		for (const test of cases) {
			await denial(await f.post(test.path, test.credential, test.body, key, encodeConfirmation(test.state)), 409, 'confirmation_invalid'); expect(await f.state()).toEqual(before); expect(await f.state(f.right)).toEqual(before);
		}
		expect({ body, confirmation }).toEqual(original);
		const response = await f.post(registered.approvalPath, registered.credential, body, key, encodeConfirmation(confirmation)); expect(response.status).toBe(200);
		const after = await f.state(); unchangedExcept(before, after, ['operation_confirmation_nonces', 'capacity_provider_registration_requests', 'capacity_provider_team_memberships', 'capacity_provider_credential_issuance_authorizations', 'capacity_audit_events']);
		additions(before, after, 'operation_confirmation_nonces', 1); additions(before, after, 'capacity_provider_team_memberships', 1); additions(before, after, 'capacity_provider_credential_issuance_authorizations', 1); additions(before, after, 'capacity_audit_events', 1); expect(await f.state(f.right)).toEqual(after);
		await denial(await f.post(registered.approvalPath, registered.credential, body, key, encodeConfirmation(confirmation)), 409, 'confirmation_invalid'); expect(await f.state()).toEqual(after); expect({ body, confirmation }).toEqual(original);
	} finally { await f.close(); }
});
