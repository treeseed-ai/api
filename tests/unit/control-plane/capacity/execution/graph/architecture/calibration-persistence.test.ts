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
		} finally { await fixture.db.close(); }
	});
});
