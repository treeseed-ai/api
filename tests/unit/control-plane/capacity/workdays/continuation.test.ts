import { describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { assignmentBelongsToRun, validateWorkdayContinuation, workdayContinuationHistory, workdayLineageSql } from '../../../../../src/api/capacity/services/capacity/workdays/scheduling/workday-continuation.ts';
import { workdayStartDatabase } from './scheduling/architecture/workday-start-fixture.ts';
import { settleCapacityReservationExactlyOnce } from '../../../../../src/api/capacity/services/capacity/accounting/settlement-service.ts';
import { assignmentAttemptSchema, assignmentResultSchema, executionNodeSchema } from '@treeseed/sdk/agent-capacity';
import { assignment } from '../execution/fixtures/assignment.ts';

const previous = { id: 'previous', team_id: 'team', execution_kind: 'workday', execution_mode: 'simulation',
	capacity_provider_id: 'provider', status: 'completed', parameters_json: JSON.stringify({ scheduledProjectIds: ['sdk'] }) };
const fixture = (rows = [previous]) => ({
	first: vi.fn(async (sql: string, values: unknown[]) => sql.includes('FROM capacity_workday_runs')
		? rows.find(row => row.id === values[1] && row.team_id === values[0]) ?? null : null),
	all: vi.fn(async () => [{ decision_id: 'decision', assignment_attempt_json: '{}' }]),
});
describe('settled workday continuation', () => {
	it('preserves canonical omitted node authority without admitting foreign decisions or changed source history', () => {
		const sourceRef = { store: 'postgresql', model: 'workday', id: 'source-workday' };
		const node = executionNodeSchema.parse({ schemaVersion: 'treeseed.execution-node/v1', id: 'planning-node', teamId: 'team', projectId: 'project',
			workdayId: 'next', kind: 'planning', pairRole: null, sourceRef, ruleRevision: 1, nodeRevision: 1, agentClass: 'renamed-planner', status: 'ready',
			estimate: { expectedSeconds: 1, maximumSeconds: 2 }, requiredCapabilities: [], requestedPermissions: { content: { read: [], write: [] }, tools: [] },
			workspace: 'read-only', graphRevisionCreated: 1, graphRevisionUpdated: 1 });
		const row = { work_day_id: 'previous', assignment_attempt_json: { sourceRef, authorityRefs: [sourceRef] } }, held = structuredClone({ node, row });
		for (const candidate of [node, { ...node, authorityRefs: [] }]) {
			expect(assignmentBelongsToRun(row, candidate, 'next', new Set(['previous']))).toBe(true);
			expect(assignmentBelongsToRun(row, candidate, 'next', new Set())).toBe(false);
			expect(assignmentBelongsToRun({ ...row, assignment_attempt_json: { sourceRef: { ...sourceRef, id: 'changed' }, authorityRefs: [sourceRef] } }, candidate, 'next', new Set(['previous']))).toBe(false);
			expect(assignmentBelongsToRun({ ...row, assignment_attempt_json: { sourceRef, authorityRefs: [{ store: 'postgresql', model: 'decision', id: 'foreign-decision' }] } }, candidate, 'next', new Set(['previous']))).toBe(false);
		}
		expect({ node, row }).toEqual(held);
	});
	it('native settled lineage and retained canonical attempt admit omitted node authority but reject changed source or decision readback without writes', async () => {
		const f = await workdayStartDatabase(); try {
			const at = f.intent.startsAt, sourceRef = { store: 'postgresql', model: 'workday', id: 'source-workday' };
			await f.query(`INSERT INTO capacity_workday_runs (id,team_id,capacity_provider_id,status,execution_kind,execution_mode,trigger_kind,parameters_json,created_at,updated_at)
				VALUES ('previous','team','provider','completed','workday','simulation','manual',?,?,?)`, ['{"scheduledProjectIds":["project"]}', at, at]);
			const attempt = assignmentAttemptSchema.parse({ ...structuredClone(assignment), id: 'old-attempt', idempotencyKey: 'old-attempt',
				workdayId: 'previous', sourceRef, authorityRefs: [sourceRef] });
			await f.query(`INSERT INTO capacity_provider_assignments (id,membership_id,team_id,project_id,capacity_provider_id,project_agent_class_id,work_day_id,mode,
				status,lease_state,attempt_count,assignment_attempt_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
				['old-attempt', 'membership', 'team', 'project', 'provider', 'class', 'previous', 'planning', 'completed', 'released', 1, JSON.stringify(attempt), at, at]);
			const node = executionNodeSchema.parse({ schemaVersion: 'treeseed.execution-node/v1', id: 'planning-node', teamId: 'team', projectId: 'project',
				workdayId: 'next', kind: 'planning', pairRole: null, sourceRef, ruleRevision: 1, nodeRevision: 1, agentClass: 'renamed-planner', status: 'ready',
				estimate: { expectedSeconds: 1, maximumSeconds: 2 }, requiredCapabilities: [], requestedPermissions: { content: { read: [], write: [] }, tools: [] },
				workspace: 'read-only', graphRevisionCreated: 1, graphRevisionUpdated: 1 }), held = structuredClone(node);
			const history = new Set((await workdayContinuationHistory(f.store, 'team', 'previous', 'simulation', 'provider')).map(row => String(row.id)));
			const baseline = await f.snapshot(), row = await f.first("SELECT * FROM capacity_provider_assignments WHERE id='old-attempt'");
			if (!row) throw new Error('Original persisted attempt required');
			expect(assignmentBelongsToRun(row, node, 'next', history)).toBe(true);
			for (const changed of [{ ...attempt, sourceRef: { ...sourceRef, id: 'changed' } },
				{ ...attempt, authorityRefs: [{ store: 'postgresql', model: 'decision', id: 'foreign-decision' }] }]) {
				await f.query("UPDATE capacity_provider_assignments SET assignment_attempt_json=? WHERE id='old-attempt'", [JSON.stringify(changed)]);
				const before = await f.snapshot(), supplied = await f.first("SELECT * FROM capacity_provider_assignments WHERE id='old-attempt'");
				if (!supplied) throw new Error('Retained changed input required');
				expect(assignmentBelongsToRun(supplied, node, 'next', history)).toBe(false); expect(await f.snapshot()).toEqual(before);
			}
			await f.query("UPDATE capacity_provider_assignments SET assignment_attempt_json=? WHERE id='old-attempt'", [JSON.stringify(attempt)]);
			expect(await f.snapshot()).toEqual(baseline); expect(node).toEqual(held); expect(f.calls).toEqual([]);
			// Real original SQL/lineage/predicate with controlled canonical inputs;
			// not a genuinely executed previous attempt or governed continuation.
		} finally { await f.close(); }
	});
	it('native original settlement permits released returned history without rewriting its failed result and denies retained leases or unsettled reservations on the same immutable lineage', async () => {
		const f = await workdayStartDatabase(); try {
			const at = f.intent.startsAt, parameters = '{"scheduledProjectIds":["project"]}';
			await f.query(`INSERT INTO capacity_workday_runs
				(id,team_id,capacity_provider_id,status,execution_kind,execution_mode,trigger_kind,parameters_json,created_at,updated_at)
				VALUES ('returned-parent','team','provider','failed','workday','simulation','manual',?,?,?)`, [parameters, at, at]);
			const failed = assignmentResultSchema.parse({ schemaVersion: 'treeseed.assignment-result/v1', id: 'retained-failed-result',
				assignmentId: 'returned-attempt', status: 'failed', summary: 'Controlled failed history, not a fabricated execution receipt.',
				references: [], verification: [], usage: { elapsedSeconds: 1, native: { tokens: 7 } }, diagnostics: [], completedAt: at });
			const raw = JSON.stringify(failed);
			const frozen = assignmentAttemptSchema.parse({ ...structuredClone(assignment), id: 'returned-attempt', idempotencyKey: 'returned-attempt',
				workdayId: 'returned-parent', reservationId: 'returned-reservation', createdAt: at,
				deadline: new Date(Date.parse(at) + 3_000).toISOString() });
			await f.query(`INSERT INTO capacity_provider_assignments
				(id,membership_id,team_id,project_id,capacity_provider_id,project_agent_class_id,work_day_id,mode,status,lease_state,
				attempt_count,decision_id,assignment_result_json,assignment_attempt_json,returned_at,created_at,updated_at)
				VALUES ('returned-attempt','membership','team','project','provider','class','returned-parent','acting','returned','released',1,'decision',?,?,?,?,?)`, [raw, JSON.stringify(frozen), at, at, at]);
			await f.query(`INSERT INTO capacity_reservations
				(id,idempotency_key,admission_token,membership_id,capacity_provider_id,project_agent_class_id,assignment_id,mode,
				team_id,project_id,work_day_id,requested_seconds,reserved_seconds,created_at,updated_at)
				VALUES ('returned-reservation','returned-reservation','returned-admission','membership','provider','class','returned-attempt','acting',
				'team','project','returned-parent',3,3,?,?)`, [at, at]);
			await f.query("UPDATE capacity_provider_assignments SET reservation_id='returned-reservation' WHERE id='returned-attempt'");
			const unsettled = await f.snapshot();
			await expect(workdayContinuationHistory(f.store, 'team', 'returned-parent', 'simulation', 'provider'))
				.rejects.toMatchObject({ status: 409, code: 'workday_continuation_unsettled' });
			expect(await f.snapshot()).toEqual(unsettled);
			const input = { settlementKey: 'returned-settlement', teamId: 'team', membershipId: 'membership', reservationId: 'returned-reservation',
				assignmentId: 'returned-attempt', assignmentAttempt: 1, activeSeconds: 1, elapsedSeconds: 1,
				source: 'controlled-continuation-input', usageActual: { nativeUsage: { tokens: 7 }, inputTokens: 7 } };
			const heldInput = structuredClone(input), settled = await settleCapacityReservationExactlyOnce(f.store, input);
			expect(settled.replayed).toBe(false);
			const baseline = await f.snapshot();
			expect(baseline.reservations).toHaveLength(1); expect(baseline.reservations[0]).toMatchObject({ state: 'consumed', active_seconds: 1, elapsed_seconds: 1 });
			expect(baseline.usage).toHaveLength(1); expect(baseline.ledger).toHaveLength(1);
			const parent = baseline.workdays.find(row => row.id === 'returned-parent'); if (!parent) throw new Error('Exact retained parent required');
			expect(await workdayContinuationHistory(f.store, 'team', 'returned-parent', 'simulation', 'provider')).toEqual([parent]);
			await expect(validateWorkdayContinuation(f.store, 'team', 'returned-parent', 'simulation', 'provider', ['project'], ['decision'])).resolves.toBeUndefined();
			const overlapping = await Promise.all([workdayContinuationHistory(f.store, 'team', 'returned-parent', 'simulation', 'provider'),
				workdayContinuationHistory(f.store, 'team', 'returned-parent', 'simulation', 'provider')]);
			expect(overlapping).toEqual([[parent], [parent]]); expect(await f.snapshot()).toEqual(baseline);
			const denials = [
				["UPDATE capacity_provider_assignments SET lease_state='leased' WHERE id='returned-attempt'", "UPDATE capacity_provider_assignments SET lease_state='released' WHERE id='returned-attempt'"],
				["UPDATE capacity_provider_assignments SET lease_token='retained-token' WHERE id='returned-attempt'", "UPDATE capacity_provider_assignments SET lease_token=NULL WHERE id='returned-attempt'"],
				["UPDATE capacity_provider_assignments SET status='running' WHERE id='returned-attempt'", "UPDATE capacity_provider_assignments SET status='returned' WHERE id='returned-attempt'"],
				["UPDATE capacity_reservations SET state='consuming' WHERE id='returned-reservation'", "UPDATE capacity_reservations SET state='consumed' WHERE id='returned-reservation'"],
			];
			for (const [change, restore] of denials) {
				await f.query(change!); const changed = await f.snapshot();
				await expect(workdayContinuationHistory(f.store, 'team', 'returned-parent', 'simulation', 'provider'))
					.rejects.toMatchObject({ status: 409, code: 'workday_continuation_unsettled' });
				expect(await f.snapshot()).toEqual(changed); await f.query(restore!); expect(await f.snapshot()).toEqual(baseline);
			}
			const replay = await settleCapacityReservationExactlyOnce(f.store, input);
			expect(replay.replayed).toBe(true); expect(replay.entry).toEqual(settled.entry);
			expect(await f.snapshot()).toEqual(baseline); expect(input).toEqual(heldInput); expect(f.calls).toEqual([]);
			expect((await f.first("SELECT assignment_result_json FROM capacity_provider_assignments WHERE id='returned-attempt'"))?.assignment_result_json).toBe(raw);
			// Actual owning accounting/continuation and original migrated SQL; supplied
			// status/result/measurements are not native execution or accepted governance.
		} finally { await f.close(); }
	});
	it('retains each terminal custody status and the exact original sixty-four-record lineage while denying a sixty-fifth record or cycle', async () => {
		for (const status of ['completed', 'degraded', 'cancelled', 'failed']) {
			const input = { ...previous, status }, before = structuredClone(input), store = fixture([input]);
			expect(await workdayContinuationHistory(store, 'team', 'previous', 'simulation', 'provider')).toEqual([input]); expect(input).toEqual(before);
		}
		for (const size of [64, 65]) {
			const records = Array.from({ length: size }, (_, index) => ({ ...previous, id: `lineage-${index}`,
				parameters_json: JSON.stringify({ scheduledProjectIds: ['sdk'], ...(index + 1 < size ? { continueFromWorkdayId: `lineage-${index + 1}` } : {}) }) }));
			const before = structuredClone(records), store = fixture(records);
			if (size === 64) expect(await workdayContinuationHistory(store, 'team', 'lineage-0', 'simulation', 'provider')).toEqual(records);
			else await expect(workdayContinuationHistory(store, 'team', 'lineage-0', 'simulation', 'provider')).rejects.toMatchObject({ status: 409, code: 'workday_continuation_cycle' });
			expect(records).toEqual(before); expect(store.first.mock.calls.filter(([sql]) => sql.includes('FROM capacity_workday_runs'))).toHaveLength(64);
		}
		const cycle = ['cycle-a', 'cycle-b'].map((id, index) => ({ ...previous, id,
			parameters_json: JSON.stringify({ scheduledProjectIds: ['sdk'], continueFromWorkdayId: index === 0 ? 'cycle-b' : 'cycle-a' }) }));
		const before = structuredClone(cycle), store = fixture(cycle);
		await expect(workdayContinuationHistory(store, 'team', 'cycle-a', 'simulation', 'provider')).rejects.toMatchObject({ status: 409, code: 'workday_continuation_cycle' });
		expect(cycle).toEqual(before); expect(store.first.mock.calls.filter(([sql]) => sql.includes('FROM capacity_workday_runs'))).toHaveLength(2);
	});
	it('denies malformed persisted continuation parameters and parent identities instead of converting them into a settled root or another identifier', async () => {
		const malformed: unknown[] = [undefined, null, '', '{invalid', 'null', '[]', '1', '"retired"', {}, [],
			...['', ' ', null, false, 1, [], {}].map(continueFromWorkdayId => JSON.stringify({ scheduledProjectIds: ['sdk'], continueFromWorkdayId }))];
		for (const parameters_json of malformed) {
			const input = Object.assign({ ...previous }, { parameters_json }), before = structuredClone(input), store = fixture([input]);
			await expect(workdayContinuationHistory(store, 'team', 'previous', 'simulation', 'provider')).rejects.toMatchObject({ status: 409, code: 'workday_continuation_scope_invalid' });
			expect(input).toEqual(before);
			expect(store.first.mock.calls.filter(([sql]) => sql.includes('FROM capacity_workday_runs'))).toEqual([
				['SELECT * FROM capacity_workday_runs WHERE team_id=? AND id=?', ['team', 'previous']],
			]);
		}
	});
	it('native original continuation reader retains exact terminal lineage bytes and rejects corrupt ancestry without writes or manufacturing settled authority', async () => {
		const f = await workdayStartDatabase(); try {
			const seed = async (id: string, parameters: string, status = 'completed') => f.query(`INSERT INTO capacity_workday_runs
				(id,team_id,capacity_provider_id,status,execution_kind,execution_mode,trigger_kind,parameters_json,created_at,updated_at)
				VALUES (?,'team','provider',?,'workday','simulation','manual',?,?,?)`, [id, status, parameters, f.intent.startsAt, f.intent.startsAt]);
			for (let index = 0; index < 64; index++) await seed(`native-lineage-${index}`, JSON.stringify({ scheduledProjectIds: ['project'],
				...(index + 1 < 64 ? { continueFromWorkdayId: `native-lineage-${index + 1}` } : {}) }), ['completed', 'degraded', 'cancelled', 'failed'][index % 4]!);
			const malformed = ['', '{invalid', 'null', '[]', '1', '"retired"',
				...['', ' ', null, false, 1, [], {}].map(continueFromWorkdayId => JSON.stringify({ scheduledProjectIds: ['project'], continueFromWorkdayId }))];
			for (const [index, parameters] of malformed.entries()) await seed(`native-corrupt-${index}`, parameters);
			await seed('native-over-bound', '{"scheduledProjectIds":["project"],"continueFromWorkdayId":"native-lineage-0"}');
			await seed('native-cycle-a', '{"scheduledProjectIds":["project"],"continueFromWorkdayId":"native-cycle-b"}');
			await seed('native-cycle-b', '{"scheduledProjectIds":["project"],"continueFromWorkdayId":"native-cycle-a"}');
			const before = await f.snapshot(), rows = await f.all('SELECT * FROM capacity_workday_runs ORDER BY id');
			const lineage = await workdayContinuationHistory(f.store, 'team', 'native-lineage-0', 'simulation', 'provider');
			expect(lineage).toEqual(Array.from({ length: 64 }, (_, index) => rows.find(row => row.id === `native-lineage-${index}`)));
			const outcomes = [];
			for (const [index] of malformed.entries()) {
				let error: unknown; try { await workdayContinuationHistory(f.store, 'team', `native-corrupt-${index}`, 'simulation', 'provider'); } catch (failure) { error = failure; }
				outcomes.push(error); expect(await f.snapshot()).toEqual(before); expect(f.calls).toEqual([]);
			}
			for (const outcome of outcomes) expect(outcome).toMatchObject({ status: 409, code: 'workday_continuation_scope_invalid' });
			await expect(workdayContinuationHistory(f.store, 'team', 'native-over-bound', 'simulation', 'provider')).rejects.toMatchObject({ status: 409, code: 'workday_continuation_cycle' });
			await expect(workdayContinuationHistory(f.store, 'team', 'native-cycle-a', 'simulation', 'provider')).rejects.toMatchObject({ status: 409, code: 'workday_continuation_cycle' });
			const repeated = await Promise.all([workdayContinuationHistory(f.store, 'team', 'native-lineage-0', 'simulation', 'provider'),
				workdayContinuationHistory(f.store, 'team', 'native-lineage-0', 'simulation', 'provider')]);
			expect(repeated).toEqual([lineage, lineage]); expect(await f.snapshot()).toEqual(before); expect(f.calls).toEqual([]);
			// Full original migrated PGlite/owning SQL reads, not independent PG
			// connections or genuine governance/accepted continuation production.
		} finally { await f.close(); }
	});
	it('enforces recursive lineage and team isolation in real PostgreSQL', async () => {
		const url = process.env.TREESEED_TEST_POSTGRES_URL;
		if (!url) throw new Error('TREESEED_TEST_POSTGRES_URL is required; native continuation coverage cannot be skipped.');
		const connection = new URL(url);
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
