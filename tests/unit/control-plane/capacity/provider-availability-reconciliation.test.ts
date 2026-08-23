import { describe, expect, it } from 'vitest';
import { upsertCapacityExecutionProviderOperations } from '../../../../src/api/capacity/repositories/capacity/providers/execution-provider.ts';

describe('provider availability reconciliation', () => {
	it('pauses lanes and providers omitted from the authoritative snapshot', () => {
		const operations = upsertCapacityExecutionProviderOperations({
			providerId: 'provider-1', createdAt: '2026-08-23T00:00:00.000Z',
			executionProviders: [{ id: 'codex-local', status: 'active', lanes: [{ id: 'communication', purpose: 'communication' }] }],
		});
		expect(operations[0]?.query).toContain("status = 'unavailable'");
		expect(operations[0]?.params).toContain('codex-local');
		expect(operations[1]?.query).toContain("status = 'paused'");
		expect(operations[1]?.params).toContain('communication');
	});
});
