import { describe, expect, it } from 'vitest';
import { beforeOriginalDeadline, dependencyLongpoll } from './dependency-longpoll-fixture.ts';
import { eventObserved } from '../../../../../realtime/architecture/session-postgres-fixture.ts';

describe('actual authenticated longpoll wake revalidation and failure cleanup', () => {
	it('authenticated abort during pending original subscription retains native pending custody and admits only a fresh authorized retry after releasing the late listener', async () => {
		let ready: (() => void) | undefined;
		const gate = new Promise<void>(resolve => { ready = resolve; });
		const f = await dependencyLongpoll(gate);
		try {
			const input = structuredClone(f.body), custody = await f.custody(), pending = f.start();
			expect(custody.attempt).toEqual(f.attempt);
			await beforeOriginalDeadline(f.subscription, f.attempt.deadline);
			expect(f.polls()).toBe(1); expect(f.listenerCounts()).toEqual({ subscribed: 1, unsubscribed: 0 });
			// Retain the completed initial poll's legitimate native synthesis audit
			// and explanation, then require NO post-withdrawal SQL mutation.
			const atAbort = await f.revocationState(), first = f.lastPoll(); expect(first).toBeDefined();
			f.controller.abort(); ready?.();
			const response = await beforeOriginalDeadline(pending, f.attempt.deadline); expect(response.status).toBe(200);
			expect(await f.decode(response)).toEqual({ assignment: null, leaseToken: null, leaseSeconds: 30,
				diagnostics: first?.diagnostics ?? null, leaseDiagnostics: first?.diagnostics ?? null });
			expect(f.polls()).toBe(1); expect(f.pollInputs()).toEqual([input]);
			expect(f.listenerCounts()).toEqual({ subscribed: 1, unsubscribed: 1 });
			expect(await f.revocationState()).toEqual(atAbort); expect(await f.custody()).toEqual(custody);
			expect((await f.repository.get(f.principal.teamId, f.attempt.id))?.status).toBe('pending');
			const event = await f.publish(), afterEvent = await f.revocationState();
			expect({ ...afterEvent, sessionEvents: atAbort.sessionEvents }).toEqual(atAbort);
			expect(afterEvent.sessionEvents).toHaveLength(atAbort.sessionEvents.length + 1);
			expect(afterEvent.sessionEvents.some(row => Number(row.sequence) === event.sequence && row.team_id === event.teamId)).toBe(true);
			for (const row of atAbort.sessionEvents) expect(afterEvent.sessionEvents).toContainEqual(row);
			expect(f.polls()).toBe(1); expect(f.listenerCounts()).toEqual({ subscribed: 1, unsubscribed: 1 });
			// A NEW un-aborted public request uses the ORIGINAL admitted lane;
			// it does not resurrect or broaden the withdrawn foreign-lane request.
			const retry = { ...f.requestBody, waitSeconds: 0 }, retryInput = structuredClone(retry);
			const retried = await beforeOriginalDeadline(Promise.resolve(f.request(retry, { token: f.token })), f.attempt.deadline);
			expect(retried.status).toBe(200); const result = await f.decode(retried);
			const row = await f.repository.get(f.principal.teamId, f.attempt.id);
			expect(result).toMatchObject({ assignment: { id: f.attempt.id, assignmentAttempt: { ...f.attempt, status: 'leased' },
				workspaceContext: { predecessorResults: [f.actor, f.review] } }, leaseToken: row?.leaseToken });
			expect(row?.assignmentAttempt).toEqual({ ...f.attempt, status: 'leased' }); expect(f.attempt.status).toBe('created');
			expect(row?.status).toBe('leased'); expect(Date.parse(row?.leaseExpiresAt ?? '')).toBeLessThanOrEqual(Date.parse(f.attempt.deadline));
			expect(f.polls()).toBe(2); expect(f.pollInputs()).toEqual([input, retryInput]);
			expect(f.listenerCounts()).toEqual({ subscribed: 1, unsubscribed: 1 }); expect(await f.custody()).toEqual({ ...custody, attempt: { ...f.attempt, status: 'leased' } });
			const afterRetry = await f.revocationState();
			for (const old of afterEvent.audit) expect(afterRetry.audit).toContainEqual(old);
			expect(afterRetry.sessionEvents).toEqual(afterEvent.sessionEvents); expect(f.body).toEqual(input); expect(retry).toEqual(retryInput);
			expect(Date.now()).toBeLessThanOrEqual(Date.parse(f.attempt.deadline));
		} finally { ready?.(); await f.close(); }
	});
	it('public wait longer than original availability naturally expires without claim financial mutation or deadline extension and released callbacks cannot revive it', async () => {
		const f = await dependencyLongpoll(); try {
			const sessions = (await f.query("SELECT * FROM capacity_provider_availability_sessions WHERE id='session'")).rows;
			expect(sessions).toHaveLength(1); const session = sessions[0]; if (!session) throw new Error('Original availability missing');
			const expiryValue = session.available_until ?? session.expires_at;
			if (typeof expiryValue !== 'string') throw new Error('Original availability expiry missing');
			const expiry = Date.parse(expiryValue); expect(expiryValue).toBe(f.attempt.deadline);
			const body = { ...f.body, waitSeconds: 30 }, input = structuredClone(body), custody = await f.custody(), before = await f.revocationState();
			const started = Date.now(); expect(started).toBeLessThan(expiry); expect(started + body.waitSeconds * 1000).toBeGreaterThan(expiry);
			let received: number | undefined;
			const pending = f.start(body); void pending.then(() => { received = Date.now(); }, () => { received = Date.now(); });
			await beforeOriginalDeadline(f.subscription, f.attempt.deadline); await f.waitForPollAfter(1);
			// Reuse the existing bounded wall-clock observer for terminal response
			// ONLY. Never extend the session/Attempt, fabricate wake, abort early,
			// or treat the post-expiry observer as productive execution authority.
			await eventObserved(() => received !== undefined);
			const response = await pending; expect(response.status).toBe(409);
			const problem: unknown = await response.json(); expect(problem).toMatchObject({ status: 409, code: 'provider_synthesis_window_expired' });
			expect(received).toBeGreaterThanOrEqual(expiry); expect(received).toBeLessThan(started + body.waitSeconds * 1000);
			expect(f.controller.signal.aborted).toBe(false); expect(f.listenerCounts()).toEqual({ subscribed: 1, unsubscribed: 1 });
			for (const pollInput of f.pollInputs()) expect(pollInput).toEqual(input);
			const after = await f.revocationState();
			const assignments = after.financial.capacity_provider_assignments.map(row => {
				if (row.id !== f.attempt.id) return row;
				const old = before.financial.capacity_provider_assignments.find(value => value.id === row.id);
				if (!old) throw new Error('Original pending assignment disappeared');
				return { ...row, explanation_json: old.explanation_json, updated_at: old.updated_at };
			});
			expect({ ...after, audit: before.audit, financial: { ...after.financial, capacity_provider_assignments: assignments } }).toEqual(before);
			for (const row of before.audit) expect(after.audit).toContainEqual(row);
			for (const row of after.audit.filter(row => !before.audit.some(old => old.id === row.id))) {
				expect(row.action).toBe('provider-assignment.synthesis-completed'); expect(row.team_id).toBe(f.principal.teamId);
				expect(typeof row.created_at).toBe('string'); expect(Date.parse(String(row.created_at))).toBeLessThan(expiry);
			}
			const assignment = await f.repository.get(f.principal.teamId, f.attempt.id);
			expect(assignment?.status).toBe('pending'); expect(assignment?.leaseToken).toBeNull();
			expect(assignment?.explanation).toMatchObject({ eligible: false, reasons: ['lane_id_mismatch'],
				gates: { requestedLaneId: input.laneId, requestedLanePurpose: input.lanePurpose } });
			const metadata = assignment?.explanation.metadata;
			if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || !('recordedAt' in metadata)
				|| typeof metadata.recordedAt !== 'string') throw new Error('Original explanation clock missing');
			expect(Date.parse(metadata.recordedAt)).toBeLessThan(expiry);
			expect(await f.custody()).toEqual(custody); expect(body).toEqual(input);
			// Fresh public authentication still has its ORIGINAL separate 60-second
			// token lifetime. It cannot resurrect the expired availability window.
			const finalPolls = f.polls(), retry = await f.request({ ...body, waitSeconds: 0 }, { token: f.token });
			expect(retry.status).toBe(409); expect(await retry.json()).toMatchObject({ code: 'provider_synthesis_window_expired' });
			expect(f.polls()).toBe(finalPolls + 1); expect(await f.revocationState()).toEqual(after);
			const afterRetryPolls = f.polls(); await f.publish(); const published = await f.revocationState();
			expect({ ...published, sessionEvents: after.sessionEvents }).toEqual(after);
			expect(published.sessionEvents.length).toBe(after.sessionEvents.length + 1);
			for (const row of after.sessionEvents) expect(published.sessionEvents).toContainEqual(row);
			expect(f.polls()).toBe(afterRetryPolls); expect(f.listenerCounts()).toEqual({ subscribed: 1, unsubscribed: 1 });
			expect(await f.custody()).toEqual(custody); expect(body).toEqual(input);
		} finally { await f.close(); }
	});
	it('genuinely authenticated owning longpoll freezes each original request field across caller mutation native event wake natural completion and immutable durable readback', async () => {
		for (const mutation of [{ laneId: 'workday' }, { lanePurpose: 'communication' }, { providerSessionId: 'foreign-session' },
			{ runnerId: 'replacement-runner' }, { leaseSeconds: 60 }, { waitSeconds: 30 }]) {
			const f = await dependencyLongpoll(); try {
				const original = structuredClone(f.body), custody = await f.custody(), before = await f.revocationState();
				const started = Date.now(), pending = f.startOwning(f.body);
				await beforeOriginalDeadline(f.subscription, f.attempt.deadline); await f.waitForPollAfter(1);
				Object.assign(f.body, mutation); const changed = structuredClone(f.body), count = f.polls();
				const event = await f.publish(); await f.waitForPollAfter(count);
				const result = await beforeOriginalDeadline(pending, f.attempt.deadline), received = Date.now();
				const last = f.lastPoll(); expect(last).toBeDefined();
				expect(result).toEqual({ assignment: null, leaseToken: null, leaseSeconds: 30,
					diagnostics: last?.diagnostics ?? null, leaseDiagnostics: last?.diagnostics ?? null });
				for (const input of f.pollInputs()) expect(input).toEqual(original);
				expect(received).toBeGreaterThanOrEqual(started + original.waitSeconds * 1000);
				expect(received).toBeLessThanOrEqual(Date.parse(f.attempt.deadline));
				expect(f.controller.signal.aborted).toBe(false); expect(f.body).toEqual(changed);
				expect(f.listenerCounts()).toEqual({ subscribed: 1, unsubscribed: 1 });
				const after = await f.revocationState();
				// Retain legitimate original lane-mismatch explanations and synthesis
				// audits, not a false assertion that the whole poll is write-free.
				const assignments = after.financial.capacity_provider_assignments.map(row => {
					if (row.id !== f.attempt.id) return row;
					const old = before.financial.capacity_provider_assignments.find(value => value.id === row.id);
					if (!old) throw new Error('Original pending assignment disappeared');
					return { ...row, explanation_json: old.explanation_json, updated_at: old.updated_at };
				});
				expect({ ...after, audit: before.audit, sessionEvents: before.sessionEvents,
					financial: { ...after.financial, capacity_provider_assignments: assignments } }).toEqual(before);
				for (const row of before.audit) expect(after.audit).toContainEqual(row);
				for (const row of after.audit.filter(row => !before.audit.some(old => old.id === row.id))) {
					expect(row.action).toBe('provider-assignment.synthesis-completed'); expect(row.team_id).toBe(f.principal.teamId);
				}
				for (const row of before.sessionEvents) expect(after.sessionEvents).toContainEqual(row);
				expect(after.sessionEvents.length).toBe(before.sessionEvents.length + 1);
				expect(after.sessionEvents.some(row => Number(row.sequence) === event.sequence && row.team_id === event.teamId)).toBe(true);
				const assignment = await f.repository.get(f.principal.teamId, f.attempt.id);
				expect(assignment?.status).toBe('pending'); expect(assignment?.explanation).toMatchObject({
					teamId: f.principal.teamId, assignmentId: f.attempt.id, source: 'lease_next_assignment', sourceId: f.attempt.id,
					eligible: false, reasons: ['lane_id_mismatch'], gates: { requestedLaneId: original.laneId, requestedLanePurpose: original.lanePurpose } });
				expect(await f.custody()).toEqual(custody);
				const finalPolls = f.polls(); await f.publish(); const published = await f.revocationState();
				expect({ ...published, sessionEvents: after.sessionEvents }).toEqual(after);
				expect(published.sessionEvents.length).toBe(after.sessionEvents.length + 1);
				for (const row of after.sessionEvents) expect(published.sessionEvents).toContainEqual(row);
				expect(f.polls()).toBe(finalPolls); expect(f.listenerCounts()).toEqual({ subscribed: 1, unsubscribed: 1 });
				expect(f.body).toEqual(changed); expect(await f.custody()).toEqual(custody);
				expect(Date.now()).toBeLessThanOrEqual(Date.parse(f.attempt.deadline));
			} finally { await f.close(); }
		}
	});
	it('public malformed coerced negative and oversized wait inputs deny before reconciliation lease subscription and all auth neutral durable writes', async () => {
		// These values survive JSON unchanged. NaN/Infinity are not separate wire
		// cases: JSON would turn them into null, already covered here.
		for (const waitSeconds of ['', ' ', '1', null, true, false, [], {}, -1, 31]) {
			const f = await dependencyLongpoll(); try {
				const body = { ...f.body, waitSeconds }, input = structuredClone(body);
				const before = await f.revocationState(), custody = await f.custody();
				const response = await beforeOriginalDeadline(f.start(body), f.attempt.deadline);
				expect(response.status).toBe(400);
				expect(f.polls()).toBe(0); expect(f.listenerCounts()).toEqual({ subscribed: 0, unsubscribed: 0 });
				expect(await f.revocationState()).toEqual(before); expect(await f.custody()).toEqual(custody);
				expect(body).toEqual(input);
				expect((await f.repository.get(f.principal.teamId, f.attempt.id))?.status).toBe('pending');
				expect(Date.now()).toBeLessThanOrEqual(Date.parse(f.attempt.deadline));
			} finally { await f.close(); }
		}
	});
	it('natural fractional public wait completion retains the original pending attempt finance and request then releases its subscription without abort or revival', async () => {
		const f = await dependencyLongpoll(); try {
			const input = structuredClone(f.body), custody = await f.custody(), before = await f.revocationState();
			const prior = await f.repository.get(f.principal.teamId, f.attempt.id);
			const started = Date.now(), pending = f.start();
			await beforeOriginalDeadline(f.subscription, f.attempt.deadline);
			const response = await beforeOriginalDeadline(pending, f.attempt.deadline), received = Date.now();
			expect(response.status).toBe(200);
			const last = f.lastPoll(); expect(last).toBeDefined();
			expect(await f.decode(response)).toEqual({ assignment: null, leaseToken: null, leaseSeconds: 30,
				diagnostics: last?.diagnostics ?? null, leaseDiagnostics: last?.diagnostics ?? null });
			expect(received).toBeGreaterThanOrEqual(started + f.body.waitSeconds * 1000);
			expect(received).toBeLessThanOrEqual(Date.parse(f.attempt.deadline));
			expect(f.controller.signal.aborted).toBe(false); expect(f.polls()).toBeGreaterThanOrEqual(2);
			expect(f.listenerCounts()).toEqual({ subscribed: 1, unsubscribed: 1 });
			const after = await f.revocationState();
			// Original synthesis audits and this target's explanation/updated_at
			// writes are real history. No other assignment field is excluded.
			const assignments = after.financial.capacity_provider_assignments.map(row => {
				if (row.id !== f.attempt.id) return row;
				const old = before.financial.capacity_provider_assignments.find(value => value.id === row.id);
				if (!old) throw new Error('Original pending assignment disappeared');
				return { ...row, explanation_json: old.explanation_json, updated_at: old.updated_at };
			});
			expect({ ...after, audit: before.audit, financial: { ...after.financial, capacity_provider_assignments: assignments } }).toEqual(before);
			for (const row of before.audit) expect(after.audit).toContainEqual(row);
			for (const row of after.audit.filter(row => !before.audit.some(old => old.id === row.id))) {
				expect(row.action).toBe('provider-assignment.synthesis-completed');
				expect(row.team_id).toBe(f.principal.teamId);
			}
			const assignment = await f.repository.get(f.principal.teamId, f.attempt.id);
			expect(assignment?.explanation).toMatchObject({ teamId: f.principal.teamId, assignmentId: f.attempt.id,
				source: 'lease_next_assignment', sourceId: f.attempt.id, eligible: false, reasons: ['lane_id_mismatch'],
				gates: { requestedLaneId: f.body.laneId, requestedLanePurpose: f.body.lanePurpose },
				metadata: { diagnosticsSource: 'provider_lease_attempt' } });
			const metadata = assignment?.explanation.metadata;
			if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || !('recordedAt' in metadata)
				|| typeof metadata.recordedAt !== 'string' || !('history' in metadata) || !Array.isArray(metadata.history)) {
				throw new Error('Original lease explanation clock or history missing');
			}
			expect(Date.parse(metadata.recordedAt)).toBeGreaterThanOrEqual(started);
			expect(Date.parse(metadata.recordedAt)).toBeLessThanOrEqual(received);
			if (prior?.explanation && Object.keys(prior.explanation).length) expect(metadata.history).toEqual(expect.arrayContaining([
				expect.objectContaining({ source: prior.explanation.source, sourceId: prior.explanation.sourceId,
					eligible: prior.explanation.eligible, reasons: prior.explanation.reasons, gates: prior.explanation.gates }),
			]));
			expect(await f.custody()).toEqual(custody); expect(f.body).toEqual(input);
			expect((await f.repository.get(f.principal.teamId, f.attempt.id))?.status).toBe('pending');
			const finalPolls = f.polls(); await f.publish(); const published = await f.revocationState();
			expect({ ...published, sessionEvents: after.sessionEvents }).toEqual(after);
			expect(published.sessionEvents.length).toBe(after.sessionEvents.length + 1);
			expect(f.polls()).toBe(finalPolls); expect(f.listenerCounts()).toEqual({ subscribed: 1, unsubscribed: 1 });
			expect(await f.custody()).toEqual(custody); expect(Date.now()).toBeLessThanOrEqual(Date.parse(f.attempt.deadline));
		} finally { await f.close(); }
	});
	it('durable foreign team foreign purpose and matching wake events never rebind the frozen foreign lane or revive an unsubscribed public poll', async () => {
		const f = await dependencyLongpoll(); try {
			const custody = await f.custody(), input = structuredClone(f.body), pending = f.start();
			await beforeOriginalDeadline(f.subscription, f.attempt.deadline);
			await f.waitForPollAfter(1);
			const events = [];
			for (const [team, purpose] of [['foreign-team', 'workday'], [f.principal.teamId, 'communication'], [f.principal.teamId, 'workday']]) {
				const event = await f.publish(team, purpose); events.push(event);
				expect(event).toMatchObject({ teamId: team, eventType: 'capacity.assignment.available', resourceId: f.attempt.id, payload: { lanePurpose: purpose } });
			}
			const count = f.polls(); await f.publish(); await f.waitForPollAfter(count);
			expect((await f.repository.get(f.principal.teamId, f.attempt.id))?.status).toBe('pending');
			expect(await f.custody()).toEqual(custody); expect(f.body).toEqual(input);
			f.controller.abort(); const response = await beforeOriginalDeadline(pending, f.attempt.deadline);
			expect(response.status).toBe(200); expect(await f.decode(response)).toMatchObject({ assignment: null, leaseToken: null });
			expect(f.listenerCounts()).toEqual({ subscribed: 1, unsubscribed: 1 });
			const after = await f.revocationState(), finalPolls = f.polls(); await f.publish();
			const published = await f.revocationState();
			expect({ ...published, sessionEvents: after.sessionEvents }).toEqual(after);
			expect(published.sessionEvents.length).toBe(after.sessionEvents.length + 1);
			for (const event of events) expect(published.sessionEvents.some(row => Number(row.sequence) === event.sequence && row.team_id === event.teamId)).toBe(true);
			expect(f.polls()).toBe(finalPolls); expect(f.listenerCounts()).toEqual({ subscribed: 1, unsubscribed: 1 });
			expect(await f.custody()).toEqual(custody); expect(Date.now()).toBeLessThanOrEqual(Date.parse(f.attempt.deadline));
		} finally { await f.close(); }
	});
	it('token membership provider and stale foreign or malformed session changes during the actual wait fence further work and release the original subscription', async () => {
		for (const mode of ['token', 'member', 'provider', 'closed', 'foreign-team', 'foreign-member', 'elapsed', 'malformed'] as const) {
			const f = await dependencyLongpoll(); try {
				const input = structuredClone(f.body), pending = f.start(); await beforeOriginalDeadline(f.subscription, f.attempt.deadline);
				await f.waitForPollAfter(1);
				if (mode === 'token') await f.query("UPDATE capacity_provider_access_tokens SET status='revoked' WHERE credential_id='token-credential'");
				if (mode === 'member') await f.query("UPDATE capacity_provider_team_memberships SET status='revoked' WHERE id='membership'");
				if (mode === 'provider') await f.query("UPDATE capacity_providers SET status='revoked' WHERE id='provider'");
				if (mode === 'closed') await f.query("UPDATE capacity_provider_availability_sessions SET status='closed' WHERE id='session'");
				if (mode === 'foreign-team') await f.query("UPDATE capacity_provider_availability_sessions SET team_id='foreign-team' WHERE id='session'");
				if (mode === 'foreign-member') await f.query("UPDATE capacity_provider_availability_sessions SET membership_id='foreign-member' WHERE id='session'");
				if (mode === 'elapsed' || mode === 'malformed') await f.query("UPDATE capacity_provider_availability_sessions SET available_until=? WHERE id='session'", [mode === 'elapsed' ? f.now : 'malformed']);
				const before = await f.revocationState(), custody = await f.custody(); await f.publish();
				const response = await beforeOriginalDeadline(pending, f.attempt.deadline);
				expect(response.status).toBe(mode === 'token' ? 401 : mode === 'member' || mode === 'provider' ? 403
					: mode === 'foreign-team' || mode === 'foreign-member' ? 404 : mode === 'malformed' ? 400 : 409);
				const after = await f.revocationState(); expect({ ...after, sessionEvents: before.sessionEvents }).toEqual(before);
				expect(after.sessionEvents.length).toBe(before.sessionEvents.length + 1);
				expect(await f.custody()).toEqual(custody); expect(f.body).toEqual(input);
				expect((await f.repository.get(f.principal.teamId, f.attempt.id))?.status).toBe('pending');
				expect(f.listenerCounts()).toEqual({ subscribed: 1, unsubscribed: 1 });
				expect(Date.now()).toBeLessThanOrEqual(Date.parse(f.attempt.deadline));
			} finally { await f.close(); }
		}
	});
	it('native synthesis audit interruption after public subscription retains pending custody releases exactly once and original bounded retry preserves all failed history', async () => {
		const f = await dependencyLongpoll(); try {
			const custody = await f.custody(), input = structuredClone(f.body), pending = f.start();
			await beforeOriginalDeadline(f.subscription, f.attempt.deadline);
			await f.waitForPollAfter(1);
			const history = (await f.query('SELECT * FROM capacity_audit_events ORDER BY id')).rows;
			await f.db.exec(`CREATE FUNCTION interrupt_waiting_poll_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
				IF NEW.action IN ('provider-assignment.synthesis-completed','provider-assignment.synthesis-failed') THEN RAISE EXCEPTION 'waiting poll audit interruption'; END IF; RETURN NEW; END $$;
				CREATE TRIGGER interrupt_waiting_poll_audit BEFORE INSERT ON capacity_audit_events FOR EACH ROW EXECUTE FUNCTION interrupt_waiting_poll_audit();`);
			await f.publish(); expect((await beforeOriginalDeadline(pending, f.attempt.deadline)).status).toBe(500);
			expect(f.listenerCounts()).toEqual({ subscribed: 1, unsubscribed: 1 });
			expect(await f.custody()).toEqual(custody); expect(f.body).toEqual(input);
			expect((await f.repository.get(f.principal.teamId, f.attempt.id))?.status).toBe('pending');
			await f.db.exec('DROP TRIGGER interrupt_waiting_poll_audit ON capacity_audit_events; DROP FUNCTION interrupt_waiting_poll_audit();');
			const response = await f.request({ ...f.body, waitSeconds: 0 }, { token: f.token });
			expect(response.status).toBe(200); expect(await f.decode(response)).toMatchObject({ assignment: null, leaseToken: null });
			const after = (await f.query('SELECT * FROM capacity_audit_events ORDER BY id')).rows;
			for (const row of history) expect(after).toContainEqual(row);
			expect(await f.custody()).toEqual(custody); expect(f.body).toEqual(input);
			expect(f.listenerCounts()).toEqual({ subscribed: 1, unsubscribed: 1 });
			expect(Date.now()).toBeLessThanOrEqual(Date.parse(f.attempt.deadline));
		} finally { await f.close(); }
	});
});
