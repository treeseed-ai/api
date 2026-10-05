import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { SessionEventService, type SessionEvent } from '../../../../../src/api/realtime/session-events.ts';
import { eventObserved, sessionPostgres } from './session-postgres-fixture.ts';

describe('independent PostgreSQL session event delivery and subscription ownership', () => {
	it('native occupied listener pool queues one shared initial acquisition for concurrent team registrations and completed subscriptions own the original channel before independent delivery', async () => {
		const f = await sessionPostgres(), first: SessionEvent[] = [], second: SessionEvent[] = [], foreign: SessionEvent[] = [];
		let holder: PoolClient | undefined, pending: Promise<PromiseSettledResult<() => void>[]> | undefined, done = false, settled = 0;
		let acquisitions = 0, returns = 0; const releases: Array<() => void> = [];
		const observeAcquire = () => { acquisitions++; }, observeRelease = () => { returns++; };
		f.listenerPool.on('acquire', observeAcquire); f.listenerPool.on('release', observeRelease);
		try {
			const graph = await f.snapshot(), earlier = await f.rows();
			const input = { teamId: 'team', eventType: 'capacity.assignment.available', resourceId: 'same-queued-activation-native-input' }, original = structuredClone(input);
			holder = await f.listenerPool.connect();
			expect((await holder.query('SELECT current_database() AS database')).rows).toEqual([{ database: f.name }]);
			expect((await holder.query('SELECT pg_listening_channels() AS channel')).rows).toEqual([]);
			const priorAcquisitions = acquisitions, priorReturns = returns;
			const registrations = [f.subscriber.subscribe('team', event => first.push(event)), f.subscriber.subscribe('team', event => second.push(event)), f.subscriber.subscribe('foreign-team', event => foreign.push(event))];
			for (const registration of registrations) void registration.then(() => { settled++; }, () => { settled++; });
			pending = Promise.allSettled(registrations); void pending.then(() => { done = true; });
			await eventObserved(() => f.listenerPool.waitingCount === 1);
			expect(acquisitions).toBe(priorAcquisitions); expect(returns).toBe(priorReturns); expect(settled).toBe(0); expect(done).toBe(false);
			expect(f.listenerPool.totalCount - f.listenerPool.idleCount).toBe(1);
			expect(first).toEqual([]); expect(second).toEqual([]); expect(foreign).toEqual([]);
			expect(await f.rows()).toEqual(earlier); expect(await f.snapshot()).toEqual(graph);
			holder.release(); holder = undefined;
			await eventObserved(() => done); for (const outcome of await pending) { expect(outcome.status).toBe('fulfilled'); if (outcome.status === 'fulfilled') releases.push(outcome.value); }
			expect(settled).toBe(3); expect(acquisitions).toBe(priorAcquisitions + 1); expect(returns).toBe(priorReturns + 1);
			expect(f.listenerPool.waitingCount).toBe(0); expect(f.listenerPool.totalCount - f.listenerPool.idleCount).toBe(1);
			expect((await f.listenerClient().query('SELECT current_database() AS database, pg_listening_channels() AS channel')).rows).toEqual([{ database: f.name, channel: 'treeseed_session_events' }]);
			expect(await f.rows()).toEqual(earlier); expect(await f.snapshot()).toEqual(graph);
			// Publish ONLY after actual channel readiness. This does not invent a
			// callback backfill policy for events committed before LISTEN activation.
			const same = await f.publisher.publish(input); await eventObserved(() => first.length === 1 && second.length === 1);
			expect(first).toEqual([same]); expect(second).toEqual([same]); expect(foreign).toEqual([]);
			for (const release of releases.slice(0, 2)) { release(); release(); }
			expect(returns).toBe(priorReturns + 1); expect(f.listenerPool.totalCount - f.listenerPool.idleCount).toBe(1);
			const other = await f.publisher.publish({ ...input, teamId: 'foreign-team' }); await eventObserved(() => foreign.length === 1);
			expect(first).toEqual([same]); expect(second).toEqual([same]); expect(foreign).toEqual([other]);
			const last = releases[2]; if (!last) throw new Error('Missing native foreign activation registration'); last(); last();
			await eventObserved(() => f.listenerPool.totalCount === f.listenerPool.idleCount && f.listenerPool.waitingCount === 0);
			expect(returns).toBe(priorReturns + 2); expect(acquisitions).toBe(priorAcquisitions + 1);
			expect((await f.listenerPool.query('SELECT pg_listening_channels() AS channel')).rows).toEqual([]);
			const later = await f.publisher.publish(input); expect(first).toEqual([same]); expect(second).toEqual([same]); expect(foreign).toEqual([other]);
			expect(await f.subscriber.list('team', 0)).toEqual([same, later]); expect(await f.subscriber.list('foreign-team', 0)).toEqual([other]);
			const after = await f.rows(); expect(after).toHaveLength(earlier.length + 3); for (const row of earlier) expect(after).toContainEqual(row);
			expect((await f.left.pool.query('SELECT * FROM session_events ORDER BY sequence')).rows).toEqual(after);
			expect(await f.snapshot()).toEqual(graph); expect(input).toEqual(original);
		} finally {
			holder?.release();
			try { if (pending) { await eventObserved(() => done); for (const outcome of await pending) if (outcome.status === 'fulfilled') outcome.value(); } for (const release of releases) release(); }
			finally { try { await f.close(); } finally { f.listenerPool.removeListener('acquire', observeAcquire); f.listenerPool.removeListener('release', observeRelease); } }
		}
	}, 30_000);
	it('native queued listener SQL overlaps last unsubscribe and same plus foreign team reacquisition without stale release channel loss or callback revival', async () => {
		const f = await sessionPostgres(), prior: SessionEvent[] = [], current: SessionEvent[] = [], foreign: SessionEvent[] = [];
		let holder: PoolClient | undefined, blocked: Promise<unknown> | undefined, pending: Promise<PromiseSettledResult<() => void>[]> | undefined;
		let releaseOld: (() => void) | undefined, blockedDone = false, pendingDone = false; const releases: Array<() => void> = [];
		try {
			const graph = await f.snapshot(), input = { teamId: 'team', eventType: 'capacity.assignment.available', resourceId: 'same-inflight-native-input' }, original = structuredClone(input);
			releaseOld = await f.subscriber.subscribe('team', event => prior.push(event));
			const first = await f.publisher.publish(input); await eventObserved(() => prior.length === 1); expect(prior).toEqual([first]);
			const earlier = await f.rows(), listener = f.listenerClient();
			const identity = (await listener.query('SELECT pg_backend_pid() AS pid, current_database() AS database, pg_listening_channels() AS channel')).rows;
			expect(identity).toHaveLength(1); expect(identity[0].database).toBe(f.name); expect(identity[0].channel).toBe('treeseed_session_events');
			const pid = identity[0].pid; expect(Number.isSafeInteger(pid)).toBe(true); expect(pid).toBeGreaterThan(0); expect(pid).toBeLessThanOrEqual(2147483647);
			holder = await f.left.pool.connect(); expect((await holder.query('SELECT current_database() AS database')).rows).toEqual([{ database: f.name }]);
			await holder.query('BEGIN'); await holder.query('SELECT pg_advisory_xact_lock($1,$2)', [pid, pid]);
			// Database-local transaction lock INPUT on ONLY the allocated fresh DB;
			// actual native query blocks this owned listener's FIFO ahead of cleanup.
			blocked = listener.query('SELECT pg_advisory_xact_lock($1,$2)', [pid, pid]);
			void blocked.then(() => { blockedDone = true; }, () => { blockedDone = true; });
			await eventObserved(async () => (await f.right.pool.query("SELECT pid FROM pg_locks WHERE locktype='advisory' AND pid=$1 AND database=(SELECT oid FROM pg_database WHERE datname=$2) AND classid=$1::oid AND objid=$1::oid AND objsubid=2 AND NOT granted", [pid, f.name])).rows.length === 1);
			releaseOld(); releaseOld();
			pending = Promise.allSettled([f.subscriber.subscribe('team', event => current.push(event)), f.subscriber.subscribe('foreign-team', event => foreign.push(event))]);
			void pending.then(() => { pendingDone = true; });
			releaseOld(); releaseOld();
			expect(await f.rows()).toEqual(earlier); expect(await f.snapshot()).toEqual(graph);
			await holder.query('ROLLBACK'); await eventObserved(() => blockedDone); await blocked; await eventObserved(() => pendingDone);
			expect((await f.right.pool.query("SELECT pid FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=$2) AND classid=$1::oid AND objid=$1::oid AND objsubid=2", [pid, f.name])).rows).toEqual([]);
			const outcomes = await pending; for (const outcome of outcomes) if (outcome.status === 'fulfilled') releases.push(outcome.value);
			for (const outcome of outcomes) expect(outcome.status).toBe('fulfilled');
			expect(f.listenerPool.totalCount - f.listenerPool.idleCount).toBe(1); expect(f.listenerPool.waitingCount).toBe(0);
			const listening = (await f.listenerClient().query('SELECT current_database() AS database, pg_listening_channels() AS channel')).rows;
			expect(listening).toEqual([{ database: f.name, channel: 'treeseed_session_events' }]);
			// Same physical backend reuse is valid; current logical channel and
			// native independent delivery, not a changed PID, are the authority.
			releaseOld(); releaseOld();
			const next = await f.publisher.publish(input); await eventObserved(() => current.length === 1);
			const other = await f.publisher.publish({ ...input, teamId: 'foreign-team' }); await eventObserved(() => foreign.length === 1);
			expect(prior).toEqual([first]); expect(current).toEqual([next]); expect(foreign).toEqual([other]);
			for (const release of releases) { release(); release(); } releaseOld();
			await eventObserved(() => f.listenerPool.totalCount === f.listenerPool.idleCount && f.listenerPool.waitingCount === 0);
			expect((await f.listenerPool.query('SELECT pg_listening_channels() AS channel')).rows).toEqual([]);
			const later = await f.publisher.publish(input); expect(prior).toEqual([first]); expect(current).toEqual([next]); expect(foreign).toEqual([other]);
			expect(await f.subscriber.list('team', 0)).toEqual([first, next, later]); expect(await f.subscriber.list('foreign-team', 0)).toEqual([other]);
			const after = await f.rows(); expect(after).toHaveLength(earlier.length + 3); for (const row of earlier) expect(after).toContainEqual(row);
			expect((await f.left.pool.query('SELECT * FROM session_events ORDER BY sequence')).rows).toEqual(after);
			expect(await f.snapshot()).toEqual(graph); expect(input).toEqual(original);
		} finally {
			try { if (holder) await holder.query('ROLLBACK'); if (blocked) { await eventObserved(() => blockedDone); await blocked; } }
			finally {
				holder?.release(); releaseOld?.();
				try { if (pending) { await eventObserved(() => pendingDone); for (const outcome of await pending) if (outcome.status === 'fulfilled') outcome.value(); } for (const release of releases) release(); }
				finally { await f.close(); }
			}
		}
	}, 30_000);
	it('native listener disconnection automatically restores existing team registrations without a new subscriber preserves independent durable delivery and releases only the final current channel', async () => {
		const f = await sessionPostgres(), first: SessionEvent[] = [], second: SessionEvent[] = [], foreign: SessionEvent[] = [], errors: Error[] = [];
		const releases: Array<() => void> = []; let removeError: (() => void) | undefined;
		let acquired = 0, returned = 0;
		const observeAcquire = () => { acquired++; }, observeRelease = () => { returned++; }, observeError = (error: Error) => { errors.push(error); };
		f.listenerPool.on('acquire', observeAcquire); f.listenerPool.on('release', observeRelease);
		try {
			const graph = await f.snapshot(), input = { teamId: 'team', eventType: 'capacity.assignment.available', resourceId: 'same-automatic-native-input', payload: { lanePurpose: 'workday' } };
			const original = structuredClone(input);
			releases.push(await f.subscriber.subscribe('team', event => first.push(event)));
			releases.push(await f.subscriber.subscribe('team', event => second.push(event)));
			releases.push(await f.subscriber.subscribe('foreign-team', event => foreign.push(event)));
			const initial = await f.publisher.publish(input); await eventObserved(() => first.length === 1 && second.length === 1);
			expect(first).toEqual([initial]); expect(second).toEqual([initial]); expect(foreign).toEqual([]);
			const earlier = await f.rows(), client = f.listenerClient();
			const identity = (await client.query('SELECT pg_backend_pid() AS pid, current_database() AS database, pg_listening_channels() AS channel')).rows;
			expect(identity).toHaveLength(1); expect(identity[0].database).toBe(f.name); expect(identity[0].channel).toBe('treeseed_session_events');
			const pid = identity[0].pid; expect(Number.isSafeInteger(pid)).toBe(true); expect(pid).toBeGreaterThan(0);
			const owners = (await f.left.pool.query("SELECT pid, datname, backend_start::text AS started FROM pg_stat_activity WHERE pid=$1 AND datname=$2 AND backend_type='client backend' AND pid<>pg_backend_pid()", [pid, f.name])).rows;
			expect(owners).toHaveLength(1); expect(owners[0].pid).toBe(pid); expect(owners[0].datname).toBe(f.name); expect(typeof owners[0].started).toBe('string');
			const priorAcquired = acquired, priorReturned = returned; expect(priorAcquired).toBe(1); expect(priorReturned).toBe(0);
			client.on('error', observeError); removeError = () => { client.removeListener('error', observeError); };
			// Signal ONLY this allocated backend: exact fresh DB + original start
			// fence PID reuse. No server/container/customer database is touched.
			expect((await f.left.pool.query("SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE pid=$1 AND datname=$2 AND backend_start=$3::timestamptz AND backend_type='client backend' AND pid<>pg_backend_pid()", [pid, f.name, owners[0].started])).rows).toEqual([{ terminated: true }]);
			await eventObserved(() => errors.some(error => 'code' in error && error.code === '57P01'));
			await eventObserved(async () => (await f.left.pool.query('SELECT pid FROM pg_stat_activity WHERE pid=$1 AND datname=$2 AND backend_start=$3::timestamptz', [pid, f.name, owners[0].started])).rows.length === 0);
			// NO subsequent subscribe/publish/list/pool-query workaround can
			// initiate listener recovery. Observe native acquisition FIRST.
			await eventObserved(() => acquired === priorAcquired + 1 && f.listenerPool.totalCount - f.listenerPool.idleCount === 1);
			expect(returned).toBe(priorReturned + 1); expect(f.listenerPool.waitingCount).toBe(0);
			const restored = (await f.listenerClient().query('SELECT pg_backend_pid() AS pid, current_database() AS database, pg_listening_channels() AS channel')).rows;
			expect(restored).toHaveLength(1); expect(restored[0].database).toBe(f.name); expect(restored[0].channel).toBe('treeseed_session_events'); expect(restored[0].pid).not.toBe(pid);
			expect(await f.rows()).toEqual(earlier); expect(await f.snapshot()).toEqual(graph);
			const next = await f.publisher.publish(input); await eventObserved(() => first.length === 2 && second.length === 2);
			await f.left.pool.query("SELECT pg_notify('treeseed_session_events',$1)", [String(next.sequence)]);
			const other = await f.publisher.publish({ ...input, teamId: 'foreign-team' }); await eventObserved(() => foreign.length === 1);
			expect(first).toEqual([initial, next]); expect(second).toEqual([initial, next]); expect(foreign).toEqual([other]);
			for (const release of releases.slice(0, 2)) { release(); release(); }
			expect(returned).toBe(priorReturned + 1); expect(f.listenerPool.totalCount - f.listenerPool.idleCount).toBe(1);
			const foreignNext = await f.publisher.publish({ ...input, teamId: 'foreign-team' }); await eventObserved(() => foreign.length === 2);
			expect(first).toEqual([initial, next]); expect(second).toEqual([initial, next]); expect(foreign).toEqual([other, foreignNext]);
			const last = releases[2]; if (!last) throw new Error('Missing original foreign registration'); last(); last();
			await eventObserved(() => f.listenerPool.totalCount === f.listenerPool.idleCount && returned === priorReturned + 2);
			expect(acquired).toBe(priorAcquired + 1); expect(f.listenerPool.waitingCount).toBe(0);
			// Check UNLISTEN before safety cleanup; this legitimate idle query
			// is deliberately AFTER the exact native release-count assertion.
			expect((await f.listenerPool.query('SELECT pg_listening_channels() AS channel')).rows).toEqual([]);
			const later = await f.publisher.publish(input);
			expect(first).toEqual([initial, next]); expect(second).toEqual([initial, next]); expect(foreign).toEqual([other, foreignNext]);
			expect(await f.subscriber.list('team', 0)).toEqual([initial, next, later]); expect(await f.subscriber.list('foreign-team', 0)).toEqual([other, foreignNext]);
			const after = await f.rows(); expect(after).toHaveLength(earlier.length + 4); for (const row of earlier) expect(after).toContainEqual(row);
			expect((await f.left.pool.query('SELECT * FROM session_events ORDER BY sequence')).rows).toEqual(after);
			expect(await f.snapshot()).toEqual(graph); expect(input).toEqual(original);
		} finally {
			for (const release of releases) release();
			try { await f.close(); } finally { removeError?.(); f.listenerPool.removeListener('acquire', observeAcquire); f.listenerPool.removeListener('release', observeRelease); }
		}
	}, 30_000);
	it('concurrent first native subscriptions share the original LISTEN rejection cause release one acquired client and concurrent retry restores only newly admitted team callbacks', async () => {
		const f = await sessionPostgres(), healthy: SessionEvent[] = [], denied: SessionEvent[][] = [], retried: SessionEvent[][] = [];
		const releases: Array<() => void> = []; let releaseHealthy: (() => void) | undefined;
		let setup: Promise<void> | undefined, removeObserver: (() => void) | undefined;
		const setupErrors: unknown[] = [];
		try {
			const graph = await f.snapshot();
			const input = { teamId: 'team', eventType: 'capacity.assignment.available', resourceId: 'same-shared-native-input', payload: { lanePurpose: 'workday' } };
			const original = structuredClone(input);
			releaseHealthy = await f.subscriber.subscribe('team', event => healthy.push(event));
			const first = await f.publisher.publish(input); await eventObserved(() => healthy.length === 1); expect(healthy).toEqual([first]);
			const earlier = await f.rows(), pool = f.trackedPool(), service = new SessionEventService(f.rightStore, pool);
			let acquisitions = 0, returns = 0, listener: PoolClient | undefined;
			const observeAcquire = (client: PoolClient) => { acquisitions++; listener = client; };
			const observeReturn = () => { returns++; };
			pool.on('acquire', observeAcquire); pool.on('release', observeReturn);
			removeObserver = () => { pool.removeListener('acquire', observeAcquire); pool.removeListener('release', observeReturn); };
			// Same real acquired-client failure setup as the single-subscriber case.
			// Only this fresh pool's first client queues native SQL before LISTEN.
			pool.once('acquire', client => {
				setup = client.query('BEGIN; SELECT 1/0').then(
					() => { throw new Error('Native division by zero unexpectedly succeeded'); }, error => { setupErrors.push(error); });
			});
			const teams = ['team', 'team', 'foreign-team'];
			const outcomes = await Promise.allSettled(teams.map(team => {
				const events: SessionEvent[] = []; denied.push(events); return service.subscribe(team, event => events.push(event));
			}));
			for (const outcome of outcomes) if (outcome.status === 'fulfilled') releases.push(outcome.value);
			expect(setup).toBeDefined(); await setup; expect(setupErrors).toMatchObject([{ code: '22012' }]);
			expect(acquisitions).toBe(1); expect(pool.waitingCount).toBe(0);
			const failed = outcomes[0]; expect(failed?.status).toBe('rejected');
			if (!failed || failed.status !== 'rejected') throw new Error('Original shared native LISTEN denial was admitted');
			for (const outcome of outcomes) {
				expect(outcome.status).toBe('rejected');
				if (outcome.status === 'rejected') { expect(outcome.reason).toBe(failed.reason); expect(outcome.reason).toMatchObject({ code: '25P02' }); }
			}
			// Service return/discard must precede any fixture ROLLBACK or release.
			await eventObserved(() => pool.totalCount === pool.idleCount);
			expect(returns).toBe(1);
			expect((await pool.query('SELECT 1 AS clean')).rows).toEqual([{ clean: 1 }]);
			expect((await pool.query('SELECT pg_listening_channels() AS channel')).rows).toEqual([]);
			expect(await f.rows()).toEqual(earlier); expect(await f.snapshot()).toEqual(graph);
			const second = await service.publish(input); await eventObserved(() => healthy.length === 2);
			expect(healthy).toEqual([first, second]); expect(denied).toEqual([[], [], []]);
			const priorAcquisitions = acquisitions, priorReturns = returns;
			const retry = await Promise.allSettled(teams.map(team => {
				const events: SessionEvent[] = []; retried.push(events); return service.subscribe(team, event => events.push(event));
			}));
			for (const outcome of retry) if (outcome.status === 'fulfilled') releases.push(outcome.value);
			for (const outcome of retry) expect(outcome.status).toBe('fulfilled');
			expect(acquisitions).toBe(priorAcquisitions + 1); expect(pool.waitingCount).toBe(0); expect(pool.totalCount - pool.idleCount).toBe(1);
			if (!listener) throw new Error('Missing actual newly acquired listener');
			expect((await listener.query('SELECT current_database() AS database, pg_listening_channels() AS channel')).rows).toEqual([{ database: f.name, channel: 'treeseed_session_events' }]);
			const third = await f.publisher.publish(input), other = await f.publisher.publish({ ...input, teamId: 'foreign-team' });
			await eventObserved(() => healthy.length === 3 && retried.every(events => events.length === 1));
			expect(healthy).toEqual([first, second, third]); expect(retried).toEqual([[third], [third], [other]]); expect(denied).toEqual([[], [], []]);
			expect(await service.list('team', 0)).toEqual([first, second, third]); expect(await service.list('foreign-team', 0)).toEqual([other]);
			const after = await f.rows(); expect(after).toHaveLength(earlier.length + 3); for (const row of earlier) expect(after).toContainEqual(row);
			expect((await f.left.pool.query('SELECT * FROM session_events ORDER BY sequence')).rows).toEqual(after);
			expect(await f.snapshot()).toEqual(graph); expect(input).toEqual(original);
			for (const release of releases) { release(); release(); } releaseHealthy(); releaseHealthy();
			await eventObserved(() => pool.totalCount === pool.idleCount && f.listenerPool.totalCount === f.listenerPool.idleCount);
			expect(returns).toBe(priorReturns + 1);
			expect((await pool.query('SELECT pg_listening_channels() AS channel')).rows).toEqual([]);
			expect((await f.listenerPool.query('SELECT pg_listening_channels() AS channel')).rows).toEqual([]);
		} finally {
			for (const release of releases) release(); releaseHealthy?.();
			try { await setup; } finally { try { await f.close(); } finally { removeObserver?.(); } }
		}
	}, 30_000);
	it('stale repeated last unsubscribe after native channel release cannot unbind later same team delivery and final current release retains durable history without callback revival', async () => {
		const f = await sessionPostgres(), old: SessionEvent[] = [], current: SessionEvent[] = [], foreign: SessionEvent[] = [];
		let releaseOld: (() => void) | undefined, releaseCurrent: (() => void) | undefined, releaseForeign: (() => void) | undefined;
		try {
			const graph = await f.snapshot();
			const input = { teamId: 'team', eventType: 'capacity.assignment.available', resourceId: 'same-native-resubscription-input', payload: { lanePurpose: 'workday' } };
			const original = structuredClone(input);
			releaseOld = await f.subscriber.subscribe('team', event => old.push(event));
			const first = await f.publisher.publish(input); await eventObserved(() => old.length === 1); expect(old).toEqual([first]);
			const earlier = await f.rows();
			releaseOld(); releaseOld();
			// Service release is asserted BEFORE test safety cleanup or re-acquisition.
			await eventObserved(() => f.listenerPool.totalCount === f.listenerPool.idleCount);
			expect((await f.listenerPool.query('SELECT pg_listening_channels() AS channel')).rows).toEqual([]);
			expect(await f.rows()).toEqual(earlier); expect(await f.snapshot()).toEqual(graph);
			releaseCurrent = await f.subscriber.subscribe('team', event => current.push(event));
			releaseForeign = await f.subscriber.subscribe('foreign-team', event => foreign.push(event));
			expect(f.listenerPool.totalCount - f.listenerPool.idleCount).toBe(1);
			const listening = (await f.listenerClient().query('SELECT current_database() AS database, pg_listening_channels() AS channel')).rows;
			expect(listening).toEqual([{ database: f.name, channel: 'treeseed_session_events' }]);
			// Reusing the same idle backend is valid. The OLD logical release must
			// not delete the newly registered team or release its active listener.
			releaseOld(); releaseOld();
			expect(f.listenerPool.totalCount - f.listenerPool.idleCount).toBe(1);
			expect((await f.listenerClient().query('SELECT current_database() AS database, pg_listening_channels() AS channel')).rows).toEqual(listening);
			expect(await f.rows()).toEqual(earlier); expect(await f.snapshot()).toEqual(graph);
			const second = await f.publisher.publish(input);
			const other = await f.publisher.publish({ ...input, teamId: 'foreign-team' });
			await eventObserved(() => current.length === 1 && foreign.length === 1);
			expect(current).toEqual([second]); expect(foreign).toEqual([other]); expect(old).toEqual([first]);
			expect(await f.subscriber.list('team', 0)).toEqual([first, second]);
			expect(await f.subscriber.list('foreign-team', 0)).toEqual([other]);
			const delivered = await f.rows(); expect(delivered).toHaveLength(earlier.length + 2);
			for (const row of earlier) expect(delivered).toContainEqual(row);
			expect((await f.left.pool.query('SELECT * FROM session_events ORDER BY sequence')).rows).toEqual(delivered);
			expect(await f.snapshot()).toEqual(graph); expect(input).toEqual(original);
			releaseCurrent(); releaseCurrent(); releaseForeign(); releaseForeign(); releaseOld();
			await eventObserved(() => f.listenerPool.totalCount === f.listenerPool.idleCount);
			expect((await f.listenerPool.query('SELECT pg_listening_channels() AS channel')).rows).toEqual([]);
			const later = await f.publisher.publish(input);
			expect(await f.subscriber.list('team', second.sequence)).toEqual([later]);
			expect(await f.subscriber.list('team', 0)).toEqual([first, second, later]);
			expect(await f.subscriber.list('foreign-team', 0)).toEqual([other]);
			const after = await f.rows(); expect(after).toHaveLength(delivered.length + 1);
			for (const row of delivered) expect(after).toContainEqual(row);
			expect((await f.left.pool.query('SELECT * FROM session_events ORDER BY sequence')).rows).toEqual(after);
			expect(old).toEqual([first]); expect(current).toEqual([second]); expect(foreign).toEqual([other]);
			expect(await f.snapshot()).toEqual(graph); expect(input).toEqual(original);
		} finally { releaseOld?.(); releaseCurrent?.(); releaseForeign?.(); await f.close(); }
	}, 30_000);
	it('exact fresh native listener backend disconnection retains durable missed notification history and original subscription retry restores registered team delivery without leaked client custody', async () => {
		const f = await sessionPostgres(), received: SessionEvent[] = [], foreign: SessionEvent[] = [], errors: Error[] = [];
		let release: (() => void) | undefined, releaseForeign: (() => void) | undefined;
		const observeError = (error: Error) => { errors.push(error); };
		let removeObserver: (() => void) | undefined;
		let holder: PoolClient | undefined, queued: Promise<unknown> | undefined, queuedDone = false;
		const holdRestoration = (client: PoolClient) => {
			// Native pool acquire fires before LISTEN. Queue an owned SQL barrier,
			// so this case observes a genuine notification gap during recovery.
			queued = client.query('SELECT pg_advisory_xact_lock($1,$2)', [lock, lock]);
			void queued.then(() => { queuedDone = true; }, () => { queuedDone = true; });
		};
		let lock = 0;
		try {
			const graph = await f.snapshot();
			const input = { teamId: 'team', eventType: 'capacity.assignment.available', resourceId: 'same-disconnect-input', payload: { lanePurpose: 'workday' } };
			const original = structuredClone(input);
			release = await f.subscriber.subscribe('team', event => received.push(event));
			const first = await f.publisher.publish(input); await eventObserved(() => received.length === 1); expect(received).toEqual([first]);
			const earlier = await f.rows(), client = f.listenerClient();
			const identity = (await client.query('SELECT pg_backend_pid() AS pid, current_database() AS database, pg_listening_channels() AS channel')).rows;
			expect(identity).toHaveLength(1); expect(identity[0].database).toBe(f.name); expect(identity[0].channel).toBe('treeseed_session_events');
			expect(Number.isSafeInteger(identity[0].pid)).toBe(true); expect(identity[0].pid).toBeGreaterThan(0);
			const pid = identity[0].pid;
			const owners = (await f.left.pool.query("SELECT pid, datname, backend_start::text AS started FROM pg_stat_activity WHERE pid=$1 AND datname=$2 AND backend_type='client backend' AND pid<>pg_backend_pid()", [pid, f.name])).rows;
			expect(owners).toHaveLength(1); expect(owners[0].pid).toBe(pid); expect(owners[0].datname).toBe(f.name);
			expect(typeof owners[0].started).toBe('string'); expect(owners[0].started.length).toBeGreaterThan(0);
			lock = pid; holder = await f.left.pool.connect();
			await holder.query('BEGIN'); await holder.query('SELECT pg_advisory_xact_lock($1,$2)', [lock, lock]);
			f.listenerPool.once('acquire', holdRestoration);
			client.on('error', observeError); removeObserver = () => { client.removeListener('error', observeError); };
			// Signal ONLY the independently verified backend of THIS fresh owned
			// listener, rechecking exact database and original start against PID reuse.
			expect((await f.left.pool.query("SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE pid=$1 AND datname=$2 AND backend_start=$3::timestamptz AND backend_type='client backend' AND pid<>pg_backend_pid()", [pid, f.name, owners[0].started])).rows).toEqual([{ terminated: true }]);
			await eventObserved(() => errors.some(error => 'code' in error && error.code === '57P01'));
			// Signalling success alone is NOT termination or service release proof.
			await eventObserved(async () => (await f.left.pool.query('SELECT pid FROM pg_stat_activity WHERE pid=$1 AND datname=$2 AND backend_start=$3::timestamptz', [pid, f.name, owners[0].started])).rows.length === 0);
			await eventObserved(async () => (await f.right.pool.query("SELECT pid FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=$1) AND classid=$2::oid AND objid=$2::oid AND NOT granted", [f.name, lock])).rows.length === 1);
			expect(queued).toBeDefined(); expect(queuedDone).toBe(false);
			expect(await f.rows()).toEqual(earlier); expect(await f.snapshot()).toEqual(graph);
			const missed = await f.publisher.publish(input);
			// The replacement has not activated LISTEN; publication is independent.
			// Recover via the ORIGINAL durable list cursor, not fake callback replay.
			expect(received).toEqual([first]); expect(await f.subscriber.list('team', first.sequence)).toEqual([missed]);
			expect(await f.subscriber.list('team', first.sequence)).toEqual([missed]);
			const disconnected = await f.rows(); expect(disconnected).toHaveLength(earlier.length + 1);
			for (const row of earlier) expect(disconnected).toContainEqual(row);
			await holder.query('ROLLBACK'); holder.release(); holder = undefined;
			await eventObserved(() => queuedDone); await queued;
			releaseForeign = await f.subscriber.subscribe('foreign-team', event => foreign.push(event));
			const restored = (await f.listenerClient().query('SELECT pg_backend_pid() AS pid, current_database() AS database, pg_listening_channels() AS channel')).rows;
			expect(restored).toHaveLength(1); expect(restored[0].database).toBe(f.name); expect(restored[0].channel).toBe('treeseed_session_events'); expect(restored[0].pid).not.toBe(pid);
			const next = await f.publisher.publish(input); await eventObserved(() => received.length === 2);
			const other = await f.publisher.publish({ ...input, teamId: 'foreign-team' }); await eventObserved(() => foreign.length === 1);
			expect(received).toEqual([first, next]); expect(foreign).toEqual([other]);
			expect(await f.subscriber.list('team', first.sequence)).toEqual([missed, next]);
			expect(await f.subscriber.list('foreign-team', 0)).toEqual([other]);
			const after = await f.rows(); expect(after).toHaveLength(earlier.length + 3); for (const row of earlier) expect(after).toContainEqual(row);
			expect((await f.left.pool.query('SELECT * FROM session_events ORDER BY sequence')).rows).toEqual(after);
			expect(await f.snapshot()).toEqual(graph); expect(input).toEqual(original);
			release(); release(); releaseForeign(); releaseForeign();
			await eventObserved(() => f.listenerPool.totalCount === f.listenerPool.idleCount);
			expect((await f.listenerPool.query('SELECT pg_listening_channels() AS channel')).rows).toEqual([]);
		} finally {
			f.listenerPool.removeListener('acquire', holdRestoration);
			try { if (holder) await holder.query('ROLLBACK'); if (queued) await queued; }
			finally { holder?.release(); release?.(); releaseForeign?.(); try { await f.close(); } finally { removeObserver?.(); } }
		}
	}, 30_000);
	it('native acquired client aborted transaction rejects original LISTEN without leaked callbacks or pool custody and same service retry resumes independent durable delivery', async () => {
		const f = await sessionPostgres(), healthy: SessionEvent[] = [], denied: SessionEvent[] = [], retried: SessionEvent[] = [];
		let releaseHealthy: (() => void) | undefined, releaseDenied: (() => void) | undefined, releaseRetry: (() => void) | undefined;
		let setup: Promise<void> | undefined; const setupErrors: unknown[] = [];
		try {
			const graph = await f.snapshot();
			const input = { teamId: 'team', eventType: 'capacity.assignment.available', resourceId: 'same-listen-retry-input', payload: { lanePurpose: 'workday' } };
			const original = structuredClone(input);
			releaseHealthy = await f.subscriber.subscribe('team', event => healthy.push(event));
			const first = await f.publisher.publish(input); await eventObserved(() => healthy.length === 1);
			const earlier = await f.rows(), pool = f.trackedPool(), service = new SessionEventService(f.rightStore, pool);
			// pg emits acquire before resolving connect, and queues queries FIFO.
			// Only this fresh client receives real SQL before the ORIGINAL LISTEN.
			// No connect/query/notification/error response is intercepted or invented.
			pool.once('acquire', client => {
				setup = client.query('BEGIN; SELECT 1/0').then(
					() => { throw new Error('Native division by zero unexpectedly succeeded'); },
					error => { setupErrors.push(error); });
			});
			const [outcome] = await Promise.allSettled([service.subscribe('team', event => denied.push(event))]);
			if (outcome.status === 'fulfilled') releaseDenied = outcome.value;
			expect(setup).toBeDefined(); await setup;
			expect(setupErrors).toMatchObject([{ code: '22012' }]);
			expect(outcome.status).toBe('rejected');
			if (outcome.status === 'rejected') expect(outcome.reason).toMatchObject({ code: '25P02' });
			// Assert service cleanup before fixture safety release or any test ROLLBACK.
			await eventObserved(() => pool.totalCount === pool.idleCount);
			expect((await pool.query('SELECT 1 AS clean')).rows).toEqual([{ clean: 1 }]);
			expect((await pool.query('SELECT pg_listening_channels() AS channel')).rows).toEqual([]);
			expect(await f.rows()).toEqual(earlier); expect(await f.snapshot()).toEqual(graph);
			const second = await service.publish(input); await eventObserved(() => healthy.length === 2);
			expect(denied).toEqual([]); expect(healthy).toEqual([first, second]);
			releaseRetry = await service.subscribe('team', event => retried.push(event));
			expect(pool.totalCount - pool.idleCount).toBe(1);
			const third = await f.publisher.publish(input); await eventObserved(() => retried.length === 1 && healthy.length === 3);
			expect(retried).toEqual([third]); expect(healthy).toEqual([first, second, third]); expect(denied).toEqual([]);
			expect(await service.list('team', 0)).toEqual([first, second, third]);
			const after = await f.rows(); expect(after).toHaveLength(earlier.length + 2);
			for (const row of earlier) expect(after).toContainEqual(row);
			expect((await f.left.pool.query('SELECT * FROM session_events ORDER BY sequence')).rows).toEqual(after);
			expect(await f.snapshot()).toEqual(graph); expect(input).toEqual(original);
			releaseRetry(); releaseRetry(); releaseHealthy(); releaseHealthy();
			await eventObserved(() => pool.totalCount === pool.idleCount && f.listenerPool.totalCount === f.listenerPool.idleCount);
			expect((await pool.query('SELECT pg_listening_channels() AS channel')).rows).toEqual([]);
			expect((await f.listenerPool.query('SELECT pg_listening_channels() AS channel')).rows).toEqual([]);
		} finally {
			releaseDenied?.(); releaseRetry?.(); releaseHealthy?.();
			try { await setup; } finally { await f.close(); }
		}
	}, 30_000);
	it('independent native notifications retain exact durable team events deduplicate repeated notices and release the original database channel only after the final subscriber', async () => {
		const f = await sessionPostgres(), team: SessionEvent[] = [], foreign: SessionEvent[] = [];
		let releaseTeam: (() => void) | undefined, releaseForeign: (() => void) | undefined;
		try {
			const before = await f.snapshot();
			releaseTeam = await f.subscriber.subscribe('team', event => team.push(event));
			releaseForeign = await f.subscriber.subscribe('foreign-team', event => foreign.push(event));
			expect(f.listenerPool.totalCount - f.listenerPool.idleCount).toBe(1);
			const connections = await Promise.all([f.left, f.right].map(database => database.pool.query('SELECT pg_backend_pid() AS pid')));
			const listening = await f.listenerClient().query('SELECT pg_backend_pid() AS pid, pg_listening_channels() AS channel');
			expect(listening.rows).toHaveLength(1); expect(listening.rows[0].channel).toBe('treeseed_session_events');
			expect(new Set([...connections.map(result => result.rows[0].pid), listening.rows[0].pid]).size).toBe(3);
			const first = await f.publisher.publish({ teamId: 'team', eventType: 'capacity.assignment.available', resourceId: 'actual-event-input', payload: { lanePurpose: 'workday' } });
			await eventObserved(() => team.length === 1); expect(team).toEqual([first]);
			const other = await f.publisher.publish({ teamId: 'foreign-team', eventType: first.eventType, resourceId: 'foreign-input' });
			await eventObserved(() => foreign.length === 1); expect(foreign).toEqual([other]); expect(team).toEqual([first]);
			await f.left.pool.query('SELECT pg_notify($1,$2)', ['treeseed_session_events', String(first.sequence)]);
			const barrier = await f.publisher.publish({ teamId: 'team', eventType: first.eventType, resourceId: 'durable-barrier' });
			await eventObserved(() => team.length >= 2); expect(team).toEqual([first, barrier]);
			releaseTeam(); releaseTeam();
			expect(f.listenerPool.totalCount - f.listenerPool.idleCount).toBe(1);
			const stopped = await f.publisher.publish({ teamId: 'team', eventType: first.eventType, resourceId: 'after-team-release' });
			const foreignBarrier = await f.publisher.publish({ teamId: 'foreign-team', eventType: first.eventType, resourceId: 'remaining-subscriber' });
			await eventObserved(() => foreign.length >= 2); expect(foreign).toEqual([other, foreignBarrier]); expect(team).toEqual([first, barrier]);
			expect(await f.subscriber.list('team', 0)).toEqual([first, barrier, stopped]);
			expect(await f.subscriber.list('foreign-team', 0)).toEqual([other, foreignBarrier]);
			const rows = await f.rows(); expect(rows).toHaveLength(5);
			expect((await f.left.pool.query('SELECT * FROM session_events ORDER BY sequence')).rows).toEqual(rows);
			expect(await f.snapshot()).toEqual(before);
			releaseForeign(); releaseForeign();
			await eventObserved(() => f.listenerPool.totalCount === f.listenerPool.idleCount);
			expect((await f.listenerPool.query('SELECT pg_listening_channels() AS channel')).rows).toEqual([]);
			const later = await f.publisher.publish({ teamId: 'team', eventType: first.eventType, resourceId: 'after-final-release' });
			expect(await f.subscriber.list('team', stopped.sequence)).toEqual([later]);
			expect(team).toEqual([first, barrier]); expect(foreign).toEqual([other, foreignBarrier]);
		} finally { releaseTeam?.(); releaseForeign?.(); await f.close(); }
	}, 30_000);
	it('native event insert interruption retains all earlier durable history emits no false notification and original retry adds exactly one event without changing graph or finance', async () => {
		const f = await sessionPostgres(), received: SessionEvent[] = []; let release: (() => void) | undefined;
		try {
			release = await f.subscriber.subscribe('team', event => received.push(event));
			const input = { teamId: 'team', eventType: 'capacity.assignment.available', resourceId: 'same-retry-input', payload: { lanePurpose: 'workday' } };
			const original = structuredClone(input), first = await f.publisher.publish(input);
			await eventObserved(() => received.length === 1);
			const before = await f.rows(), graph = await f.snapshot();
			await f.left.pool.query(`CREATE FUNCTION interrupt_native_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated event insert interruption'; END $$;
				CREATE TRIGGER interrupt_native_event BEFORE INSERT ON session_events FOR EACH ROW EXECUTE FUNCTION interrupt_native_event();`);
			await expect(f.publisher.publish(input)).rejects.toThrow('isolated event insert interruption');
			expect(await f.rows()).toEqual(before); expect(received).toEqual([first]); expect(await f.snapshot()).toEqual(graph); expect(input).toEqual(original);
			await f.left.pool.query('DROP TRIGGER interrupt_native_event ON session_events; DROP FUNCTION interrupt_native_event();');
			const retry = await f.publisher.publish(input); await eventObserved(() => received.length === 2);
			expect(received).toEqual([first, retry]); expect(retry.sequence).toBeGreaterThan(first.sequence);
			const after = await f.rows(); expect(after).toHaveLength(before.length + 1); for (const row of before) expect(after).toContainEqual(row);
			expect(await f.subscriber.list('team', 0)).toEqual([first, retry]); expect(await f.snapshot()).toEqual(graph); expect(input).toEqual(original);
			release(); await eventObserved(() => f.listenerPool.totalCount === f.listenerPool.idleCount);
			expect((await f.listenerPool.query('SELECT pg_listening_channels() AS channel')).rows).toEqual([]);
		} finally { release?.(); await f.close(); }
	}, 30_000);
	it('actual native connection acquisition denial is not successful local fallback and retains healthy independent delivery without leaked callbacks or durable event loss', async () => {
		const f = await sessionPostgres(), healthy: SessionEvent[] = [], denied: SessionEvent[] = [];
		let releaseHealthy: (() => void) | undefined, releaseDenied: (() => void) | undefined;
		try {
			const graph = await f.snapshot();
			releaseHealthy = await f.subscriber.subscribe('team', event => healthy.push(event));
			const input = { teamId: 'team', eventType: 'capacity.assignment.available', resourceId: 'same-healthy-input' };
			const first = await f.publisher.publish(input); await eventObserved(() => healthy.length === 1);
			const missing = new URL(f.connectionString); missing.pathname = `/${f.name}_absent`;
			expect((await f.left.pool.query('SELECT datname FROM pg_database WHERE datname=$1', [`${f.name}_absent`])).rows).toEqual([]);
			const pool = f.trackedPool(missing.href), service = new SessionEventService(f.rightStore, pool);
			const [outcome] = await Promise.allSettled([service.subscribe('team', event => denied.push(event))]);
			if (outcome.status === 'fulfilled') releaseDenied = outcome.value;
			const second = await service.publish(input); await eventObserved(() => healthy.length === 2);
			expect(outcome.status).toBe('rejected');
			if (outcome.status === 'rejected') expect(outcome.reason).toMatchObject({ code: '3D000' });
			expect(denied).toEqual([]); expect(healthy).toEqual([first, second]); expect(pool.totalCount).toBe(0);
			expect(await service.list('team', 0)).toEqual([first, second]); expect(await f.rows()).toHaveLength(2);
			expect(await f.snapshot()).toEqual(graph);
			releaseHealthy(); await eventObserved(() => f.listenerPool.totalCount === f.listenerPool.idleCount);
			expect((await f.listenerPool.query('SELECT pg_listening_channels() AS channel')).rows).toEqual([]);
		} finally { releaseDenied?.(); releaseHealthy?.(); await f.close(); }
	}, 30_000);
});
