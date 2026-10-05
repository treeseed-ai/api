import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createCapacityQueryOperations } from '../../../../../../src/api/control-plane/catalog/capacity/capacity.ts';
import { createCapacityQueryService } from '../../../../../../src/api/control-plane/repositories/capacity/capacity-query-service.ts';
import { OperationRegistry } from '../../../../../../src/api/control-plane/catalog/operation-registry.ts';
import { createProviderAssignmentService } from '../../../../../../src/api/control-plane/repositories/providers/provider-assignment-service.ts';
import { splitPostgresSqlStatements } from '../../../../../../src/api/persistence/postgres-sql-statements.ts';
import { frozenAttempt, settlementDatabase, terminalUsage } from './settlement-fixture.ts';

const operator = { id: 'isolated-operator', roles: ['admin'] };
const provider = { principal: { teamId: 'team', membershipId: 'membership', capacityProviderId: 'provider', scopes: ['provider:usage:write', 'provider:assignments:write'] } };
async function fixture() {
	const f = await settlementDatabase();
	try {
		const ddl = splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0000_control_plane.sql', 'utf8')).filter(sql => sql.startsWith('CREATE TABLE "projects" ('));
		if (ddl.length !== 1) throw new Error('Original projects DDL required'); await f.db.exec(ddl[0]!);
		await f.query('INSERT INTO projects (id,team_id,slug,name,created_at,updated_at) VALUES (?,?,?,?,?,?)', ['project', 'team', 'project', 'Isolated public accounting project', frozenAttempt.createdAt, frozenAttempt.createdAt]);
		await f.query('UPDATE capacity_provider_assignments SET reservation_id=? WHERE id=?', [frozenAttempt.reservationId, frozenAttempt.id]);
		const service = createProviderAssignmentService(f.owner as Parameters<typeof createProviderAssignmentService>[0]);
		const registry = new OperationRegistry(createCapacityQueryOperations({ capacityQueries: createCapacityQueryService(f.owner) }));
		const read = (operation: 'capacity.ledger' | 'capacity.usage', query: Record<string, unknown> = {}, principal: typeof operator | null = operator) =>
			registry.require(operation).handler({ path: { teamId: 'team' }, query: { projectId: 'project', workDayId: 'workday', limit: 100, ...query }, body: undefined },
				{ interface: 'rest', requestId: 'isolated-public-read', principal: principal ?? undefined });
		return { ...f, service, read };
	} catch (error) { await f.db.close(); throw error; }
}
// REAL supported operation -> authorization -> evidence repositories -> original
// SQL, with settlement first through the public provider service. Supplied
// principals/usage are INPUTS, not authenticated HTTP or external native charges.
describe('public all-attempt accounting record custody', () => {
	it('public diagnostic replay rejects every changed counter and descriptor while retaining original failed usage and terminal settlement', async () => {
		const f = await fixture();
		try {
			const fields = { inputTokens: 7, outputTokens: 3, cachedInputTokens: 2, reasoningTokens: 1, quotaMinutes: 0.25, wallMinutes: 0.5,
				filesOpened: 4, filesChanged: 2, diffLinesAdded: 9, diffLinesRemoved: 6, testRuns: 2, retryCount: 1,
				executionProfileId: 'configured-profile', businessModel: 'configured-native-business' };
			const usageActual = { ...terminalUsage.usageActual, ...fields };
			const body = { assignmentAttempt: frozenAttempt.attempt, usageDimension: 'diagnostic-0', accountingMode: 'informational',
				activeSeconds: 0, elapsedSeconds: 0, usageActual };
			const key = 'original-failed-diagnostic', before = structuredClone(body);
			await f.query('UPDATE capacity_provider_assignments SET status=?,assignment_attempt_json=? WHERE id=?',
				['failed', JSON.stringify({ ...frozenAttempt, status: 'failed' }), frozenAttempt.id]);
			const first = await f.service.reportUsage(provider, frozenAttempt.id, body, key);
			expect(first.replayed).toBe(false);
			const retained = (await f.query('SELECT * FROM capacity_usage_actuals')).rows;
			expect(retained).toHaveLength(1); expect(JSON.parse(String(retained[0]!.native_usage_json))).toEqual(usageActual.nativeUsage);
			const baseline = await f.snapshot(), outcomes = [];
			for (const [field, value] of Object.entries(fields)) for (const kind of ['changed', 'null', 'omitted']) {
				const supplied: Record<string, unknown> = { ...usageActual };
				if (kind === 'omitted') delete supplied[field]; else supplied[field] = kind === 'null' ? null : typeof value === 'number' ? value + 1 : 'foreign-accounting-descriptor';
				const changed = { ...body, usageActual: supplied }, immutable = structuredClone(changed);
				let code: unknown; try { await f.service.reportUsage(provider, frozenAttempt.id, changed, key); }
				catch (error) { code = error instanceof Error && 'code' in error ? error.code : undefined; }
				outcomes.push({ code, unchanged: JSON.stringify(await f.snapshot()) === JSON.stringify(baseline) }); expect(changed).toEqual(immutable);
			}
			// Observe every rejection before aggregate assertions; no malformed retry
			// may be relabelled successful simply because the old row survived.
			expect(outcomes).toEqual(Array(Object.keys(fields).length * 3).fill({ code: 'capacity_usage_idempotency_conflict', unchanged: true }));
			expect((await f.service.reportUsage(provider, frozenAttempt.id, structuredClone(body), key)).replayed).toBe(true);
			expect((await f.query('SELECT * FROM capacity_usage_actuals')).rows).toEqual(retained);
			await f.service.settle(provider, frozenAttempt.id, { ...terminalUsage, usageActual }, terminalUsage.settlementKey);
			const settled = await f.snapshot(), page = await f.read('capacity.usage');
			expect(page).toMatchObject({ items: expect.arrayContaining([
				expect.objectContaining({ accountingMode: 'informational', usageDimension: 'diagnostic-0', activeSeconds: 0, elapsedSeconds: 0, inputTokens: 7, nativeUsage: usageActual.nativeUsage }),
				expect.objectContaining({ accountingMode: 'aggregate', activeSeconds: 2, elapsedSeconds: 3, inputTokens: 7, nativeUsage: usageActual.nativeUsage }),
			]), page: { hasMore: false, nextCursor: null } });
			if (!page || typeof page !== 'object' || !('items' in page) || !Array.isArray(page.items)) throw new Error('Original public usage page required');
			expect(page.items).toHaveLength(2);
			await f.service.settle(provider, frozenAttempt.id, { ...terminalUsage, usageActual }, terminalUsage.settlementKey);
			expect(await f.snapshot()).toEqual(settled); expect(await f.read('capacity.usage')).toEqual(page); expect(body).toEqual(before);
			const diagnostic = (await f.query("SELECT * FROM capacity_usage_actuals WHERE usage_dimension='diagnostic-0'")).rows;
			expect(diagnostic).toEqual(retained); expect((await f.query('SELECT * FROM capacity_ledger_entries')).rows).toHaveLength(1);
		} finally { await f.db.close(); }
	});
	it('exposes one exact canonical settlement for completed and failed attempts without translating legacy ledger truth', async () => {
		const outcomes: unknown[] = [];
		for (const status of ['completed', 'failed']) {
			const f = await fixture();
			try {
				const attempt = { ...frozenAttempt, status }; await f.query('UPDATE capacity_provider_assignments SET status=?,assignment_attempt_json=? WHERE id=?', [status, JSON.stringify(attempt), attempt.id]);
				await f.service.settle(provider, attempt.id, { ...terminalUsage }, terminalUsage.settlementKey);
				const stable = await f.snapshot(), page = await f.read('capacity.ledger');
				outcomes.push(page); expect(await f.snapshot()).toEqual(stable);
				await f.service.settle(provider, attempt.id, { ...terminalUsage }, terminalUsage.settlementKey); expect(await f.read('capacity.ledger')).toEqual(page); expect(await f.snapshot()).toEqual(stable);
			} finally { await f.db.close(); }
		}
		// The supported page retains its operational ledger envelope. Its canonical
		// child must be the original stored record, not a read-time conversion.
		for (const page of outcomes) expect(page).toMatchObject({ items: [expect.objectContaining({ usageSettlement: { schemaVersion: 'treeseed.usage-settlement/v1',
			id: expect.any(String),
			idempotencyKey: terminalUsage.settlementKey, assignmentId: frozenAttempt.id, reservationId: frozenAttempt.reservationId,
			workdayId: frozenAttempt.workdayId, teamId: frozenAttempt.teamId, projectId: frozenAttempt.projectId, agentClass: frozenAttempt.agentClass,
			providerId: frozenAttempt.provider.providerId, actualSeconds: 2, nativeUsage: terminalUsage.usageActual!.nativeUsage, settledAt: expect.any(String) } })],
			page: { limit: 100, hasMore: false, nextCursor: null } });
	});
	it('denies absent malformed and moved stored canonical settlements without reconstructing or repairing retained financial history', async () => {
		const f = await fixture();
		try {
			await f.service.settle(provider, frozenAttempt.id, { ...terminalUsage }, terminalUsage.settlementKey);
			const rows = (await f.query('SELECT * FROM capacity_ledger_entries')).rows;
			expect(rows).toHaveLength(1); const entry = rows[0]!, original = JSON.parse(String(entry.metadata_json));
			const page = await f.read('capacity.ledger');
			expect(page).toMatchObject({ items: [expect.objectContaining({ usageSettlement: original.usageSettlement })] });
			expect(original.usageSettlement).toMatchObject({ id: entry.id, settledAt: entry.created_at, idempotencyKey: entry.settlement_key });
			const inputs = [undefined, null, {}, { ...original.usageSettlement, assignmentId: 'foreign' },
				{ ...original.usageSettlement, providerId: 'foreign' }, { ...original.usageSettlement, nativeUsage: { tokens: '7' } },
				{ ...original.usageSettlement, actualSeconds: 3 }, { ...original.usageSettlement, settledAt: '2026-01-01T00:00:00Z' }];
			for (const usageSettlement of inputs) {
				const supplied = JSON.stringify({ ...original, usageSettlement });
				await f.query('UPDATE capacity_ledger_entries SET metadata_json=? WHERE id=?', [supplied, entry.id]);
				const retained = await f.snapshot(); await expect(f.read('capacity.ledger')).rejects.toMatchObject({ code: 'capacity_ledger_entry_corrupt' });
				await expect(f.service.settle(provider, frozenAttempt.id, { ...terminalUsage }, terminalUsage.settlementKey)).rejects.toMatchObject({ code: 'capacity_ledger_entry_corrupt' });
				expect(await f.snapshot()).toEqual(retained);
			}
			await f.query('UPDATE capacity_ledger_entries SET metadata_json=? WHERE id=?', [entry.metadata_json, entry.id]);
			expect(await f.read('capacity.ledger')).toEqual(page); expect((await f.query('SELECT * FROM capacity_ledger_entries')).rows).toEqual(rows);
		} finally { await f.db.close(); }
	});
	it('reads supplied native measurements and distinct operational ledger authority without mutating financial or frozen assignment bytes', async () => {
		const f = await fixture();
		try {
			await f.service.settle(provider, frozenAttempt.id, { ...terminalUsage }, terminalUsage.settlementKey); const before = await f.snapshot();
			const usage = await f.read('capacity.usage'), ledger = await f.read('capacity.ledger');
			expect(usage).toMatchObject({ items: [expect.objectContaining({ assignmentId: frozenAttempt.id, assignmentAttempt: 1, activeSeconds: 2, elapsedSeconds: 3,
				nativeUsage: terminalUsage.usageActual!.nativeUsage })], page: { hasMore: false, nextCursor: null } });
			expect(ledger).toMatchObject({ items: [expect.objectContaining({ assignmentId: frozenAttempt.id, reservationId: frozenAttempt.reservationId })], page: { hasMore: false, nextCursor: null } });
			expect(await f.snapshot()).toEqual(before);
		} finally { await f.db.close(); }
	});
	it('denies absent operator and foreign project evidence before returning any settlement while retaining all original financial tables', async () => {
		const f = await fixture();
		try {
			await f.service.settle(provider, frozenAttempt.id, { ...terminalUsage }, terminalUsage.settlementKey); const before = await f.snapshot();
			for (const operation of ['capacity.usage', 'capacity.ledger'] as const) {
				await expect(f.read(operation, {}, null)).rejects.toMatchObject({ status: 401 });
				await expect(f.read(operation, { projectId: 'foreign-project' })).rejects.toMatchObject({ status: 404 });
				await expect(f.read(operation, { projectId: '' })).rejects.toMatchObject({ status: 400 });
			}
			expect(await f.snapshot()).toEqual(before);
		} finally { await f.db.close(); }
	});
	it('requires explicit scoped terminal pages and rejects malformed cursors rather than presenting a partial ledger as complete', async () => {
		const f = await fixture();
		try {
			await f.service.settle(provider, frozenAttempt.id, { ...terminalUsage }, terminalUsage.settlementKey); const before = await f.snapshot();
			for (const operation of ['capacity.usage', 'capacity.ledger'] as const) {
				await expect(f.read(operation, { cursor: 'malformed' })).rejects.toMatchObject({ status: 400 });
				expect(await f.read(operation, { workDayId: 'foreign-workday' })).toMatchObject({ items: [], page: { hasMore: false, nextCursor: null } });
				expect(await f.read(operation, { limit: 1 })).toMatchObject({ items: [expect.any(Object)], page: { limit: 1, hasMore: false, nextCursor: null } });
			}
			expect(await f.snapshot()).toEqual(before);
		} finally { await f.db.close(); }
	});
});
