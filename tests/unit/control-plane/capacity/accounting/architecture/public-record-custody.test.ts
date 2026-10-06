import { readFileSync } from 'node:fs';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCapacityQueryOperations } from '../../../../../../src/api/control-plane/catalog/capacity/capacity.ts';
import { createCapacityQueryService } from '../../../../../../src/api/control-plane/repositories/capacity/capacity-query-service.ts';
import { OperationRegistry } from '../../../../../../src/api/control-plane/catalog/operation-registry.ts';
import { createProviderAssignmentService } from '../../../../../../src/api/control-plane/repositories/providers/provider-assignment-service.ts';
import { splitPostgresSqlStatements } from '../../../../../../src/api/persistence/postgres-sql-statements.ts';
import { frozenAttempt, settlementDatabase, terminalUsage } from './settlement-fixture.ts';
import { workdayStartDatabase } from '../../workdays/scheduling/architecture/workday-start-fixture.ts';
import { upsertCapacityExecutionProviderOperations } from '../../../../../../src/api/capacity/repositories/capacity/providers/execution-provider.ts';
import { NativeCapacityService } from '../../../../../../src/api/capacity/services/capacity/capacity-core/native-capacity-service.ts';
import { serializeCapacityReservationRow } from '../../../../../../src/api/capacity/repositories/capacity/accounting/reservation.ts';

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
	it('native budget SQL and supplied reservation readback agree despite another provider reusing the execution identity and retain failed charges', async () => {
		const f = await workdayStartDatabase(); try {
			await f.db.exec(readFileSync('drizzle/control-plane/0008_capability_ontology.sql', 'utf8'));
			const at = f.intent.startsAt;
			for (const providerId of ['provider', 'foreign-provider']) {
				const publicJwk = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }), encoded = JSON.stringify(publicJwk);
				if (providerId === 'provider') await f.query('UPDATE capacity_providers SET public_jwk_json=?,fingerprint=? WHERE id=?', [encoded, createHash('sha256').update(encoded).digest('hex'), providerId]);
				else await f.query('INSERT INTO capacity_providers (id,fingerprint,public_jwk_json,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)',
					[providerId, createHash('sha256').update(encoded).digest('hex'), encoded, 'Other supplied provider', at, at]);
				const ids = providerId === 'provider' ? ['execution', 'other'] : ['execution'];
				await f.store.batch(upsertCapacityExecutionProviderOperations({ providerId, createdAt: at, executionProviders: ids.map(id => ({
					id, displayName: 'Configured supply', adapter: 'renamed-adapter', status: 'active', nativeUnit: 'token', quotaVisibility: 'exact', maxConcurrentRunners: 1,
					nativeLimits: [{ id: `limit-${id}`, executionProviderId: id, scope: 'daily', nativeUnit: 'token', limitAmount: 100,
						reserveBufferPercent: 10, confidence: 'high', source: 'configured', createdAt: at, updatedAt: at }],
				})) }));
			}
			await f.query('INSERT INTO capacity_provider_team_memberships (id,team_id,capacity_provider_id,approved_at,approved_by_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
				['foreign-membership', 'team', 'foreign-provider', at, 'operator', at, at]);
			for (const row of [
				{ id: 'local', providerId: 'provider', executionId: 'execution', state: 'reserved', reserved: 3, consumed: 0 },
				{ id: 'shared', providerId: 'provider', executionId: null, state: 'reserved', reserved: 2, consumed: 0 },
				{ id: 'failed', providerId: 'provider', executionId: 'execution', state: 'failed', reserved: 4, consumed: 4 },
				{ id: 'foreign', providerId: 'foreign-provider', executionId: 'execution', state: 'reserved', reserved: 70, consumed: 0 },
				{ id: 'other', providerId: 'provider', executionId: 'other', state: 'reserved', reserved: 50, consumed: 0 },
			]) await f.query(`INSERT INTO capacity_reservations (id,idempotency_key,admission_token,membership_id,capacity_provider_id,execution_provider_id,
				project_agent_class_id,mode,team_id,project_id,state,requested_seconds,reserved_seconds,native_unit,reserved_native_amount,consumed_native_amount,created_at,updated_at)
				VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [row.id, row.id, row.id, row.providerId === 'provider' ? 'membership' : 'foreign-membership',
				row.providerId, row.executionId, 'class', 'acting', 'team', 'project', row.state, 1, 1, 'token', row.reserved, row.consumed, at, at]);
			const raw = await f.all('SELECT * FROM capacity_reservations ORDER BY id'), reservations = raw.map(row => serializeCapacityReservationRow(row)!);
			const held = structuredClone(reservations), baseline = await f.snapshot(), service = new NativeCapacityService(f.store);
			const sql = await service.provider('team', 'provider', { now: at });
			expect(sql.entries.find(entry => entry.executionProviderId === 'execution')).toMatchObject({ activeReservedNativeAmount: 5,
				activeConsumedNativeAmount: 4, availableNativeAmount: 81 });
			expect(await service.provider('team', 'provider', { now: at, activeReservations: reservations })).toEqual(sql);
			expect(await service.provider('team', 'provider', { now: at })).toEqual(sql);
			expect(await f.snapshot()).toEqual(baseline); expect(await f.all('SELECT * FROM capacity_reservations ORDER BY id')).toEqual(raw);
			expect(reservations).toEqual(held);
			// Native owning SQL/service and public serializers; all seeded numbers
			// are controlled inputs, NOT generated execution/usage or settlement.
		} finally { await f.close(); }
	});
	it('native provider budget readback retains canonical SQL provider and adapter identity and denies foreign or suspended membership without financial writes', async () => {
		const f = await workdayStartDatabase(); try {
			await f.db.exec(readFileSync('drizzle/control-plane/0008_capability_ontology.sql', 'utf8'));
			// Actual allocated public key; this fixture does not issue credentials.
			const publicJwk = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' });
			await f.query('UPDATE capacity_providers SET public_jwk_json=?,fingerprint=? WHERE id=?',
				[JSON.stringify(publicJwk), createHash('sha256').update(JSON.stringify(publicJwk)).digest('hex'), 'provider']);
			const at = f.intent.startsAt, nativeLimits = [{ id: 'native-daily', executionProviderId: 'native-execution', scope: 'daily',
				nativeUnit: 'token', limitAmount: 100, reserveBufferPercent: 10, confidence: 'high', source: 'configured', createdAt: at, updatedAt: at }];
			const input = { providerId: 'provider', createdAt: at, executionProviders: [{ id: 'native-execution', displayName: 'Configured native supply',
				adapter: 'arbitrary-configured-adapter', status: 'active', nativeUnit: 'token', quotaVisibility: 'exact', maxConcurrentRunners: 1, nativeLimits }] };
			const held = structuredClone(input);
			await f.store.batch(upsertCapacityExecutionProviderOperations(input));
			const rows = await f.all('SELECT * FROM capacity_execution_providers ORDER BY id'), baseline = await f.snapshot();
			const service = new NativeCapacityService(f.store), result = await service.provider('team', 'provider', { now: at });
			expect(result).toMatchObject({ entries: [{ executionProviderId: 'native-execution', capacityProviderId: 'provider',
				executionProviderKind: 'arbitrary-configured-adapter', nativeUnit: 'token', configuredNativeLimit: 100,
				activeReservedNativeAmount: 0, activeConsumedNativeAmount: 0, availableNativeAmount: 90 }], availableNativeByUnit: { token: 90 } });
			expect(await service.provider('foreign-team', 'provider', { now: at })).toEqual({ entries: [], availableNativeByUnit: {} });
			expect(await service.provider('team', 'foreign-provider', { now: at })).toEqual({ entries: [], availableNativeByUnit: {} });
			expect(await service.provider('team', 'provider', { now: at })).toEqual(result);
			expect(await f.snapshot()).toEqual(baseline); expect(await f.all('SELECT * FROM capacity_execution_providers ORDER BY id')).toEqual(rows);
			await f.query("UPDATE capacity_provider_team_memberships SET status='suspended' WHERE id='membership'");
			const suspended = await f.first("SELECT * FROM capacity_provider_team_memberships WHERE id='membership'");
			expect(await service.provider('team', 'provider', { now: at })).toEqual({ entries: [], availableNativeByUnit: {} });
			expect(await f.first("SELECT * FROM capacity_provider_team_memberships WHERE id='membership'")).toEqual(suspended);
			expect(await f.snapshot()).toEqual(baseline); expect(await f.all('SELECT * FROM capacity_execution_providers ORDER BY id')).toEqual(rows); expect(input).toEqual(held);
		} finally { await f.close(); }
	});
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
