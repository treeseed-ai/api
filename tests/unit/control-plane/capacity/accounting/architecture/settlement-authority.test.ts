import { describe, expect, it } from 'vitest';
import { assertCapacityUsageMatches, capacityUsageIdentity, capacityUsageInsertOperation,
	type CapacityUsageReportRequest } from '../../../../../../src/api/capacity/services/capacity/accounting/usage-report-service.ts';
import { frozenAttempt, terminalUsage } from './settlement-fixture.ts';

const input: CapacityUsageReportRequest = { ...terminalUsage, idempotencyKey: 'usage-key', usageDimension: 'aggregate', accountingMode: 'aggregate' };
const reservation = { assignment_attempt: 1, assignment_attempt_json: JSON.stringify(frozenAttempt), project_id: frozenAttempt.projectId,
	work_day_id: frozenAttempt.workdayId, capacity_provider_id: frozenAttempt.provider.providerId,
	project_agent_class_id: frozenAttempt.agentClass, execution_provider_id: frozenAttempt.provider.executionProviderId };
const identity = capacityUsageIdentity(input, reservation);
const stored = { id: identity.id, idempotency_key: identity.idempotencyKey, assignment_id: input.assignmentId,
	assignment_attempt: 1, usage_dimension: 'aggregate', accounting_mode: 'aggregate', active_seconds: 2, elapsed_seconds: 3,
	metadata_json: '{}', actual_usd: null, native_usage_json: JSON.stringify(input.usageActual!.nativeUsage),
	execution_provider_id: frozenAttempt.provider.executionProviderId, model_name: frozenAttempt.provider.modelConfigurationId };

// UNIT owning accounting functions: supplied frozen attempt/report/row, not actual consumption.
describe('immutable settlement measurement authority', () => {
	it('preserves exact arbitrary-class attempt and measured input while identifying one matching report', () => {
		const before = structuredClone({ input, reservation, stored });
		expect(identity).toEqual({ id: 'usage:assignment-report:1:aggregate', idempotencyKey: 'usage-key', assignmentAttempt: 1, usageDimension: 'aggregate' });
		expect(() => assertCapacityUsageMatches(stored, input, identity)).not.toThrow();
		capacityUsageInsertOperation(input, reservation, identity, { column: 'settlement_token', token: 'isolated-token' }, frozenAttempt.createdAt);
		expect({ input, reservation, stored }).toEqual(before);
	});
	it('denies changed durable attempt and scalar measurement on an otherwise identical retry', () => {
		expect(() => capacityUsageIdentity({ ...input, assignmentAttempt: 2 }, reservation)).toThrow(/does not match/u);
		expect(() => assertCapacityUsageMatches(stored, { ...input, activeSeconds: 3 }, identity)).toThrow(/different report/u);
	});
	it('denies coerced attempt identities rather than treating strings as the frozen attempt number', () => {
		expect(() => capacityUsageIdentity({ ...input, assignmentAttempt: '1' } as unknown as CapacityUsageReportRequest, reservation)).toThrow();
	});
	it('denies changed native measurement or provider model authority on an idempotent report', () => {
		const changes = [{ nativeUsage: { activeSeconds: 3, tokens: 7 } }, { nativeUsage: { activeSeconds: 2, tokens: 8 } },
			{ executionProviderId: 'foreign-provider' }, { modelName: 'foreign-model' }];
		const outcomes = changes.map(change => {
			try { assertCapacityUsageMatches(stored, { ...input, usageActual: { ...input.usageActual, ...change } }, identity); return 'ADMITTED'; }
			catch { return 'DENIED'; }
		});
		expect(outcomes).toEqual(changes.map(() => 'DENIED'));
	});
	it('denies incomplete frozen attempt authority before preparing terminal measurement persistence', () => {
		const invalid = [null, '{}', JSON.stringify({ ...frozenAttempt, effectiveProfile: undefined }),
			JSON.stringify({ ...frozenAttempt, provider: undefined })];
		const outcomes = invalid.map(value => {
			try { capacityUsageInsertOperation(input, { ...reservation, assignment_attempt_json: value }, identity,
				{ column: 'settlement_token', token: 'isolated-token' }, frozenAttempt.createdAt); return 'ADMITTED'; }
			catch { return 'DENIED'; }
		});
		expect(outcomes).toEqual(invalid.map(() => 'DENIED'));
	});
	it('denies malformed native measured units before they can become null or coerced stored values', () => {
		const invalid = [{ tokens: -1 }, { tokens: Infinity }, { tokens: NaN }, { tokens: '7' }, { tokens: null }];
		const outcomes = invalid.map(nativeUsage => {
			try { capacityUsageInsertOperation({ ...input, usageActual: { ...input.usageActual, nativeUsage } }, reservation, identity,
				{ column: 'settlement_token', token: 'isolated-token' }, frozenAttempt.createdAt); return 'ADMITTED'; }
			catch { return 'DENIED'; }
		});
		expect(outcomes).toEqual(invalid.map(() => 'DENIED'));
	});
	it('denies a first report substituting an execution provider outside the frozen selection', () => {
		expect(() => capacityUsageInsertOperation({ ...input, usageActual: { ...input.usageActual, executionProviderId: 'foreign-provider' } },
			reservation, identity, { column: 'settlement_token', token: 'isolated-token' }, frozenAttempt.createdAt)).toThrow();
	});
});
