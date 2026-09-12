import { describe, expect, it, vi } from 'vitest';
import { parsePublicWorkdayIntent, WorkdayPreflightService } from '../../../../../src/api/capacity/services/capacity/workdays/scheduling/workday-preflight-service.ts';

const input = () => ({ profileId: 'profile', projects: ['sdk'], startsAt: new Date().toISOString(), durationSeconds: 600, agentSelection: { agentSlugs: ['reviewer'], activityTypes: ['reviewing'] } });
function fixture() {
	let stored: any; let replay: any;
	const store = {
		ensureInitialized: vi.fn(async () => {}),
		all: vi.fn(async (sql: string) => sql.includes('capacity_provider_team_memberships') ? [{ capacity_provider_id: 'provider' }] : sql.includes('project_agent_classes') ? [{ id: 'class', slug: 'assurance' }] : []),
		first: vi.fn(async (sql: string) => sql.includes('capacity_allocation_sets') ? { id: 'allocation', version: 1 } : sql.includes("operation='workday.start'") ? replay : sql.includes("resource_type='workday_preflight'") ? { response_json: JSON.stringify(stored) } : null),
		run: vi.fn(async (_sql: string, args: unknown[]) => {
			if (args[2] === 'workday.preflight') stored = JSON.parse(String(args[7]));
			else replay = { request_digest: args[4], response_json: args[7] };
		}),
		preflightCapacityWorkdayRunRequest: vi.fn(async () => ({ availableSeconds: 600, planningParticipants: [{ nodeId: 'sdk:reviewer:reviewing', agentId: 'reviewer', projectAgentClassId: 'class', timeboxSeconds: 120 }], actingDemands: [] })),
		createCapacityWorkdayRun: vi.fn(async (_team: string, value: any) => ({ id: value.id, startedAt: value.startedAt })),
	};
	return { store, service: new WorkdayPreflightService(store as any), stored: () => stored };
}

describe('public workday selection custody', () => {
	it('freezes the admission time when an explicit start is omitted', () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date('2026-09-12T01:30:00.000Z'));
			const { startsAt: _startsAt, ...withoutStart } = input();
			expect(parsePublicWorkdayIntent('team', withoutStart).startsAt).toBe('2026-09-12T01:30:00.000Z');
		} finally {
			vi.useRealTimers();
		}
	});
	it('validates before normalization and preserves omitted selection', () => {
		const { agentSelection, ...unselected } = input();
		expect(parsePublicWorkdayIntent('team', unselected).agentSelection).toBeUndefined();
		for (const invalid of [{}, null, { agentSlugs: [] }, { agentSlugs: [''] }, { activityTypes: ['acting'] }]) expect(() => parsePublicWorkdayIntent('team', { ...input(), agentSelection: invalid })).toThrow(/invalid/u);
		expect(parsePublicWorkdayIntent('team', { ...input(), agentSelection: { ...agentSelection, agentSlugs: [' reviewer ', 'reviewer'] } }).agentSelection?.agentSlugs).toEqual(['reviewer']);
	});
	it('freezes selection, starts the exact plan, and replays without creating more work', async () => {
		const f = fixture(); const intent = parsePublicWorkdayIntent('team', input());
		const receipt = await f.service.preflight('team', intent, 'actor');
		expect(f.stored().runInput.parameters.agentSelection).toEqual(intent.agentSelection);
		expect(f.stored().runInput).toMatchObject({ executionMode: 'production', executionKind: 'workday', triggerKind: 'manual' });
		expect(receipt.selectedDemands.map(d => d.sourceId)).toEqual(['reviewer']);
		const request = { preflightId: receipt.id, preflightDigest: receipt.preflightDigest, idempotencyKey: 'start' };
		const started = await f.service.start('team', request, 'actor');
		expect(await f.service.start('team', request, 'actor')).toEqual(started);
		expect(f.store.createCapacityWorkdayRun).toHaveBeenCalledOnce();
		expect(f.store.createCapacityWorkdayRun.mock.calls[0]![1].parameters.agentSelection).toEqual(intent.agentSelection);
	});
	it('rejects an altered stored selector instead of compiling broader authority', async () => {
		const f = fixture(); const receipt = await f.service.preflight('team', parsePublicWorkdayIntent('team', input()), 'actor');
		delete f.stored().intent.agentSelection;
		await expect(f.service.start('team', { preflightId: receipt.id, preflightDigest: receipt.preflightDigest, idempotencyKey: 'start' }, 'actor')).rejects.toMatchObject({ code: 'workday_preflight_integrity_invalid' });
		expect(f.store.createCapacityWorkdayRun).not.toHaveBeenCalled();
	});
	it('never executes a modified stored run input', async () => {
		const f = fixture(); const receipt = await f.service.preflight('team', parsePublicWorkdayIntent('team', input()), 'actor');
		delete f.stored().runInput.parameters.agentSelection;
		await f.service.start('team', { preflightId: receipt.id, preflightDigest: receipt.preflightDigest, idempotencyKey: 'start' }, 'actor');
		expect(f.store.createCapacityWorkdayRun.mock.calls[0]![1].parameters.agentSelection.agentSlugs).toEqual(['reviewer']);
	});
});
