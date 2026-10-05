import { describe, expect, it } from 'vitest';
import { validateWorkdayIntent } from '@treeseed/sdk/operator-contracts';
import { parsePublicWorkdayIntent } from '../../../../../../../src/api/capacity/services/capacity/workdays/scheduling/workday-preflight-service.ts';
import { serializeWorkdaySchedule } from '../../../../../../../src/api/capacity/services/capacity/workdays/scheduling/workday-schedule-service.ts';

export const intent = { schemaVersion: 'treeseed.workday-intent/v1' as const, teamId: 'team', profileId: 'default',
	projects: ['project'], executionMode: 'simulation' as const, startsAt: '2026-10-02T21:00:00.000Z', durationSeconds: 60,
	planningOnly: true, allocation: { allocationWeight: 1, planningPercent: 20 }, operatorConstraints: { providerIds: ['provider'], maxConcurrency: 1 } };

describe('manual and recurring canonical high-level intent', () => {
	it('retains one execution mode and exact governed intent without derived capacity or duplicate scheduling policy', () => {
		const before = structuredClone(intent), parsed = parsePublicWorkdayIntent('team', intent);
		expect(validateWorkdayIntent(parsed)).toEqual([]); expect(parsed).toEqual(intent); expect(intent).toEqual(before);
		const stored = { id: 'schedule', team_id: 'team', status: 'active', purpose: 'Governed recurrence', cadence_seconds: 60,
			intent_json: JSON.stringify(intent), last_run_id: null, next_run_at: intent.startsAt, state_version: 1,
			created_at: intent.startsAt, updated_at: intent.startsAt };
		expect(serializeWorkdaySchedule(stored)?.intent).toEqual(parsed); expect(stored.intent_json).toBe(JSON.stringify(before));
	});
	it('denies every retired capacity publication provider and time-tier field instead of manufacturing workday authority', () => {
		const outcomes: boolean[] = [];
		for (const field of ['availableSeconds', 'timePolicy', 'maxActiveAssignments', 'projectIds', 'publicationPolicy', 'runtimeImage',
			'assignmentSeconds', 'reservationIds', 'executionNodes', 'agentPrompts', 'timeTier', 'allocationHierarchy']) {
			const input = { ...intent, [field]: {} }, before = structuredClone(input);
			try { parsePublicWorkdayIntent('team', input); outcomes.push(false); } catch { outcomes.push(true); }
			expect(input).toEqual(before);
		}
		expect(outcomes).toEqual(Array(12).fill(true));
	});
	it('denies foreign malformed and contradictory intent clocks constraints and modes without a usable schedule', () => {
		const outcomes: boolean[] = [];
		for (const changes of [{ teamId: 'foreign-team' }, { projects: [] }, { projects: [''] }, { executionMode: 'unknown' },
			{ startsAt: 'not-a-time' }, { durationSeconds: -1 }, { planningOnly: 'true' }, { operatorConstraints: { maxConcurrency: 0 } },
			{ operatorConstraints: { nativeLimits: {} } }, { allocation: { planningPercent: 101 } }]) {
			const input = { ...intent, ...changes }, before = structuredClone(input);
			try { parsePublicWorkdayIntent('team', input); outcomes.push(false); } catch { outcomes.push(true); }
			expect(input).toEqual(before);
		}
		expect(outcomes).toEqual(Array(10).fill(true));
	});
	it('rejects corrupt stored schedule states and noncanonical intents rather than exposing a successful partial record', () => {
		const base = { id: 'schedule', team_id: 'team', status: 'active', purpose: 'Governed recurrence', cadence_seconds: 60,
			intent_json: JSON.stringify(intent), next_run_at: intent.startsAt, state_version: 1, created_at: intent.startsAt, updated_at: intent.startsAt };
		for (const row of [{ ...base, status: 'unknown' }, { ...base, intent_json: '{' },
			{ ...base, intent_json: JSON.stringify({ ...intent, availableSeconds: 999 }) }]) {
			const before = structuredClone(row); expect(() => serializeWorkdaySchedule(row)).toThrow(); expect(row).toEqual(before);
		}
	});
});
