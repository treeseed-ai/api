import { describe, expect, it } from 'vitest';
import { createProviderAssignmentService } from '../../../../../../src/api/control-plane/repositories/providers/provider-assignment-service.ts';
import { releaseCapacityReservationsExactlyOnce, settleCapacityReservationExactlyOnce } from '../../../../../../src/api/capacity/services/capacity/accounting/settlement-service.ts';
import { frozenAttempt, settlementDatabase, terminalUsage } from '../../../capacity/accounting/architecture/settlement-fixture.ts';
type ProviderStore = Parameters<typeof createProviderAssignmentService>[0];
const auth = { principal: { teamId: 'team', membershipId: 'membership', capacityProviderId: 'provider',
	scopes: ['provider:usage:write', 'provider:assignments:write'] } };
const zeroRelease = { ...terminalUsage, activeSeconds: 0, elapsedSeconds: 0, usageActual: undefined,
	existingSettlementPolicy: 'replay' as const, source: 'isolated-release-request' };
async function providerDatabase() {
	const fixture = await settlementDatabase();
	try {
		await fixture.query('UPDATE capacity_provider_assignments SET reservation_id=? WHERE id=?', ['reservation', frozenAttempt.id]);
		return fixture;
	} catch (error) { await fixture.db.close(); throw error; }
}
// REAL public provider service + owning accounting + original transactional SQL.
// Principal and measurements are fixture inputs, NOT authenticated HTTP/native provider generation.
// PGlite concurrent calls are not separate PostgreSQL connection concurrency.
describe('provider incremental terminal and release accounting through original SQL', () => {
	it('native original accounting denies every own retired mode-run value before changing any assignment reservation measurement counter or ledger and retains an unchanged original settlement retry', async () => {
		const { db, owner, snapshot, query } = await providerDatabase();
		try {
			const service = createProviderAssignmentService(owner as ProviderStore), before = await snapshot();
			for (const modeRunId of [undefined, null, '', 'retired-run', false, 0, {}, []]) {
				for (const kind of ['report', 'settle'] as const) {
					const body = { ...terminalUsage, usageDimension: kind === 'report' ? 'original-diagnostic' : 'aggregate',
						accountingMode: 'informational', modeRunId }, original = structuredClone(body);
					await expect(kind === 'report' ? service.reportUsage(auth, frozenAttempt.id, body, 'original-key')
						: service.settle(auth, frozenAttempt.id, body, 'original-key')).rejects.toMatchObject({ code: 'mode_run_contract_retired', status: 400 });
					expect(await snapshot()).toEqual(before); expect(body).toEqual(original); expect(Object.hasOwn(body, 'modeRunId')).toBe(true);
				}
			}
			const body = { ...structuredClone(terminalUsage) }, original = structuredClone(body);
			const first = await service.settle(auth, frozenAttempt.id, body, terminalUsage.settlementKey);
			expect(first.replayed).toBe(false);
			const settled = await snapshot();
			expect((await query('SELECT accounting_mode,active_seconds,elapsed_seconds FROM capacity_usage_actuals')).rows)
				.toEqual([{ accounting_mode: 'aggregate', active_seconds: 2, elapsed_seconds: 3 }]);
			expect((await query('SELECT COUNT(*) AS total FROM capacity_ledger_entries')).rows).toEqual([{ total: 1 }]);
			const retry = await service.settle(auth, frozenAttempt.id, body, terminalUsage.settlementKey);
			expect(retry.replayed).toBe(true); expect(await snapshot()).toEqual(settled); expect(body).toEqual(original);
		} finally { await db.close(); }
	});
	it('preserves incremental measurements and charges one aggregate across repeated concurrent public reports', async () => {
		const { db, owner, query } = await providerDatabase();
		try {
			const service = createProviderAssignmentService(owner as ProviderStore), before = structuredClone(terminalUsage);
			for (const dimension of ['checkpoint-a', 'checkpoint-b']) {
				const body = { assignmentAttempt: 1, usageDimension: dimension, accountingMode: 'incremental', activeSeconds: 1,
					elapsedSeconds: 1, usageActual: { ...terminalUsage.usageActual, inputTokens: 3, nativeUsage: { activeSeconds: 1, tokens: 3 } } };
				const responses = await Promise.all([service.reportUsage(auth, frozenAttempt.id, body, dimension),
					service.reportUsage(auth, frozenAttempt.id, body, dimension)]);
				expect(responses.filter(value => !value.replayed)).toHaveLength(1);
			}
			const results = await Promise.all([service.settle(auth, frozenAttempt.id, { ...terminalUsage }, terminalUsage.settlementKey),
				service.settle(auth, frozenAttempt.id, { ...terminalUsage }, terminalUsage.settlementKey)]);
			expect(results.filter(value => !value.replayed)).toHaveLength(1);
			expect((await query('SELECT accounting_mode,active_seconds FROM capacity_usage_actuals ORDER BY usage_dimension')).rows)
				.toEqual([{ accounting_mode: 'aggregate', active_seconds: 2 }, { accounting_mode: 'incremental', active_seconds: 1 }, { accounting_mode: 'incremental', active_seconds: 1 }]);
			expect((await query('SELECT COUNT(*) AS total FROM capacity_ledger_entries')).rows).toEqual([{ total: 1 }]);
			expect((await query("SELECT hard_limit,committed_amount FROM capacity_admission_counters WHERE id='seconds'")).rows)
				.toEqual([{ hard_limit: 3, committed_amount: 2 }]);
			expect(terminalUsage).toEqual(before);
		} finally { await db.close(); }
	});
	it('denies coerced public measurement or attempt values before any accounting row is committed', async () => {
		const outcomes: Array<{ denied: boolean; unchanged: boolean }> = [];
		for (const change of [{ activeSeconds: '2' }, { elapsedSeconds: '3' }, { assignmentAttempt: '1' }]) {
			const { db, owner, snapshot } = await providerDatabase();
			try {
				const before = await snapshot(); let denied = false;
				try { await createProviderAssignmentService(owner as ProviderStore).settle(auth, frozenAttempt.id,
					{ ...terminalUsage, ...change }, terminalUsage.settlementKey); } catch { denied = true; }
				outcomes.push({ denied, unchanged: JSON.stringify(await snapshot()) === JSON.stringify(before) });
			} finally { await db.close(); }
		}
		expect(outcomes).toEqual(Array(3).fill({ denied: true, unchanged: true }));
	});
	it('denies foreign provider ownership despite matching membership and preserves all accounting rows', async () => {
		const { db, owner, snapshot } = await providerDatabase();
		try {
			const before = await snapshot(); let denied = false;
			try { await createProviderAssignmentService(owner as ProviderStore).settle({ principal: { ...auth.principal,
				capacityProviderId: 'foreign-provider' } }, frozenAttempt.id, { ...terminalUsage }, terminalUsage.settlementKey); } catch { denied = true; }
			expect({ denied, unchanged: JSON.stringify(await snapshot()) === JSON.stringify(before) }).toEqual({ denied: true, unchanged: true });
		} finally { await db.close(); }
	});
	it('denies unknown or terminal nonterminal-report modes instead of silently storing informational usage', async () => {
		const outcomes: Array<{ denied: boolean; modes: unknown[] }> = [];
		for (const accountingMode of ['unknown', 'aggregate']) {
			const { db, owner, query } = await providerDatabase();
			try {
				let denied = false;
				try { await createProviderAssignmentService(owner as ProviderStore).reportUsage(auth, frozenAttempt.id,
					{ assignmentAttempt: 1, accountingMode, usageDimension: 'checkpoint', activeSeconds: 0, elapsedSeconds: 0,
						usageActual: terminalUsage.usageActual }, 'checkpoint-key'); } catch { denied = true; }
				outcomes.push({ denied, modes: (await query('SELECT accounting_mode FROM capacity_usage_actuals')).rows.map(row => row.accounting_mode) });
			} finally { await db.close(); }
		}
		expect(outcomes).toEqual(Array(2).fill({ denied: true, modes: [] }));
	});
	it('denies a terminal aggregate below measured incremental seconds while retaining those measurements', async () => {
		const { db, owner, query } = await providerDatabase();
		try {
			await createProviderAssignmentService(owner as ProviderStore).reportUsage(auth, frozenAttempt.id, {
				assignmentAttempt: 1, accountingMode: 'incremental', usageDimension: 'checkpoint', activeSeconds: 2, elapsedSeconds: 2,
				usageActual: terminalUsage.usageActual }, 'checkpoint');
			await expect(settleCapacityReservationExactlyOnce(owner, { ...terminalUsage, activeSeconds: 1 }))
				.rejects.toMatchObject({ code: 'capacity_usage_aggregate_underreported' });
			expect((await query('SELECT accounting_mode,active_seconds FROM capacity_usage_actuals')).rows)
				.toEqual([{ accounting_mode: 'incremental', active_seconds: 2 }]);
			expect((await query('SELECT COUNT(*) AS total FROM capacity_ledger_entries')).rows).toEqual([{ total: 0 }]);
			expect((await query('SELECT state,settlement_token FROM capacity_reservations')).rows)
				.toEqual([{ state: 'consuming', settlement_token: null }]);
		} finally { await db.close(); }
	});
	it('denies aggregate token underreporting rather than dropping known incremental provider counts', async () => {
		const { db, owner, query } = await providerDatabase();
		try {
			await createProviderAssignmentService(owner as ProviderStore).reportUsage(auth, frozenAttempt.id, {
				assignmentAttempt: 1, accountingMode: 'incremental', usageDimension: 'checkpoint', activeSeconds: 1, elapsedSeconds: 1,
				usageActual: { ...terminalUsage.usageActual, inputTokens: 8, nativeUsage: { tokens: 8 } } }, 'checkpoint');
			let denied = false; try { await settleCapacityReservationExactlyOnce(owner, terminalUsage); } catch { denied = true; }
			expect({ denied, aggregates: (await query("SELECT input_tokens,native_usage_json FROM capacity_usage_actuals WHERE accounting_mode='aggregate'")).rows })
				.toEqual({ denied: true, aggregates: [] });
		} finally { await db.close(); }
	});
	it('replays a cleanup release without replacing the prior real measured aggregate or charging again', async () => {
		const { db, owner, snapshot } = await providerDatabase();
		try {
			await settleCapacityReservationExactlyOnce(owner, terminalUsage); const before = await snapshot();
			const responses = await releaseCapacityReservationsExactlyOnce(owner, [zeroRelease, zeroRelease]);
			expect(responses.every(value => value.replayed)).toBe(true); expect(await snapshot()).toEqual(before);
		} finally { await db.close(); }
	});
	it('refuses zero cleanup settlement when accepted incremental work remains unaccounted', async () => {
		const { db, owner, query } = await providerDatabase();
		try {
			await createProviderAssignmentService(owner as ProviderStore).reportUsage(auth, frozenAttempt.id, {
				assignmentAttempt: 1, accountingMode: 'incremental', usageDimension: 'checkpoint', activeSeconds: 1, elapsedSeconds: 1,
				usageActual: terminalUsage.usageActual }, 'checkpoint');
			await expect(releaseCapacityReservationsExactlyOnce(owner, [zeroRelease])).rejects.toMatchObject({ code: 'capacity_usage_aggregate_underreported' });
			expect((await query("SELECT COUNT(*) AS total FROM capacity_usage_actuals WHERE accounting_mode='aggregate'")).rows).toEqual([{ total: 0 }]);
			expect((await query('SELECT COUNT(*) AS total FROM capacity_ledger_entries')).rows).toEqual([{ total: 0 }]);
		} finally { await db.close(); }
	});
	it('denies unauthenticated underscoped and foreign membership reports without changing original SQL', async () => {
		const { db, owner, snapshot } = await providerDatabase();
		try {
			const before = await snapshot(), service = createProviderAssignmentService(owner as ProviderStore);
			await expect(service.settle(null, frozenAttempt.id, { ...terminalUsage }, 'key')).rejects.toMatchObject({ status: 401 });
			await expect(service.settle({ principal: { ...auth.principal, scopes: [] } }, frozenAttempt.id, { ...terminalUsage }, 'key'))
				.rejects.toMatchObject({ status: 403 });
			await expect(service.settle({ principal: { ...auth.principal, membershipId: 'foreign-membership' } }, frozenAttempt.id, { ...terminalUsage }, 'key'))
				.rejects.toMatchObject({ status: 404 });
			expect(await snapshot()).toEqual(before);
		} finally { await db.close(); }
	});
	it('retains a matching incremental replay after settlement but denies new late usage without residue', async () => {
		const { db, owner, snapshot } = await providerDatabase();
		try {
			const service = createProviderAssignmentService(owner as ProviderStore);
			const checkpoint = { assignmentAttempt: 1, accountingMode: 'incremental', usageDimension: 'checkpoint', activeSeconds: 1,
				elapsedSeconds: 1, usageActual: terminalUsage.usageActual };
			await service.reportUsage(auth, frozenAttempt.id, checkpoint, 'checkpoint');
			await service.settle(auth, frozenAttempt.id, { ...terminalUsage }, terminalUsage.settlementKey); const before = await snapshot();
			expect((await service.reportUsage(auth, frozenAttempt.id, checkpoint, 'checkpoint')).replayed).toBe(true);
			await expect(service.reportUsage(auth, frozenAttempt.id, { ...checkpoint, usageDimension: 'late-checkpoint' }, 'late-checkpoint'))
				.rejects.toMatchObject({ code: 'capacity_usage_reporting_closed' });
			expect(await snapshot()).toEqual(before);
		} finally { await db.close(); }
	});
});
