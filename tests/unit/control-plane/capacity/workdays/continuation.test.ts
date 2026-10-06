import { describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { validateWorkdayContinuation, workdayContinuationHistory, workdayLineageSql } from '../../../../../src/api/capacity/services/capacity/workdays/scheduling/workday-continuation.ts';

const previous = { id: 'previous', team_id: 'team', execution_kind: 'workday', execution_mode: 'simulation',
	capacity_provider_id: 'provider', status: 'completed', parameters_json: JSON.stringify({ scheduledProjectIds: ['sdk'] }) };
const fixture = (rows = [previous]) => ({
	first: vi.fn(async (sql: string, values: unknown[]) => sql.includes('FROM capacity_workday_runs')
		? rows.find(row => row.id === values[1] && row.team_id === values[0]) ?? null : null),
	all: vi.fn(async () => [{ decision_id: 'decision', assignment_attempt_json: '{}' }]),
});
describe('settled workday continuation', () => {
	it.skipIf(!process.env.TREESEED_TEST_POSTGRES_URL)('enforces recursive lineage and team isolation in real PostgreSQL', async () => {
		const connection = new URL(process.env.TREESEED_TEST_POSTGRES_URL!);
		if (connection.hostname !== '127.0.0.1' || connection.pathname !== '/postgres') throw new Error('Explicit disposable loopback PostgreSQL required.');
		const client = new pg.Client({ connectionString: connection.href });
		await client.connect();
		try {
			await client.query('CREATE TEMP TABLE capacity_workday_runs (id text,team_id text,parameters_json text)');
			await client.query(`INSERT INTO capacity_workday_runs VALUES
				('old','team','{}'),('next','team','{"continueFromWorkdayId":"old"}'),
				('unrelated','team','{}'),('old','other','{}')`);
			const rows = await client.query(`SELECT id FROM capacity_workday_runs WHERE team_id=$1 AND id IN ${workdayLineageSql('$2', '$1')} ORDER BY id`, ['team','next']);
			expect(rows.rows.map(row => row.id)).toEqual(['next','old']);
			await client.query(`UPDATE capacity_workday_runs SET parameters_json='{"continueFromWorkdayId":"next"}' WHERE id='old' AND team_id='team'`);
			expect((await client.query(`SELECT * FROM ${workdayLineageSql('$2', '$1')} AS selected`, ['team','next'])).rowCount).toBe(2);
		} finally { await client.end(); }
	});
	it('derives a bounded exact lineage from existing records without another ledger', async () => {
		const parent = { ...previous, id: 'parent', parameters_json: JSON.stringify({ scheduledProjectIds: ['sdk'], continueFromWorkdayId: 'previous' }) };
		const store = fixture([parent, previous]);
		expect((await workdayContinuationHistory(store, 'team', 'parent', 'simulation', 'provider')).map(row => row.id)).toEqual(['parent', 'previous']);
		await expect(validateWorkdayContinuation(store, 'team', 'parent', 'simulation', 'provider', ['sdk'], ['decision'])).resolves.toBeUndefined();
		expect(store.all.mock.calls).toHaveLength(1);
	});
	it.each([
		['other team', { team_id: 'other' }], ['active', { status: 'running' }],
		['mode', { execution_mode: 'production' }], ['custody', { capacity_provider_id: 'other' }],
		['conversation', { execution_kind: 'conversation' }],
	])('rejects %s before any new assignment', async (_label, changes) => {
		await expect(workdayContinuationHistory(fixture([{ ...previous, ...changes }]), 'team', 'previous', 'simulation', 'provider'))
			.rejects.toMatchObject({ code: 'workday_continuation_scope_invalid' });
	});
	it('rejects retained leases, unsettled reservations, cycles, unknown decisions and project expansion', async () => {
		for (const table of ['capacity_provider_assignments','capacity_reservations']) {
			const store = fixture(); const first = store.first.getMockImplementation()!;
			store.first.mockImplementation(async (sql, values) => sql.includes(`FROM ${table}`) ? { ...previous } : first(sql, values));
			await expect(workdayContinuationHistory(store, 'team', 'previous', 'simulation')).rejects.toMatchObject({ code: 'workday_continuation_unsettled' });
		}
		await expect(workdayContinuationHistory(fixture([{ ...previous, parameters_json: '{"continueFromWorkdayId":"previous"}' }]), 'team', 'previous', 'simulation'))
			.rejects.toMatchObject({ code: 'workday_continuation_cycle' });
		await expect(validateWorkdayContinuation(fixture(), 'team', 'previous', 'simulation', 'provider', ['api'], ['decision']))
			.rejects.toMatchObject({ code: 'workday_continuation_projects_invalid' });
		await expect(validateWorkdayContinuation(fixture(), 'team', 'previous', 'simulation', 'provider', ['sdk'], ['new']))
			.rejects.toMatchObject({ code: 'workday_continuation_decision_invalid' });
	});
	it('uses the same recursive custody scope for predecessor lookup and atomic review-cycle limits', () => {
		expect(workdayLineageSql('node.workday_id', 'node.team_id')).toContain("child.parameters_json::jsonb->>'continueFromWorkdayId'");
		expect(workdayLineageSql('?', 'candidate.team_id')).toContain('parent.team_id=candidate.team_id');
	});
});
