import { describe,expect,it } from 'vitest';
import { estimateRequestedAgentSeconds } from '../../../../../src/api/capacity/services/build/demand-compiler.ts';

function store(rows: Record<string,unknown>[] = []) {
	return { all: async () => rows } as never;
}

describe('assignment admission estimates', () => {
	it('prefers an explicit assignment request over every configured estimate', async () => {
		const result = await estimateRequestedAgentSeconds(store(), { activityType: 'planning', execution: { timeboxSeconds: 900, maxRuntimeSeconds: 1800 } }, { requestedSeconds: 420 });
		expect(result).toMatchObject({ seconds: 420, method: 'assignment-override' });
	});

	it('uses the activity-profile timebox when the assignment has no override', async () => {
		const result = await estimateRequestedAgentSeconds(store(), { activityType: 'planning', execution: { timeboxSeconds: 720, maxRuntimeSeconds: 1800 } }, {});
		expect(result).toMatchObject({ seconds: 720, method: 'activity-profile-timebox' });
	});

	it('uses comparable provider, model, and context history at p90', async () => {
		const rows = [100,200,300,400,500,600,700,800,900,1000].map((seconds) => ({ active_seconds: seconds, execution_provider_id: 'codex', model_name: 'gpt', metadata_json: JSON.stringify({ contextSizeBytes: 1_000 }) }));
		const result = await estimateRequestedAgentSeconds(store(rows), { activityType: 'planning', execution: { providerPreference: ['codex'], model: 'gpt' } }, { contextSizeBytes: 1_200 });
		expect(result).toMatchObject({ seconds: 900, method: 'historical-p90', sampleSize: 10, executionProviderId: 'codex', model: 'gpt' });
	});

	it('falls back conservatively without enough comparable history', async () => {
		const result = await estimateRequestedAgentSeconds(store([{ active_seconds: 20 }]), { activityType: 'reviewing', execution: { maxRuntimeSeconds: 1_200 } }, {});
		expect(result).toMatchObject({ seconds: 1_200, method: 'conservative-profile-default', sampleSize: 1 });
	});
});
