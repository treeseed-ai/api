import { describe, expect, it } from 'vitest';
import { replayAttempt } from '../admission-replay-fixture.ts';
import { capabilityCounterClaims } from '../../../../../../../src/api/capacity/services/capacity/assignments/admission/capability-counter-claims.ts';

describe('shared provider counter authority', () => {
	it('shares exact host model capability day counters across teams without changing supplied authority', () => {
		const attempt = replayAttempt(), before = structuredClone(attempt);
		const limits = { modelConfigurationId: attempt.provider.modelConfigurationId, dailyActiveSecondsLimit: 10,
			capabilityLimits: { [attempt.provider.executionCapabilityId]: { dailyActiveSecondsLimit: 10 } } };
		const actual = capabilityCounterClaims(attempt, limits, attempt.createdAt);
		expect(capabilityCounterClaims({ ...attempt, teamId: 'another-team' }, limits, attempt.createdAt)).toEqual(actual);
		expect(actual).toHaveLength(2); expect(new Set(actual.map(value => value.id)).size).toBe(2); expect(attempt).toEqual(before);
	});
	it('separates provider model capability and day without creating a second accounting authority', () => {
		const attempt = replayAttempt(), limits = { modelConfigurationId: attempt.provider.modelConfigurationId, dailyActiveSecondsLimit: 10,
			capabilityLimits: { [attempt.provider.executionCapabilityId]: { dailyActiveSecondsLimit: 10 }, 'other-capability': { dailyActiveSecondsLimit: 10 } } };
		const original = capabilityCounterClaims(attempt, limits, attempt.createdAt);
		const provider = capabilityCounterClaims({ ...attempt, provider: { ...attempt.provider, providerId: 'other-provider' } }, limits, attempt.createdAt);
		const capability = capabilityCounterClaims({ ...attempt, provider: { ...attempt.provider, executionCapabilityId: 'other-capability' } }, limits, attempt.createdAt);
		expect(provider.map(value => value.id).filter(id => original.some(value => value.id === id))).toHaveLength(0);
		expect(capability.map(value => value.id).filter(id => original.some(value => value.id === id))).toHaveLength(1);
		expect(capabilityCounterClaims(attempt, limits, '2026-10-03T00:00:00.000Z').map(value => value.id)).not.toEqual(original.map(value => value.id));
	});
	it('denies missing capabilities foreign models and malformed counter ceilings', () => {
		const attempt = replayAttempt();
		const outcomes = [{ modelConfigurationId: 'foreign', dailyActiveSecondsLimit: 10, capabilityLimits: {} },
			{ modelConfigurationId: attempt.provider.modelConfigurationId, dailyActiveSecondsLimit: 10, capabilityLimits: {} },
			{ modelConfigurationId: attempt.provider.modelConfigurationId, dailyActiveSecondsLimit: -1,
				capabilityLimits: { [attempt.provider.executionCapabilityId]: { dailyActiveSecondsLimit: 10 } } },
			{ modelConfigurationId: attempt.provider.modelConfigurationId, dailyActiveSecondsLimit: Number.NaN,
				capabilityLimits: { [attempt.provider.executionCapabilityId]: { dailyActiveSecondsLimit: Number.POSITIVE_INFINITY } } },
		].map(limits => { try { capabilityCounterClaims(attempt, limits, attempt.createdAt); return 'admitted'; } catch { return 'denied'; } });
		expect(outcomes).toEqual(['denied', 'denied', 'denied', 'denied']);
	});
});
