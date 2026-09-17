import { describe, expect, it } from 'vitest';
import { providerAccountingStatus } from '../../../../../src/api/control-plane/repositories/providers/provider-runtime-service.ts';

describe('provider accounting diagnostics', () => {
	it('returns the existing capability/model report without arbitrary metadata or credentials', () => {
		const observation = { day: '2026-09-17', observedAt: '2026-09-17T00:00:00Z', healthy: true,
			activeSeconds: 30, reservedSeconds: 40, credential: 'must-not-appear' };
		const status = providerAccountingStatus(JSON.stringify([{ id: 'codex-research', status: 'active', runtimeBuild: 'exact-build',
			credential: 'must-not-appear', nativeLimits: { credential: 'must-not-appear', modelConfigurationId: 'sol-medium', dailyActiveSecondsLimit: 7200,
				capabilityLimits: { research: { dailyActiveSecondsLimit: 7200 } } },
			accountingObservation: { modelUsage: observation, capabilityUsage: { research: observation }, token: 'must-not-appear' } }]));
		expect(status[0]).toMatchObject({ id: 'codex-research', nativeLimits: { dailyActiveSecondsLimit: 7200 },
			accountingObservation: { modelUsage: { activeSeconds: 30, reservedSeconds: 40 } } });
		expect(JSON.stringify(status)).not.toContain('must-not-appear');
		expect(providerAccountingStatus(null)).toEqual([]);
	});
});
