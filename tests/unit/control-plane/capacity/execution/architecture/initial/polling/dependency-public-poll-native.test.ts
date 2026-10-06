import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { describe, expect, it } from 'vitest';
import { dependencyPublicPoll } from './dependency-public-poll-fixture.ts';

describe('real public provider poll HTTP and original SQL custody', () => {
	it('authenticated owning assignment reads and ordinary event writes deny a foreign membership without repairing native authority before unchanged exact retry', async () => {
		const f = await dependencyPublicPoll(); try {
			// Existing seeded credential is INPUT, not signed enrollment. Native
			// authentication still resolves the real hash, account and membership.
			await f.query("UPDATE capacity_provider_access_tokens SET scopes_json=? WHERE id='public-poll-token'",
				[JSON.stringify(['provider:assignments:read', 'provider:assignments:write'])]);
			expect(await f.authenticate()).toMatchObject({ principal: f.principal });
			const path = CONTROL_PLANE_OPERATIONS.providers.assignment.descriptor.rest?.path;
			const eventPath = CONTROL_PLANE_OPERATIONS.providers.createEvent.descriptor.rest?.path;
			if (!path || !eventPath) throw new Error('Original public assignment and event routes required');
			const read = () => f.request({}, { method: 'GET', path: path.replace('{assignmentId}', encodeURIComponent(f.attempt.id)) });
			const body = { id: 'membership-custody-event', eventType: 'provider.execution.started', component: 'provider-runner',
				status: 'active', message: 'Original ordinary observation.' }, held = structuredClone(body);
			const write = () => f.request(body, { path: eventPath.replace('{assignmentId}', encodeURIComponent(f.attempt.id)) });
			const baseline = await read(); expect(baseline.status).toBe(200); const exact = await baseline.json();
			const state = async () => ({ ...await f.state(), events: (await f.query('SELECT * FROM capacity_workday_events ORDER BY id')).rows });
			const original = await state();
			await f.query('UPDATE capacity_provider_assignments SET membership_id=? WHERE id=?', ['foreign-membership', f.attempt.id]);
			const denied = await state(), replies: Array<{ status: number; body: unknown }> = [];
			for (let retry = 0; retry < 2; retry++) {
				for (const operation of [read, write]) { const response = await operation(); replies.push({ status: response.status, body: await response.json() }); }
			}
			const after = await state();
			// Restore only the supplied row field; every denied response and state
			// observation stays retained, including a real pre-fix event write.
			await f.query('UPDATE capacity_provider_assignments SET membership_id=? WHERE id=?', [f.principal.membershipId, f.attempt.id]);
			expect(replies.map(reply => reply.status)).toEqual([403, 403, 403, 403]);
			for (const reply of replies) expect(JSON.stringify(reply.body)).toContain('provider_assignment_forbidden');
			expect(after).toEqual(denied); expect(await state()).toEqual(original); expect(body).toEqual(held);
			const retried = await read(); expect(retried.status).toBe(200); expect(await retried.json()).toEqual(exact);
			const concurrent = await Promise.all([read(), read()]);
			for (const response of concurrent) { expect(response.status).toBe(200); expect(await response.json()).toEqual(exact); }
			expect(await state()).toEqual(original);
			expect((await write()).status).toBe(200);
			const written = await state(); expect(written.events).toHaveLength(original.events.length + 1);
			// The owning event service also publishes one native session invalidation;
			// retain that real positive side effect rather than forbid publication.
			expect(written.sessionEvents).toHaveLength(original.sessionEvents.length + 1);
			for (const row of original.sessionEvents) expect(written.sessionEvents).toContainEqual(row);
			const notification = written.sessionEvents.find(row => !original.sessionEvents.some(previous => previous.sequence === row.sequence));
			expect(notification).toMatchObject({ team_id: f.principal.teamId, resource_id: f.attempt.workdayId, event_type: 'resource.invalidated' });
			expect(JSON.parse(String(notification?.payload_json))).toMatchObject({ workdayId: f.attempt.workdayId, eventId: `provider-runtime:${f.attempt.id}:${body.id}` });
			const { events: _events, sessionEvents: _sessionEvents, ...unchanged } = written;
			const { events: _originalEvents, sessionEvents: _originalSessionEvents, ...previous } = original;
			expect(unchanged).toEqual(previous); expect(body).toEqual(held);
			expect(Date.now()).toBeLessThan(Date.parse(f.attempt.deadline));
		} finally { await f.db.close(); }
	});
	it('authenticated native HTTP rejects the retired frozen signal route without SQL mutation before unchanged ordinary claim', async () => {
		const f = await dependencyPublicPoll(); try {
			expect(await f.authenticate()).toMatchObject({ principal: { teamId: f.principal.teamId, membershipId: f.principal.membershipId } });
			const input = { contractId: 'retired-frozen-contract', subjectGroupIds: ['retired-group'], payload: {} }, held = structuredClone(input);
			const before = await f.state(), statuses: number[] = [];
			for (let retry = 0; retry < 2; retry++) {
				statuses.push((await f.request(input, { path: `/v1/provider/assignments/${encodeURIComponent(f.attempt.id)}/signals` })).status);
				expect(await f.state()).toEqual(before); expect(input).toEqual(held);
			}
			expect(statuses).toEqual([404, 404]);
			expect(Date.now()).toBeLessThan(Date.parse(f.attempt.deadline));
			const response = await f.request(); expect(response.status).toBe(200);
			const envelope: unknown = await response.json();
			if (!envelope || typeof envelope !== 'object' || !('data' in envelope)) throw new Error('Original public data envelope missing');
			expect(CONTROL_PLANE_OPERATIONS.providers.nextAssignment.schema.output.parse(envelope.data)).toMatchObject({ assignment: { id: f.attempt.id, assignmentAttempt: f.attempt } });
		} finally { await f.db.close(); }
	});
	it('real token authentication and public catalog return the exact leased attempt with both predecessor results and no finance rewrite', async () => {
		const f = await dependencyPublicPoll(); try {
			const before = await f.custody(); const response = await f.request(); expect(response.status).toBe(200);
			const envelope: unknown = await response.json(); expect(envelope).toHaveProperty('data');
			if (!envelope || typeof envelope !== 'object' || !('data' in envelope)) throw new Error('Public data envelope missing');
			const result = CONTROL_PLANE_OPERATIONS.providers.nextAssignment.schema.output.parse(envelope.data);
			expect(result).toMatchObject({ assignment: { id: f.attempt.id, assignmentAttempt: f.attempt,
				workspaceContext: { predecessorResults: [f.actor, f.review] } } });
			const row = await f.repository.get(f.principal.teamId, f.attempt.id);
			expect(result).toMatchObject({ leaseToken: row?.leaseToken }); expect(row?.status).toBe('leased');
			expect(Date.parse(row?.leaseExpiresAt ?? '')).toBeLessThanOrEqual(Date.parse(f.attempt.deadline));
			expect(Date.now()).toBeLessThanOrEqual(Date.parse(f.attempt.deadline)); expect(await f.custody()).toEqual(before);
			expect((await f.query("SELECT last_used_at FROM capacity_provider_access_tokens WHERE id='public-poll-token'")).rows[0]?.last_used_at).toBeTruthy();
		} finally { await f.db.close(); }
	});
	it('missing wrong revoked expired malformed and insufficient token authorities cannot claim or mutate assignment finance and history', async () => {
		for (const mode of ['missing', 'wrong', 'revoked', 'expired', 'malformed', 'scope', 'member', 'provider'] as const) {
			const f = await dependencyPublicPoll(); try {
				expect((await f.evaluate()).eligible).toBe(true);
				expect(await f.authenticate()).toMatchObject({ principal: { membershipId: f.principal.membershipId,
					capacityProviderId: f.principal.capacityProviderId, teamId: f.principal.teamId, scopes: ['provider:assignments:read'] } });
				if (mode === 'revoked') await f.query("UPDATE capacity_provider_access_tokens SET status='revoked' WHERE id='public-poll-token'");
				if (mode === 'expired' || mode === 'malformed') await f.query("UPDATE capacity_provider_access_tokens SET expires_at=? WHERE id='public-poll-token'", [mode === 'malformed' ? 'malformed' : f.plan.startsAt]);
				if (mode === 'scope') await f.query("UPDATE capacity_provider_access_tokens SET scopes_json='[]' WHERE id='public-poll-token'");
				if (mode === 'member') await f.query("UPDATE capacity_provider_team_memberships SET status='suspended' WHERE id='membership'");
				if (mode === 'provider') await f.query("UPDATE capacity_providers SET status='revoked' WHERE id='provider'");
				const before = await f.state(), response = await f.request(f.requestBody,
					mode === 'missing' ? { token: '' } : mode === 'wrong' ? { token: 'tspa_unknown_invalid' } : {});
				expect(response.status).toBe(mode === 'scope' ? 403 : 401);
				expect(await f.state()).toEqual(before); expect((await f.repository.get(f.principal.teamId, f.attempt.id))?.status).toBe('pending');
			} finally { await f.db.close(); }
		}
	});
	it('concurrent authenticated public requests produce one immutable claim and retain exact dependency reservation context', async () => {
		const f = await dependencyPublicPoll(); try {
			const before = await f.custody(); const replies = await Promise.all([f.request(), f.request({ ...f.requestBody, runnerId: 'competing-public-runner' })]);
			const results = [];
			for (const reply of replies) { expect(reply.status).toBe(200); const envelope: unknown = await reply.json();
				if (!envelope || typeof envelope !== 'object' || !('data' in envelope)) throw new Error('Public data envelope missing');
				results.push(CONTROL_PLANE_OPERATIONS.providers.nextAssignment.schema.output.parse(envelope.data)); }
			expect(results.filter(result => result.assignment)).toHaveLength(1); expect(await f.custody()).toEqual(before);
			const row = await f.repository.get(f.principal.teamId, f.attempt.id);
			for (const result of results) if (result.assignment) expect(result.leaseToken).toBe(row?.leaseToken); else expect(result.leaseToken).toBeNull();
		} finally { await f.db.close(); }
	});
	it('preaborted public polling cannot reconcile synthesize claim or subscribe after the caller has withdrawn authority', async () => {
		const f = await dependencyPublicPoll(); try {
			expect(await f.authenticate()).toMatchObject({ principal: { teamId: f.principal.teamId, membershipId: f.principal.membershipId } });
			const controller = new AbortController(); controller.abort(); const before = await f.state();
			const response = await f.request(undefined, { signal: controller.signal });
			expect(response.status).toBe(200); const envelope: unknown = await response.json();
			if (!envelope || typeof envelope !== 'object' || !('data' in envelope)) throw new Error('Public data envelope missing');
			expect(CONTROL_PLANE_OPERATIONS.providers.nextAssignment.schema.output.parse(envelope.data)).toMatchObject({ assignment: null, leaseToken: null });
			expect(await f.state()).toEqual(before); expect(f.listenerCounts()).toEqual({ subscribed: 0, unsubscribed: 0 });
		} finally { await f.db.close(); }
	});
	it('public lease update failure retains pending custody and original failed history before identical request retry within the same deadline', async () => {
		const f = await dependencyPublicPoll(); try {
			const before = await f.custody();
			await f.db.exec(`CREATE FUNCTION interrupt_public_poll() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
				IF NEW.status='leased' THEN RAISE EXCEPTION 'public lease interruption'; END IF; RETURN NEW; END $$;
				CREATE TRIGGER interrupt_public_poll BEFORE UPDATE ON capacity_provider_assignments FOR EACH ROW EXECUTE FUNCTION interrupt_public_poll();`);
			expect((await f.request()).status).toBe(500); expect(await f.custody()).toEqual(before);
			expect((await f.repository.get(f.principal.teamId, f.attempt.id))?.status).toBe('pending');
			const history = (await f.query('SELECT * FROM capacity_audit_events ORDER BY id')).rows; expect(history.length).toBeGreaterThan(0);
			await f.db.exec('DROP TRIGGER interrupt_public_poll ON capacity_provider_assignments; DROP FUNCTION interrupt_public_poll();');
			expect(Date.now()).toBeLessThan(Date.parse(f.attempt.deadline)); expect((await f.request()).status).toBe(200);
			expect(await f.custody()).toEqual(before); const after = (await f.query('SELECT * FROM capacity_audit_events ORDER BY id')).rows;
			for (const row of history) expect(after).toContainEqual(row);
		} finally { await f.db.close(); }
	});
	it('aborted empty longpoll releases its original event subscription without another synthesis lease or charge and later events cannot revive it', async () => {
		const f = await dependencyPublicPoll(); let timer: ReturnType<typeof setTimeout> | undefined;
		const controller = new AbortController(); let pending: Promise<Response> | undefined;
		try {
			expect((await f.request()).status).toBe(200); const custody = await f.custody();
			const remaining = Date.parse(f.attempt.deadline) - Date.now(); expect(remaining).toBeGreaterThan(0);
			pending = f.request({ ...f.requestBody, waitSeconds: remaining / 1000 }, { signal: controller.signal });
			await Promise.race([f.subscription, new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error('Original authority elapsed before public longpoll subscription')), remaining);
			})]);
			if (timer) clearTimeout(timer); controller.abort(); const atAbort = await f.snapshot();
			const response = await pending; expect(response.status).toBe(200); const envelope: unknown = await response.json();
			if (!envelope || typeof envelope !== 'object' || !('data' in envelope)) throw new Error('Public data envelope missing');
			expect(CONTROL_PLANE_OPERATIONS.providers.nextAssignment.schema.output.parse(envelope.data)).toMatchObject({ assignment: null, leaseToken: null });
			expect(f.listenerCounts()).toEqual({ subscribed: 1, unsubscribed: 1 });
			expect(await f.snapshot()).toEqual(atAbort); expect(await f.custody()).toEqual(custody);
			const after = await f.snapshot();
			await f.events.publish({ teamId: f.principal.teamId, eventType: 'capacity.assignment.available', resourceId: f.attempt.id,
				payload: { lanePurpose: 'workday' } });
			expect(await f.snapshot()).toEqual(after); expect(f.listenerCounts()).toEqual({ subscribed: 1, unsubscribed: 1 });
		} finally { if (timer) clearTimeout(timer); controller.abort(); try { await pending; } finally { await f.db.close(); } }
	});
});
