import { describe, expect, it } from 'vitest';
import { calculateAssignmentAllocation } from '@treeseed/sdk/agent-capacity';
import { calibrationDatabase } from './calibration-sql-fixture.ts';

describe('architecture calibration at original SQL and public SDK boundaries', () => {
	it('selects exactly the latest twenty eligible same-scope measurements without changing SQL or workday authority', async () => {
		const fixture = await calibrationDatabase();
		try {
			for (let index = 0; index < 21; index += 1) {
				await fixture.seed(`eligible-${String(index).padStart(2, '0')}`, index,
					index === 20 ? { status: 'failed', code: 'assignment_timeout', active: 600 } : {});
			}
			const denied = [
				{ capacityProvider: 'different-provider' }, { executionProvider: 'different-executor' },
				{ model: 'different-model' }, { capability: 'different-capability' },
				{ agentClass: 'different-class' }, { activity: 'different-activity' },
				{ accountingMode: 'incremental' }, { accountingMode: 'informational' },
				{ status: 'cancelled' }, { status: 'failed', code: 'credential_failure' },
				{ status: 'failed', code: 'infrastructure_failure' }, { status: 'failed', code: 'invalid_result' },
				{ status: 'failed', code: 'lease_expired' },
			];
			for (const [index, scope] of denied.entries()) await fixture.seed(`denied-${index}`, 100 + index, scope);
			const beforeInput = structuredClone(fixture.input);
			const tables = ['capacity_usage_actuals', 'capacity_provider_assignments', 'capacity_workday_runs', 'capacity_reservations', 'execution_nodes'];
			const beforeRows = await Promise.all(tables.map(async table => (await fixture.query(`SELECT * FROM ${table} ORDER BY id`)).rows));
			const result = (await fixture.calculate())[fixture.providerId]!;
			expect(result.measurements.map(({ id }) => id)).toEqual(Array.from({ length: 20 }, (_, index) =>
				`eligible-${String(20 - index).padStart(2, '0')}`));
			expect(result.measurements[0]).toMatchObject({ outcome: 'expired', expectedSeconds: 300, allocatedSeconds: 600, activeSeconds: 600 });
			expect(result.measurements.slice(1).every(row => row.outcome === 'completed')).toBe(true);
			expect(calculateAssignmentAllocation({ estimate: { expectedSeconds: 300, maximumSeconds: 600 },
				measurements: result.measurements, constraints: result.constraints })).toMatchObject({ desiredSeconds: 750,
				admitted: true, allocatedSeconds: 600, limitingConstraint: 'workday-phase-share' });
			expect(await fixture.calculate()).toEqual({ [fixture.providerId]: result });
			expect(fixture.input).toEqual(beforeInput);
			expect(await Promise.all(tables.map(async table => (await fixture.query(`SELECT * FROM ${table} ORDER BY id`)).rows))).toEqual(beforeRows);
		} finally { await fixture.db.close(); }
	});
	it('denies malformed selected estimate bytes rather than turning stored SQL history into an admitted deadline', async () => {
		const fixture = await calibrationDatabase();
		try {
			await fixture.seed('malformed-estimate', 0, { expected: 0 });
			const result = (await fixture.calculate())[fixture.providerId]!;
			expect(result.measurements).toHaveLength(1);
			expect(result.measurements[0]!.expectedSeconds).toBe(0);
			expect(() => calculateAssignmentAllocation({ estimate: { expectedSeconds: 300, maximumSeconds: 600 },
				measurements: result.measurements, constraints: result.constraints })).toThrow();
			expect((await fixture.query('SELECT assignment_attempt_json FROM capacity_provider_assignments WHERE id=?',
				['assignment-malformed-estimate'])).rows).toHaveLength(1);
			const originalRows = (await fixture.query('SELECT * FROM capacity_provider_assignments ORDER BY id')).rows;
			const originalUsage = (await fixture.query('SELECT * FROM capacity_usage_actuals ORDER BY id')).rows;
			const outcomes: Array<{ mode: string; denied: boolean }> = [];
			const malformed: Array<{ mode: string; id?: string; clock?: string; field?: string; value?: unknown }> = [
				{ mode: 'empty-id', id: '' }, { mode: 'space-id', id: ' ' }, { mode: 'padded-id', id: ' padded ' },
				{ mode: 'empty-clock', clock: '' }, { mode: 'invalid-clock', clock: 'not-a-clock' },
				{ mode: 'numeric-clock', clock: '0' }, { mode: 'date-only-clock', clock: '2026-10-02' },
			];
			for (const field of ['expectedSeconds', 'maximumSeconds']) for (const value of [undefined, null, '', '300', false, true, [], {}]) {
				malformed.push({ mode: `${field}:${JSON.stringify(value)}`, field, value });
			}
			for (const bad of malformed) {
				const attempt = { estimate: { expectedSeconds: 300 }, limits: { maximumSeconds: 600 },
					provider: { modelConfigurationId: fixture.input.providers[0]!.accountingLimits!.modelConfigurationId,
						executionCapabilityId: fixture.input.capabilityId }, effectiveProfile: { activity: fixture.input.activity } };
				if (bad.field === 'expectedSeconds') Object.assign(attempt.estimate, { expectedSeconds: bad.value });
				if (bad.field === 'maximumSeconds') Object.assign(attempt.limits, { maximumSeconds: bad.value });
				await fixture.query('UPDATE capacity_provider_assignments SET assignment_attempt_json=? WHERE id=?',
					[JSON.stringify(attempt), 'assignment-malformed-estimate']);
				await fixture.query('UPDATE capacity_usage_actuals SET id=?,created_at=? WHERE assignment_id=?',
					[bad.id ?? 'malformed-estimate', bad.clock ?? '2026-10-02T20:00:00.000Z', 'assignment-malformed-estimate']);
				const rows = (await fixture.query('SELECT * FROM capacity_provider_assignments ORDER BY id')).rows;
				const usage = (await fixture.query('SELECT * FROM capacity_usage_actuals ORDER BY id')).rows;
				const input = structuredClone(fixture.input); let denied = false;
				try {
					const selected = (await fixture.calculate())[fixture.providerId]!;
					calculateAssignmentAllocation({ estimate: { expectedSeconds: 300, maximumSeconds: 600 },
						measurements: selected.measurements, constraints: selected.constraints });
				} catch { denied = true; }
				outcomes.push({ mode: bad.mode, denied }); expect(fixture.input).toEqual(input);
				expect((await fixture.query('SELECT * FROM capacity_provider_assignments ORDER BY id')).rows).toEqual(rows);
				expect((await fixture.query('SELECT * FROM capacity_usage_actuals ORDER BY id')).rows).toEqual(usage);
			}
			// Restore only controlled SQL input; original malformed estimate and
			// its observation remain malformed, not repaired into passing history.
			await fixture.query('UPDATE capacity_provider_assignments SET assignment_attempt_json=? WHERE id=?',
				[originalRows.find(row => row.id === 'assignment-malformed-estimate')!.assignment_attempt_json, 'assignment-malformed-estimate']);
			await fixture.query('UPDATE capacity_usage_actuals SET id=?,created_at=? WHERE assignment_id=?',
				['malformed-estimate', originalUsage.find(row => row.id === 'malformed-estimate')!.created_at, 'assignment-malformed-estimate']);
			expect((await fixture.query('SELECT * FROM capacity_provider_assignments ORDER BY id')).rows).toEqual(originalRows);
			expect((await fixture.query('SELECT * FROM capacity_usage_actuals ORDER BY id')).rows).toEqual(originalUsage);
			expect(outcomes.every(value => value.denied), JSON.stringify(outcomes)).toBe(true);
		} finally { await fixture.db.close(); }
	});
});
