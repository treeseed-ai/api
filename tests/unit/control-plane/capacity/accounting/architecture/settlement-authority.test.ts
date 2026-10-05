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
	it('denies every changed omitted or null diagnostic counter and accounting descriptor on the same usage identity', () => {
		const fields = [
			['inputTokens', 'input_tokens', 7], ['outputTokens', 'output_tokens', 3], ['cachedInputTokens', 'cached_input_tokens', 2],
			['reasoningTokens', 'reasoning_tokens', 1], ['quotaMinutes', 'quota_minutes', 0.25], ['wallMinutes', 'wall_minutes', 0.5],
			['filesOpened', 'files_opened', 4], ['filesChanged', 'files_changed', 2], ['diffLinesAdded', 'diff_lines_added', 9],
			['diffLinesRemoved', 'diff_lines_removed', 6], ['testRuns', 'test_runs', 2], ['retryCount', 'retry_count', 1],
			['executionProfileId', 'execution_profile_id', 'configured-profile'], ['businessModel', 'business_model', 'provider-native'],
		] as const;
		const usageActual = { ...input.usageActual, ...Object.fromEntries(fields.map(([field, , value]) => [field, value])) };
		const report = { ...input, usageDimension: 'diagnostic-0', accountingMode: 'informational' as const, activeSeconds: 0, elapsedSeconds: 0, usageActual };
		const exactIdentity = capacityUsageIdentity(report, reservation);
		const exact = { ...stored, id: exactIdentity.id, usage_dimension: 'diagnostic-0', accounting_mode: 'informational', active_seconds: 0, elapsed_seconds: 0,
			...Object.fromEntries(fields.map(([, column, value]) => [column, value])) };
		const before = structuredClone({ report, exact, exactIdentity });
		expect(() => assertCapacityUsageMatches(exact, report, exactIdentity)).not.toThrow();
		const outcomes = [];
		for (const [field, , value] of fields) for (const kind of ['changed', 'null', 'undefined', 'omitted']) {
			const changed = structuredClone(report), supplied: Record<string, unknown> = { ...changed.usageActual };
			if (kind === 'omitted') delete supplied[field];
			else supplied[field] = kind === 'null' ? null : kind === 'undefined' ? undefined : typeof value === 'number' ? value + 1 : 'foreign-accounting-descriptor';
			Object.assign(changed, { usageActual: supplied }); const immutable = structuredClone(changed);
			let code: unknown; try { assertCapacityUsageMatches(exact, changed, exactIdentity); }
			catch (error) { code = error instanceof Error && 'code' in error ? error.code : undefined; }
			outcomes.push(code); expect(changed).toEqual(immutable);
		}
		expect(outcomes).toEqual(Array(fields.length * 4).fill('capacity_usage_idempotency_conflict'));
		expect({ report, exact, exactIdentity }).toEqual(before);
	});
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
