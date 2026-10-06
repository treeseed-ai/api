import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '../../../../../src/api/realtime/session-events.ts';
import { eventObserved, sessionPostgres } from './session-postgres-fixture.ts';

describe('native independent session registration custody', () => {
	it('one native listener preserves identical callback registrations independently through stale release retry and final durable channel cleanup', async () => {
		const f = await sessionPostgres(), received: SessionEvent[] = [], callback = (event: SessionEvent) => { received.push(event); };
		const releases: Array<() => void> = [];
		try {
			const before = await f.snapshot(), history = await f.rows();
			const input = { teamId: 'team', eventType: 'capacity.assignment.available', resourceId: 'same-callback-native-input' }, original = structuredClone(input);
			const first = await f.subscriber.subscribe('team', callback), second = await f.subscriber.subscribe('team', callback); releases.push(first, second);
			expect(f.listenerPool.totalCount - f.listenerPool.idleCount).toBe(1);
			expect((await f.listenerClient().query('SELECT current_database() AS database, pg_listening_channels() AS channel')).rows).toEqual([{ database: f.name, channel: 'treeseed_session_events' }]);
			const one = await f.publisher.publish(input); await eventObserved(() => received.length === 2); expect(received).toEqual([one, one]);
			first(); first(); const two = await f.publisher.publish(input); await eventObserved(() => received.length === 3); expect(received).toEqual([one, one, two]);
			expect(f.listenerPool.totalCount - f.listenerPool.idleCount).toBe(1);
			second(); second(); await eventObserved(() => f.listenerPool.totalCount === f.listenerPool.idleCount);
			expect((await f.listenerPool.query('SELECT pg_listening_channels() AS channel')).rows).toEqual([]);
			const third = await f.subscriber.subscribe('team', callback); releases.push(third); first(); second();
			const three = await f.publisher.publish(input); await eventObserved(() => received.length === 4); expect(received).toEqual([one, one, two, three]);
			third(); third(); await eventObserved(() => f.listenerPool.totalCount === f.listenerPool.idleCount);
			expect((await f.listenerPool.query('SELECT pg_listening_channels() AS channel')).rows).toEqual([]);
			const four = await f.publisher.publish(input); expect(received).toEqual([one, one, two, three]);
			expect(await f.subscriber.list('team', one.sequence - 1)).toEqual([one, two, three, four]);
			const after = await f.rows(); expect(after).toHaveLength(history.length + 4); for (const row of history) expect(after).toContainEqual(row);
			expect((await f.left.pool.query('SELECT * FROM session_events ORDER BY sequence')).rows).toEqual(after);
			expect(await f.snapshot()).toEqual(before); expect(input).toEqual(original);
		} finally { for (const release of releases) release(); await f.close(); }
	}, 30_000);
});
