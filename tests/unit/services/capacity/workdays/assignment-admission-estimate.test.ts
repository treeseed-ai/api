import { describe,expect,it } from 'vitest';
import { capacityWorkdayContentBaseRef,capacityWorkdayRuntimeContentRef,estimateRequestedAgentSeconds,providerCompatibleRequestedSeconds } from '../../../../../src/api/capacity/services/build/demand-compiler.ts';

function store(rows: Record<string,unknown>[] = []) {
	return { all: async () => rows } as never;
}

function observedStore(rows: Record<string,unknown>[] = []) {
	const observations: Array<{ query: string; params: unknown[] }> = [];
	return {
		observations,
		store: { all: async (query: string, params: unknown[]) => { observations.push({ query, params }); return rows; } } as never,
	};
}

function successfulRow(activeSeconds: number, extra: Record<string,unknown> = {}) {
	const manifest = {
		schemaVersion: 1, assignmentId: 'assignment-a', modeRunId: 'mode-run-a', teamId: 'team-a', projectId: 'project-a',
		providerId: 'provider-a', mode: 'planning', agentClassId: 'class-research', agentId: 'researcher', handlerId: 'writer',
		activityType: 'planning', status: 'completed', summary: 'Produced the exact linked note.', toolEvents: [],
		contentReferences: [{ model: 'note', contentPath: 'src/content/notes/evidence.mdx', receiptId: 'receipt-a', toolEventId: 'tool-a', subjectId: 'objective:core', subjectField: 'relatedObjectives', artifactKind: 'planning_note' }],
		verification: [], citations: [], signals: [], usage: [], diagnostics: [], createdAt: '2026-08-14T12:00:00.000Z',
	};
	return { active_seconds: activeSeconds, lifecycle_output_json: JSON.stringify({ artifactManifest: manifest }), allowed_outputs_json: '{}', ...extra };
}

describe('assignment admission estimates', () => {
	it('keeps frozen definitions separate from exact current runtime content',()=>{
		const definition='a'.repeat(40); const runtime='b'.repeat(40);
		expect(capacityWorkdayRuntimeContentRef({contentBaseRef:runtime},definition)).toBe(runtime);
		expect(capacityWorkdayRuntimeContentRef({},definition)).toBe(definition);
		expect(()=>capacityWorkdayRuntimeContentRef({contentBaseRef:'refs/heads/staging'},definition)).toThrow('exact authoritative content commit');
	});

	it('pins projected agent definitions to their immutable TreeDX receipt', () => {
		const immutableRef = 'a'.repeat(40);
		expect(capacityWorkdayContentBaseRef('local', { base: 'staging' }, immutableRef)).toBe(immutableRef);
		expect(() => capacityWorkdayContentBaseRef('local', {}, 'refs/heads/staging')).toThrowError(expect.objectContaining({ code: 'capacity_workday_agent_source_ref_invalid' }));
	});

	it('prefers an explicit assignment request over every configured estimate', async () => {
		const result = await estimateRequestedAgentSeconds(store(), { activityType: 'planning', execution: { timeboxSeconds: 900, maxRuntimeSeconds: 1800 } }, { requestedSeconds: 420 });
		expect(result).toMatchObject({ seconds: 420, method: 'assignment-override' });
	});

	it('uses the activity-profile timebox when the assignment has no override', async () => {
		const result = await estimateRequestedAgentSeconds(store(), { activityType: 'planning', execution: { timeboxSeconds: 720, maxRuntimeSeconds: 1800 } }, {});
		expect(result).toMatchObject({ seconds: 720, method: 'activity-profile-timebox' });
	});

	it('raises a calibrated estimate to the provider minimum without exceeding the accepted timebox', () => {
		expect(providerCompatibleRequestedSeconds({
			estimatedSeconds: 376,
			sessionTimeboxSeconds: 600,
			minimumDurations: [{ amount: 600, unit: 'seconds' }],
			startedAt: '2026-08-14T12:00:00.000Z',
		})).toEqual({ requestedSeconds: 600, providerFloor: 600, floorSource: 'provider-declaration' });
		expect(() => providerCompatibleRequestedSeconds({
			estimatedSeconds: 376,
			sessionTimeboxSeconds: 300,
			minimumDurations: [{ amount: 600, unit: 'seconds' }],
			startedAt: '2026-08-14T12:00:00.000Z',
		})).toThrowError(expect.objectContaining({ code: 'capacity_provider_minimum_exceeds_assignment_timebox' }));
	});

	it('applies the selected lane minimum to productive time without counting protected windows', () => {
		expect(providerCompatibleRequestedSeconds({
			estimatedSeconds: 300,
			sessionTimeboxSeconds: 900,
			minimumDurations: [],
			minimumWindowSeconds: [600],
			startedAt: '2026-08-14T12:00:00.000Z',
		})).toEqual({ requestedSeconds: 600, providerFloor: 600, floorSource: 'provider-declaration' });
	});

	it('uses the accepted session timebox when provider supply omits a minimum', () => {
		expect(providerCompatibleRequestedSeconds({
			estimatedSeconds: 376,
			sessionTimeboxSeconds: 600,
			minimumDurations: [],
			startedAt: '2026-08-14T12:00:00.000Z',
		})).toEqual({ requestedSeconds: 600, providerFloor: 600, floorSource: 'accepted-timebox-fallback' });
	});

	it('uses comparable activity and context history with a bounded p90 recovery margin without choosing a provider', async () => {
		const rows = [100,200,300,400,500,600,700,800,900,1000].map((seconds) => successfulRow(seconds - 20, { elapsed_seconds: seconds, actual_usd: seconds / 1_000, metadata_json: JSON.stringify({ contextSizeBytes: 1_000 }) }));
		const observed = observedStore(rows);
		const result = await estimateRequestedAgentSeconds(observed.store, { activityType: 'planning', projectAgentClassId: 'class-research', execution: {} }, { contextSizeBytes: 1_200 });
		expect(result).toMatchObject({
			seconds: 1_080,
			method: 'buffered-historical-p90',
			sampleSize: 10,
			recommendations: { p90Seconds: 900, bufferedP90Seconds: 1_080 },
		});
		expect(result).not.toHaveProperty('executionProviderId');
		expect(result).not.toHaveProperty('model');
		expect(observed.observations).toEqual([expect.objectContaining({ params: ['class-research', 'planning'] })]);
		expect(observed.observations[0]?.query).toContain("assignment.status = 'completed'");
	});

	it('never reserves historical time beyond the selected profile hard runtime', async () => {
		const rows = [100,200,300,400,500,600,700,800,900,1000].map((seconds) => successfulRow(seconds));
		const result = await estimateRequestedAgentSeconds(store(rows), { activityType: 'planning', projectAgentClassId: 'class-research', execution: { maxRuntimeSeconds: 60 } }, {});
		expect(result).toMatchObject({
			seconds: 60,
			method: 'buffered-historical-p90',
			recommendations: { p90Seconds: 900, bufferedP90Seconds: 1_080, profileMaximumSeconds: 60 },
		});
	});

	it('does not learn a profile reservation from unrelated activity-only history', async () => {
		const result = await estimateRequestedAgentSeconds(store([{ active_seconds: 20 }]), { activityType: 'planning', execution: { maxRuntimeSeconds: 1_800 } }, {});
		expect(result).toMatchObject({ seconds: 1_800, method: 'conservative-profile-default', sampleSize: 0 });
	});

	it('falls back conservatively without enough comparable history', async () => {
		const result = await estimateRequestedAgentSeconds(store([successfulRow(20)]), { activityType: 'reviewing', projectAgentClassId: 'class-review', execution: { maxRuntimeSeconds: 1_200 } }, {});
		expect(result).toMatchObject({ seconds: 1_200, method: 'conservative-profile-default', sampleSize: 1 });
	});

	it('does not learn from process-completed history without a valid semantic artifact manifest', async () => {
		const rows = Array.from({ length: 8 }, (_, index) => ({ active_seconds: 120 + index, lifecycle_output_json: '{}', allowed_outputs_json: '{}' }));
		const result = await estimateRequestedAgentSeconds(store(rows), { activityType: 'planning', projectAgentClassId: 'class-research', execution: { maxRuntimeSeconds: 1_800 } }, {});
		expect(result).toMatchObject({ seconds: 1_800, method: 'conservative-profile-default', sampleSize: 0 });
	});
});
