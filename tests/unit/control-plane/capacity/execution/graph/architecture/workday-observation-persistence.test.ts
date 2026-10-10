import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeCapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import { CapacityWorkdayEventRepository } from '../../../../../../../src/api/capacity/repositories/capacity/workdays/workday-event.ts';
import type { CapacityGovernanceDatabase } from '../../../../../../../src/api/capacity/database.ts';
import { createWorkdayService } from '../../../../../../../src/api/control-plane/repositories/capacity/workday-service.ts';
import { splitPostgresSqlStatements } from '../../../../../../../src/api/persistence/postgres-sql-statements.ts';
import { closeoutDatabase } from './closeout-sql-fixture.ts';
import { verifyNativeInventory } from '../../../../../../acceptance/execution-inventory.ts';

async function fixture() {
	const base = await closeoutDatabase();
	try {
		const ddl = splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0000_control_plane.sql', 'utf8'));
		for (const table of ['capacity_workday_events', 'workday_planning_sessions', 'workday_planning_waves']) {
			const statements = ddl.filter(sql => sql.startsWith(`CREATE TABLE "${table}" (`));
			if (statements.length !== 1) throw new Error(`Missing original DDL ${table}`);
			await base.db.exec(statements[0]!);
		}
		await base.db.exec(ddl.find(sql => sql.startsWith('CREATE UNIQUE INDEX "idx_capacity_workday_events_run_index"'))!);
		const events = new CapacityWorkdayEventRepository(base.store as unknown as CapacityGovernanceDatabase);
		const service = createWorkdayService({ ...base.store,
			getCapacityWorkdayRun: (team: string, run: string) => base.reads.get(team, run),
			listCapacityWorkdayEventsPage: events.list.bind(events) });
		return { ...base, events, service };
	} catch (error) { await base.db.close(); throw error; }
}
const principal = { id: 'isolated-authorized-reader', roles: ['admin'] };
describe('real workday observation service and original SQL event custody', () => {
	it('retains every event beyond the first show page through actual cursor reads without database mutation', async () => {
		const { db, query, events, service } = await fixture();
		try {
			for (let index = 0; index < 51; index++) await events.create('team', 'workday', {
				id: `event-${String(index).padStart(3, '0')}`, projectId: null, workdayId: 'workday', assignmentId: null,
				eventType: 'graph.revision', status: index === 50 ? 'failed' : 'recorded', title: null, message: null,
				parameters: {}, context: { graphRevision: index }, refs: {}, metadata: {}, createdAt: '2026-10-02T21:00:00Z' });
			const before = await query('SELECT * FROM capacity_workday_events ORDER BY event_index');
			const inventory = await verifyNativeInventory(before.rows, cursor => service.events(principal, 'team', 'workday', { cursor, limit: 50 }), 50, 'ascending');
			expect(inventory.map(event => event.eventIndex)).toEqual(Array.from({ length: 51 }, (_, index) => index));
			expect(inventory.at(-1)).toMatchObject({ id: 'event-050', status: 'failed' });
			const counters = await query('SELECT next_event_index FROM capacity_workday_runs');
			const shown = await service.show(principal, 'team', 'workday');
			expect(shown.events).toHaveLength(50); expect(shown.eventPage.hasMore).toBe(true);
			expect(decodeCapacityPageCursor(shown.eventPage.nextCursor)).toEqual({ id: 'event-049', createdAt: '2026-10-02T21:00:00Z' });
			expect(shown.scheduling).toMatchObject({ executionId: 'workday', status: 'running',
				executionMode: 'simulation', assignments: [{ status: 'completed', count: 1 }], nodes: [{ kind: 'reporting', status: 'completed', count: 1 }] });
			const next = await service.events(principal, 'team', 'workday', { cursor: shown.eventPage.nextCursor, limit: 50 });
			expect(next.items).toHaveLength(1); expect(next.items[0]).toMatchObject({ id: 'event-050', eventIndex: 50, status: 'failed' });
			expect(next.page).toEqual({ limit: 50, hasMore: false, nextCursor: null });
			expect([...shown.events, ...next.items].map(event => event.eventIndex)).toEqual(Array.from({ length: 51 }, (_, index) => index));
			const replays = await Promise.all([service.show(principal, 'team', 'workday'), service.show(principal, 'team', 'workday')]);
			expect(replays).toEqual([shown, shown]);
			expect(await query('SELECT * FROM capacity_workday_events ORDER BY event_index')).toEqual(before);
			expect(await query('SELECT next_event_index FROM capacity_workday_runs')).toEqual(counters);
		} finally { await db.close(); }
	});
	it('distinguishes observed empty scheduling from unavailable SQL and denies missing scope or malformed cursors', async () => {
		const { db, query, service } = await fixture();
		try {
			await query('DELETE FROM capacity_provider_assignments'); await query('DELETE FROM execution_nodes');
			const empty = await service.show(principal, 'team', 'workday');
			expect(empty.scheduling).toMatchObject({ status: 'running', assignments: [], nodes: [] });
			expect(empty.events).toEqual([]); expect(empty.eventPage).toEqual({ limit: 50, hasMore: false, nextCursor: null });
			await expect(service.show(undefined, 'team', 'workday')).rejects.toMatchObject({ status: 401 });
			await expect(service.show(principal, 'foreign-team', 'workday')).rejects.toMatchObject({ status: 404 });
			await expect(service.events(principal, 'team', 'missing-run', {})).rejects.toMatchObject({ status: 404 });
			await expect(service.events(principal, 'team', 'workday', { cursor: 'invalid' })).rejects.toMatchObject({ status: 400 });
			await db.exec('DROP TABLE workday_planning_sessions');
			const unavailable = await service.show(principal, 'team', 'workday');
			expect(unavailable.scheduling).toEqual({ executionId: 'workday', status: 'unavailable', code: 'communication_scheduling_diagnostics_unavailable' });
			expect(unavailable.scheduling).not.toHaveProperty('assignments');
			expect(unavailable.scheduling).not.toHaveProperty('nodes');
		} finally { await db.close(); }
	});
});
