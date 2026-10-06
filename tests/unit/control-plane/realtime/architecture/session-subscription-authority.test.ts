import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { ControlPlaneStore } from '../../../../../src/api/persistence/store.ts';
import { SessionEventService, type SessionEvent } from '../../../../../src/api/realtime/session-events.ts';

describe('declared pooled session subscription failure authority', () => {
	it('identical callback registrations retain independent release ownership without deleting their shared team or reviving a released registration', async () => {
		let sequence = 0;
		const store = new ControlPlaneStore({ TREESEED_ENVIRONMENT: 'test' }, {
			prepare: (sql: string) => ({ bind: () => ({ first: async () => sql.trimStart().startsWith('INSERT') ? {
				sequence: ++sequence, event_type: 'capacity.assignment.available', team_id: 'team', project_id: null,
				resource_id: 'same-callback-unit-input', payload_json: '{}', created_at: '2026-10-03T00:00:00.000Z',
			} : null, all: async () => ({ results: [] }), run: async () => { throw new Error('Unexpected subscription write'); } }) }),
		});
		store.initializationPromise = Promise.resolve();
		const service = new SessionEventService(store), received: SessionEvent[] = [], callback = (event: SessionEvent) => { received.push(event); };
		const first = await service.subscribe('team', callback), second = await service.subscribe('team', callback);
		let third: (() => void) | undefined;
		const input = { teamId: 'team', eventType: 'capacity.assignment.available', resourceId: 'same-callback-unit-input' }, original = structuredClone(input);
		try {
			const one = await service.publish(input); expect(received).toEqual([one, one]);
			first(); first(); const two = await service.publish(input); expect(received).toEqual([one, one, two]);
			second(); second(); third = await service.subscribe('team', callback); first(); second();
			const three = await service.publish(input); expect(received).toEqual([one, one, two, three]);
			third(); third(); await service.publish(input); expect(received).toEqual([one, one, two, three]); expect(input).toEqual(original);
		} finally { first(); second(); third?.(); }
	});
	it('concurrent first registrations remain pending through shared acquisition and LISTEN activation then route original team notifications and release only the last registration', async () => {
		const pool = new pg.Pool(), returnClient = vi.fn(), client = Object.assign(new pg.Client(), { release: returnClient });
		const result = { command: 'LISTEN', rowCount: null, oid: 0, fields: [], rows: [] };
		let acquire: (() => void) | undefined, activate: (() => void) | undefined;
		const acquisition = new Promise<typeof client>(resolve => { acquire = () => resolve(client); });
		const activation = new Promise<typeof result>(resolve => { activate = () => resolve(result); });
		const connect = vi.spyOn(pool, 'connect').mockImplementation(async () => acquisition);
		const query = vi.spyOn(client, 'query').mockImplementation(async sql => sql === 'LISTEN treeseed_session_events' ? activation : result);
		const rows = [1, 2, 3].map(sequence => ({ sequence, event_type: 'capacity.assignment.available', team_id: sequence === 2 ? 'foreign-team' : 'team',
			project_id: null, resource_id: 'same-activation-unit-input', payload_json: '{}', created_at: '2026-10-03T00:00:00.000Z' }));
		const original = structuredClone(rows); let reads = 0, writes = 0;
		const store = new ControlPlaneStore({ TREESEED_ENVIRONMENT: 'test' }, {
			prepare: (sql: string) => ({ bind: (...params: unknown[]) => ({ first: async () => {
				if (sql.trimStart().startsWith('INSERT')) { writes++; return rows[2]; }
				if (!sql.trimStart().startsWith('SELECT')) { writes++; throw new Error('Unexpected unit activation write'); }
				reads++; return rows.find(row => row.sequence === params[0]) ?? null;
			}, all: async () => ({ results: [] }), run: async () => { writes++; throw new Error('Unexpected unit activation cleanup write'); } }) }),
		});
		store.initializationPromise = Promise.resolve();
		const service = new SessionEventService(store, pool), first: SessionEvent[] = [], second: SessionEvent[] = [], foreign: SessionEvent[] = [];
		let pending: Promise<PromiseSettledResult<() => void>[]> | undefined, settled = 0, done = false; const releases: Array<() => void> = [];
		try {
			const registrations = [service.subscribe('team', event => first.push(event)), service.subscribe('team', event => second.push(event)), service.subscribe('foreign-team', event => foreign.push(event))];
			for (const registration of registrations) void registration.then(() => { settled++; }, () => { settled++; });
			pending = Promise.allSettled(registrations); void pending.then(() => { done = true; });
			expect(connect).toHaveBeenCalledTimes(1); expect(query).not.toHaveBeenCalled(); expect(settled).toBe(0); expect(writes).toBe(0);
			if (!acquire) throw new Error('Missing owned acquisition barrier'); acquire();
			await vi.waitFor(() => expect(query.mock.calls[0]?.[0]).toBe('LISTEN treeseed_session_events'));
			expect(query).toHaveBeenCalledTimes(1); expect(settled).toBe(0); expect(done).toBe(false); expect(returnClient).not.toHaveBeenCalled();
			expect(first).toEqual([]); expect(second).toEqual([]); expect(foreign).toEqual([]); expect(reads).toBe(0); expect(writes).toBe(0);
			if (!activate) throw new Error('Missing owned LISTEN activation barrier'); activate(); await vi.waitFor(() => expect(done).toBe(true));
			for (const outcome of await pending) { expect(outcome.status).toBe('fulfilled'); if (outcome.status === 'fulfilled') releases.push(outcome.value); }
			expect(settled).toBe(3); expect(connect).toHaveBeenCalledTimes(1);
			client.emit('notification', { channel: 'treeseed_session_events', payload: '1' }); await vi.waitFor(() => expect(first).toHaveLength(1));
			expect(second).toEqual(first); expect(foreign).toEqual([]);
			for (const release of releases.slice(0, 2)) { release(); release(); } expect(returnClient).not.toHaveBeenCalled();
			client.emit('notification', { channel: 'treeseed_session_events', payload: '2' }); await vi.waitFor(() => expect(foreign).toHaveLength(1));
			const last = releases[2]; if (!last) throw new Error('Missing foreign activation registration'); last(); last();
			await vi.waitFor(() => expect(returnClient).toHaveBeenCalledTimes(1));
			expect(first.map(event => event.sequence)).toEqual([1]); expect(second).toEqual(first); expect(foreign.map(event => event.sequence)).toEqual([2]);
			expect(reads).toBe(2); expect(writes).toBe(0);
			await service.publish({ teamId: 'team', eventType: 'capacity.assignment.available', resourceId: 'same-activation-unit-input' });
			expect(first.map(event => event.sequence)).toEqual([1]); expect(second).toEqual(first); expect(foreign.map(event => event.sequence)).toEqual([2]);
			expect(writes).toBe(1); expect(rows).toEqual(original); expect(connect).toHaveBeenCalledTimes(1); expect(returnClient).toHaveBeenCalledTimes(1);
		} finally {
			acquire?.(); activate?.();
			try { if (pending) { await vi.waitFor(() => expect(done).toBe(true)); for (const outcome of await pending) if (outcome.status === 'fulfilled') outcome.value(); } for (const release of releases) release(); }
			finally { query.mockRestore(); connect.mockRestore(); await client.end(); await pool.end(); }
		}
	});
	it('new same and foreign team registrations survive an in flight last unsubscribe channel cleanup and delayed old releases cannot remove current notification delivery', async () => {
		const pool = new pg.Pool(), returnOld = vi.fn(), returnNew = vi.fn();
		const old = Object.assign(new pg.Client(), { release: returnOld }), replacement = Object.assign(new pg.Client(), { release: returnNew });
		const result = { command: 'LISTEN', rowCount: null, oid: 0, fields: [], rows: [] };
		let finishCleanup: (() => void) | undefined, cleanupStarted = false;
		const cleanup = new Promise<typeof result>(resolve => { finishCleanup = () => resolve(result); });
		const oldQuery = vi.spyOn(old, 'query').mockImplementation(async sql => {
			if (typeof sql === 'string' && sql.startsWith('UNLISTEN') && !cleanupStarted) { cleanupStarted = true; return cleanup; }
			return result;
		});
		const newQuery = vi.spyOn(replacement, 'query').mockImplementation(async () => result);
		const connect = vi.spyOn(pool, 'connect').mockImplementationOnce(async () => old).mockImplementation(async () => replacement);
		const rows = [1, 2, 3, 4].map(sequence => ({ sequence, event_type: 'capacity.assignment.available', team_id: sequence === 3 ? 'foreign-team' : 'team',
			project_id: null, resource_id: 'same-inflight-unit-input', payload_json: '{}', created_at: '2026-10-03T00:00:00.000Z' }));
		const input = structuredClone(rows); let writes = 0, reads = 0;
		const store = new ControlPlaneStore({ TREESEED_ENVIRONMENT: 'test' }, {
			prepare: (sql: string) => ({ bind: (...params: unknown[]) => ({ first: async () => {
				if (sql.trimStart().startsWith('INSERT')) { writes++; return rows[3]; }
				if (!sql.trimStart().startsWith('SELECT')) { writes++; throw new Error('Unexpected unit lifecycle write'); }
				reads++; return rows.find(row => row.sequence === params[0]) ?? null;
			}, all: async () => ({ results: [] }), run: async () => { writes++; throw new Error('Unexpected unit lifecycle cleanup write'); } }) }),
		});
		store.initializationPromise = Promise.resolve();
		const service = new SessionEventService(store, pool), prior: SessionEvent[] = [], current: SessionEvent[] = [], foreign: SessionEvent[] = [];
		let releaseOld: (() => void) | undefined, pending: Promise<PromiseSettledResult<() => void>[]> | undefined, pendingDone = false;
		const releases: Array<() => void> = [];
		try {
			releaseOld = await service.subscribe('team', event => prior.push(event));
			old.emit('notification', { channel: 'treeseed_session_events', payload: '1' }); await vi.waitFor(() => expect(prior).toHaveLength(1));
			releaseOld(); releaseOld(); await vi.waitFor(() => expect(cleanupStarted).toBe(true));
			expect(returnOld).not.toHaveBeenCalled();
			pending = Promise.allSettled([service.subscribe('team', event => current.push(event)), service.subscribe('foreign-team', event => foreign.push(event))]);
			void pending.then(() => { pendingDone = true; });
			releaseOld(); releaseOld(); expect(writes).toBe(0);
			if (!finishCleanup) throw new Error('Missing owned unit cleanup barrier'); finishCleanup();
			await vi.waitFor(() => expect(pendingDone).toBe(true));
			const outcomes = await pending; for (const outcome of outcomes) if (outcome.status === 'fulfilled') releases.push(outcome.value);
			for (const outcome of outcomes) expect(outcome.status).toBe('fulfilled');
			// Either serialize/re-LISTEN on the retained client or release/reacquire.
			// Do not impose a new backend identity or parallel connection policy.
			expect(connect.mock.calls.length).toBeLessThanOrEqual(2);
			const carrier = connect.mock.calls.length === 1 ? old : replacement;
			if (carrier === old) expect(oldQuery.mock.calls.filter(call => call[0] === 'LISTEN treeseed_session_events').length).toBeGreaterThanOrEqual(2);
			else { expect(returnOld).toHaveBeenCalledTimes(1); expect(newQuery.mock.calls[0]?.[0]).toBe('LISTEN treeseed_session_events'); }
			releaseOld(); releaseOld(); carrier.emit('notification', { channel: 'treeseed_session_events', payload: '2' });
			await vi.waitFor(() => expect(current).toHaveLength(1));
			carrier.emit('notification', { channel: 'treeseed_session_events', payload: '3' }); await vi.waitFor(() => expect(foreign).toHaveLength(1));
			expect(prior.map(event => event.sequence)).toEqual([1]); expect(current.map(event => event.sequence)).toEqual([2]); expect(foreign.map(event => event.sequence)).toEqual([3]);
			for (const release of releases) { release(); release(); } releaseOld();
			await vi.waitFor(() => expect(returnOld.mock.calls.length + returnNew.mock.calls.length).toBe(connect.mock.calls.length));
			expect(reads).toBe(3); expect(writes).toBe(0);
			await service.publish({ teamId: 'team', eventType: 'capacity.assignment.available', resourceId: 'same-inflight-unit-input' });
			expect(prior.map(event => event.sequence)).toEqual([1]); expect(current.map(event => event.sequence)).toEqual([2]); expect(foreign.map(event => event.sequence)).toEqual([3]);
			expect(rows).toEqual(input); expect(writes).toBe(1);
		} finally {
			finishCleanup?.(); releaseOld?.();
			try { if (pending) { await vi.waitFor(() => expect(pendingDone).toBe(true)); for (const outcome of await pending) if (outcome.status === 'fulfilled') outcome.value(); } for (const release of releases) release(); }
			finally { oldQuery.mockRestore(); newQuery.mockRestore(); connect.mockRestore(); await old.end(); await replacement.end(); await pool.end(); }
		}
	});
	it('listener failure automatically reacquires one original channel for existing registrations without a new subscriber and stale failed client errors cannot release the replacement', async () => {
		const pool = new pg.Pool(), failure = new Error('controlled unit automatic listener recovery');
		const returnOld = vi.fn(), returnNew = vi.fn();
		const old = Object.assign(new pg.Client(), { release: returnOld }), replacement = Object.assign(new pg.Client(), { release: returnNew });
		const result = { command: 'LISTEN', rowCount: null, oid: 0, fields: [], rows: [] };
		const oldQuery = vi.spyOn(old, 'query').mockImplementation(async () => result);
		const newQuery = vi.spyOn(replacement, 'query').mockImplementation(async () => result);
		const connect = vi.spyOn(pool, 'connect').mockImplementationOnce(async () => old).mockImplementation(async () => replacement);
		const causes: Error[] = [], observe = (error: Error) => { causes.push(error); }; old.on('error', observe);
		const rows = [1, 2, 3].map(sequence => ({ sequence, event_type: 'capacity.assignment.available', team_id: sequence === 3 ? 'foreign-team' : 'team',
			project_id: null, resource_id: 'same-automatic-unit-input', payload_json: '{"lanePurpose":"workday"}', created_at: '2026-10-03T00:00:00.000Z' }));
		const input = structuredClone(rows); let writes = 0;
		const store = new ControlPlaneStore({ TREESEED_ENVIRONMENT: 'test' }, {
			prepare: (sql: string) => ({ bind: (...params: unknown[]) => ({ first: async () => {
				if (!sql.trimStart().startsWith('SELECT')) { writes++; throw new Error('Unexpected unit recovery write'); }
				return rows.find(row => row.sequence === params[0]) ?? null;
			}, all: async () => ({ results: [] }), run: async () => { writes++; throw new Error('Unexpected unit recovery cleanup write'); } }) }),
		});
		store.initializationPromise = Promise.resolve();
		const service = new SessionEventService(store, pool), first: SessionEvent[] = [], second: SessionEvent[] = [], foreign: SessionEvent[] = [];
		const releases: Array<() => void> = [];
		try {
			releases.push(await service.subscribe('team', event => first.push(event)));
			releases.push(await service.subscribe('team', event => second.push(event)));
			releases.push(await service.subscribe('foreign-team', event => foreign.push(event)));
			expect(connect).toHaveBeenCalledTimes(1);
			old.emit('notification', { channel: 'treeseed_session_events', payload: '1' });
			await vi.waitFor(() => expect(first).toHaveLength(1)); expect(second).toEqual(first); expect(foreign).toEqual([]);
			old.emit('error', failure);
			// NO subscribe call after failure: the service retains and repairs the
			// already admitted logical registrations through its original pool.
			await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
			await vi.waitFor(() => expect(newQuery.mock.calls[0]?.[0]).toBe('LISTEN treeseed_session_events'));
			expect(returnOld).toHaveBeenCalledTimes(1); expect(returnNew).not.toHaveBeenCalled();
			old.emit('error', failure); old.emit('error', failure);
			expect(causes).toEqual([failure, failure, failure]); expect(connect).toHaveBeenCalledTimes(2);
			replacement.emit('notification', { channel: 'treeseed_session_events', payload: '2' });
			await vi.waitFor(() => expect(first).toHaveLength(2)); expect(second).toEqual(first);
			replacement.emit('notification', { channel: 'treeseed_session_events', payload: '3' });
			await vi.waitFor(() => expect(foreign).toHaveLength(1));
			expect(first.map(event => event.sequence)).toEqual([1, 2]); expect(foreign.map(event => event.sequence)).toEqual([3]);
			for (const release of releases.slice(0, 2)) { release(); release(); }
			expect(returnNew).not.toHaveBeenCalled(); const last = releases[2]; if (!last) throw new Error('Missing original foreign registration'); last(); last();
			await vi.waitFor(() => expect(returnNew).toHaveBeenCalledTimes(1));
			old.emit('error', failure);
			expect(connect).toHaveBeenCalledTimes(2); expect(returnOld).toHaveBeenCalledTimes(1); expect(returnNew).toHaveBeenCalledTimes(1);
			expect(oldQuery.mock.calls[0]?.[0]).toBe('LISTEN treeseed_session_events'); expect(writes).toBe(0); expect(rows).toEqual(input);
		} finally {
			for (const release of releases) release(); old.removeListener('error', observe);
			oldQuery.mockRestore(); newQuery.mockRestore(); connect.mockRestore(); await old.end(); await replacement.end(); await pool.end();
		}
	});
	it('concurrent first subscriptions share one acquisition rejection cause remove every denied callback and healthy concurrent retry retains only its new registrations', async () => {
		const failure = new Error('controlled shared unit acquisition denial'), pool = new pg.Pool(), returnClient = vi.fn();
		const client = Object.assign(new pg.Client(), { release: returnClient });
		let deny: ((cause: Error) => void) | undefined;
		const acquisition = new Promise<typeof client>((_resolve, reject) => { deny = reject; });
		const connect = vi.spyOn(pool, 'connect').mockImplementationOnce(async () => acquisition).mockImplementation(async () => client);
		const query = vi.spyOn(client, 'query').mockImplementation(async () => ({ command: 'LISTEN', rowCount: null, oid: 0, fields: [], rows: [] }));
		let writes = 0;
		const input = { teamId: 'team', eventType: 'capacity.assignment.available', resourceId: 'same-shared-unit-input' }, original = structuredClone(input);
		const store = new ControlPlaneStore({ TREESEED_ENVIRONMENT: 'test' }, {
			prepare: (sql: string) => ({ bind: () => ({ first: async () => {
				if (sql.trimStart().startsWith('INSERT')) return { sequence: ++writes, event_type: input.eventType, team_id: input.teamId,
					project_id: null, resource_id: input.resourceId, payload_json: '{}', created_at: '2026-10-03T00:00:00.000Z' };
				return null;
			}, all: async () => ({ results: [] }), run: async () => { throw new Error('Unexpected unit cleanup write'); } }) }),
		});
		store.initializationPromise = Promise.resolve();
		const service = new SessionEventService(store, pool), denied: SessionEvent[][] = [[], [], []], retried: SessionEvent[][] = [[], [], []];
		const releases: Array<() => void> = [];
		let pending: Promise<PromiseSettledResult<() => void>[]> | undefined;
		try {
			pending = Promise.allSettled(denied.map(events => service.subscribe('team', event => events.push(event))));
			expect(connect).toHaveBeenCalledTimes(1); expect(query).not.toHaveBeenCalled(); expect(writes).toBe(0);
			if (!deny) throw new Error('Missing controlled acquisition rejection'); deny(failure);
			const outcomes = await pending;
			for (const outcome of outcomes) {
				expect(outcome).toEqual({ status: 'rejected', reason: failure });
				if (outcome.status === 'rejected') expect(outcome.reason).toBe(failure);
			}
			expect(returnClient).not.toHaveBeenCalled(); expect(connect).toHaveBeenCalledTimes(1);
			await service.publish(input); expect(denied).toEqual([[], [], []]); expect(writes).toBe(1);
			const retry = await Promise.allSettled(retried.map(events => service.subscribe('team', event => events.push(event))));
			for (const outcome of retry) if (outcome.status === 'fulfilled') releases.push(outcome.value);
			for (const outcome of retry) expect(outcome.status).toBe('fulfilled');
			expect(connect).toHaveBeenCalledTimes(2); expect(query).toHaveBeenCalledTimes(1);
			expect(query.mock.calls[0]?.[0]).toBe('LISTEN treeseed_session_events'); expect(writes).toBe(1);
			const second = await service.publish(input); expect(retried).toEqual([[second], [second], [second]]); expect(denied).toEqual([[], [], []]);
			for (const release of releases.slice(0, 2)) { release(); release(); }
			expect(returnClient).not.toHaveBeenCalled();
			const third = await service.publish(input); expect(retried).toEqual([[second], [second], [second, third]]);
			const last = releases[2]; if (!last) throw new Error('Missing third retry subscription'); last(); last();
			await vi.waitFor(() => expect(returnClient).toHaveBeenCalledTimes(1));
			await service.publish(input); expect(retried).toEqual([[second], [second], [second, third]]);
			expect(denied).toEqual([[], [], []]); expect(writes).toBe(4); expect(input).toEqual(original);
		} finally {
			deny?.(failure);
			try { if (pending) for (const outcome of await pending) if (outcome.status === 'fulfilled') outcome.value(); for (const release of releases) release(); }
			finally { query.mockRestore(); connect.mockRestore(); await client.end(); await pool.end(); }
		}
	});
	it('stale repeated last unsubscribe cannot remove a later same team subscription or revive the released callback during original local publication', async () => {
		let writes = 0;
		const input = { teamId: 'team', eventType: 'capacity.assignment.available', resourceId: 'same-unit-resubscription-input', payload: { lanePurpose: 'workday' } };
		const original = structuredClone(input);
		const store = new ControlPlaneStore({ TREESEED_ENVIRONMENT: 'test' }, {
			prepare: (sql: string) => ({ bind: () => ({ first: async () => {
				if (sql.trimStart().startsWith('INSERT')) return { sequence: ++writes, event_type: input.eventType, team_id: input.teamId,
					project_id: null, resource_id: input.resourceId, payload_json: JSON.stringify(input.payload), created_at: '2026-10-03T00:00:00.000Z' };
				return null;
			}, all: async () => ({ results: [] }), run: async () => { throw new Error('Unexpected unit event cleanup write'); } }) }),
		});
		store.initializationPromise = Promise.resolve();
		// No pool: this unit isolates the original callback ownership contract.
		// Controlled query rows are inputs, not native PostgreSQL delivery.
		const service = new SessionEventService(store), old: SessionEvent[] = [], current: SessionEvent[] = [];
		let releaseOld: (() => void) | undefined, releaseCurrent: (() => void) | undefined;
		try {
			releaseOld = await service.subscribe('team', event => old.push(event)); expect(writes).toBe(0);
			const first = await service.publish(input); expect(old).toEqual([first]);
			releaseOld(); releaseOld();
			releaseCurrent = await service.subscribe('team', event => current.push(event));
			expect(writes).toBe(1); expect(current).toEqual([]);
			// A delayed repeat belongs ONLY to the old subscription generation.
			releaseOld(); releaseOld();
			const second = await service.publish(input);
			expect(current).toEqual([second]); expect(old).toEqual([first]); expect(writes).toBe(2);
			releaseCurrent(); releaseCurrent(); releaseOld();
			await service.publish(input);
			expect(current).toEqual([second]); expect(old).toEqual([first]); expect(writes).toBe(3); expect(input).toEqual(original);
		} finally { releaseOld?.(); releaseCurrent?.(); }
	});
	it('listener error releases only the failed client retains registered callbacks and stale duplicate error cannot reset the healthy replacement after original subscription retry', async () => {
		const pool = new pg.Pool(), failure = new Error('controlled unit disconnected listener');
		const returnOld = vi.fn(), returnNew = vi.fn();
		const old = Object.assign(new pg.Client(), { release: returnOld }), replacement = Object.assign(new pg.Client(), { release: returnNew });
		const result = { command: 'LISTEN', rowCount: null, oid: 0, fields: [], rows: [] };
		const oldQuery = vi.spyOn(old, 'query').mockImplementation(async () => result);
		const newQuery = vi.spyOn(replacement, 'query').mockImplementation(async () => result);
		const connect = vi.spyOn(pool, 'connect').mockImplementationOnce(async () => old).mockImplementation(async () => replacement);
		const causes: Error[] = [], observe = (error: Error) => { causes.push(error); }; old.on('error', observe);
		const row = { sequence: 1, event_type: 'capacity.assignment.available', team_id: 'team', project_id: null,
			resource_id: 'controlled-reconnection-input', payload_json: '{}', created_at: '2026-10-03T00:00:00.000Z' };
		let writes = 0;
		const store = new ControlPlaneStore({ TREESEED_ENVIRONMENT: 'test' }, {
			prepare: (sql: string) => ({ bind: () => ({ first: async () => {
				if (sql.trimStart().startsWith('INSERT')) { writes++; return row; } return null;
			}, all: async () => ({ results: [] }), run: async () => { throw new Error('Unexpected unit cleanup write'); } }) }),
		});
		store.initializationPromise = Promise.resolve();
		const service = new SessionEventService(store, pool), first: SessionEvent[] = [], second: SessionEvent[] = [], third: SessionEvent[] = [];
		let releaseFirst: (() => void) | undefined, releaseSecond: (() => void) | undefined, releaseThird: (() => void) | undefined;
		try {
			releaseFirst = await service.subscribe('team', event => first.push(event));
			old.emit('error', failure);
			expect(causes).toEqual([failure]); expect(returnOld).toHaveBeenCalledTimes(1); expect(returnNew).not.toHaveBeenCalled();
			expect(writes).toBe(0);
			releaseSecond = await service.subscribe('team', event => second.push(event));
			expect(connect).toHaveBeenCalledTimes(2); expect(newQuery.mock.calls[0]?.[0]).toBe('LISTEN treeseed_session_events');
			old.emit('error', failure);
			releaseThird = await service.subscribe('team', event => third.push(event));
			expect(causes).toEqual([failure, failure]); expect(connect).toHaveBeenCalledTimes(2);
			expect(returnOld).toHaveBeenCalledTimes(1); expect(returnNew).not.toHaveBeenCalled();
			const event = await service.publish({ teamId: 'team', eventType: row.event_type, resourceId: row.resource_id });
			expect(first).toEqual([event]); expect(second).toEqual([event]); expect(third).toEqual([event]); expect(writes).toBe(1);
			releaseFirst(); releaseFirst(); releaseSecond(); releaseSecond(); releaseThird(); releaseThird();
			// Native UNLISTEN must complete before the healthy client is returned.
			// Observe the same exact release, not synchronous promise scheduling.
			await vi.waitFor(() => expect(returnNew).toHaveBeenCalledTimes(1)); expect(returnOld).toHaveBeenCalledTimes(1);
		} finally {
			releaseFirst?.(); releaseSecond?.(); releaseThird?.(); old.removeListener('error', observe);
			oldQuery.mockRestore(); newQuery.mockRestore(); connect.mockRestore(); await old.end(); await replacement.end(); await pool.end();
		}
	});
	it('acquired client LISTEN failure retains the original error returns exactly the acquired client and removes the denied callback before later local publication', async () => {
		const failure = new Error('controlled unit LISTEN failure'), pool = new pg.Pool();
		const releaseClient = vi.fn(), client = Object.assign(new pg.Client(), { release: releaseClient });
		const query = vi.spyOn(client, 'query').mockImplementation(async () => { throw failure; });
		const connect = vi.spyOn(pool, 'connect').mockImplementation(async () => client);
		let writes = 0;
		const row = { sequence: 1, event_type: 'capacity.assignment.available', team_id: 'team', project_id: null,
			resource_id: 'controlled-listen-input', payload_json: '{}', created_at: '2026-10-03T00:00:00.000Z' };
		const store = new ControlPlaneStore({ TREESEED_ENVIRONMENT: 'test' }, {
			prepare: (sql: string) => ({ bind: () => ({ first: async () => {
				if (sql.trimStart().startsWith('INSERT')) { writes++; return row; } return null;
			}, all: async () => ({ results: [] }), run: async () => { throw new Error('Unexpected unit cleanup write'); } }) }),
		});
		store.initializationPromise = Promise.resolve();
		const service = new SessionEventService(store, pool), received: SessionEvent[] = [];
		let release: (() => void) | undefined;
		try {
			const [outcome] = await Promise.allSettled([service.subscribe('team', event => received.push(event))]);
			if (outcome.status === 'fulfilled') release = outcome.value;
			expect(outcome).toEqual({ status: 'rejected', reason: failure });
			expect(connect).toHaveBeenCalledTimes(1); expect(query.mock.calls[0]?.[0]).toBe('LISTEN treeseed_session_events');
			expect(releaseClient).toHaveBeenCalledTimes(1); expect(writes).toBe(0);
			await service.publish({ teamId: 'team', eventType: row.event_type, resourceId: row.resource_id });
			expect(received).toEqual([]); expect(writes).toBe(1); expect(releaseClient).toHaveBeenCalledTimes(1);
		} finally { release?.(); query.mockRestore(); connect.mockRestore(); await client.end(); await pool.end(); }
	});
	it('declared database listener acquisition failure retains its original error removes the unacquired listener and never fabricates local subscription success', async () => {
		const failure = new Error('controlled unit pool acquisition failure'), pool = new pg.Pool();
		const connect = vi.spyOn(pool, 'connect').mockImplementation(async () => { throw failure; });
		let writes = 0;
		const row = { sequence: 1, event_type: 'capacity.assignment.available', team_id: 'team', project_id: null,
			resource_id: 'controlled-input', payload_json: '{}', created_at: '2026-10-03T00:00:00.000Z' };
		const store = new ControlPlaneStore({ TREESEED_ENVIRONMENT: 'test' }, {
			prepare: (query: string) => ({ bind: () => ({ first: async () => {
				if (query.trimStart().startsWith('INSERT')) { writes++; return row; } return null;
			}, all: async () => ({ results: [] }), run: async () => { throw new Error('Unexpected unit event cleanup write'); } }) }),
		});
		store.initializationPromise = Promise.resolve();
		const service = new SessionEventService(store, pool), received: SessionEvent[] = [];
		let release: (() => void) | undefined;
		try {
			const [outcome] = await Promise.allSettled([service.subscribe('team', event => received.push(event))]);
			if (outcome.status === 'fulfilled') release = outcome.value;
			expect(writes).toBe(0);
			await service.publish({ eventType: row.event_type, teamId: 'team', resourceId: row.resource_id });
			expect(outcome).toEqual({ status: 'rejected', reason: failure });
			expect(received).toEqual([]); expect(writes).toBe(1); expect(connect).toHaveBeenCalledTimes(1);
		} finally { release?.(); connect.mockRestore(); await pool.end(); }
	});
});
