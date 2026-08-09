import { describe,expect,it } from 'vitest';
import { resolveSignalSubjectGroups } from '../../../../../src/api/capacity/routes/capacity/assignments/provider-signal-policy.ts';

describe('provider signal subject group policy', () => {
	it('uses explicit subject groups instead of producer membership', () => {
		expect(resolveSignalSubjectGroups(
			{ subjectGroupIds: ['group:proposal', 'group:proposal'] },
			'group:producer-primary',
			new Set(['group:proposal', 'group:producer-primary']),
		)).toEqual({ directGroupIds: ['group:proposal'], source: 'subject' });
	});

	it('falls back only to the frozen primary group and rejects unknown subject groups', () => {
		expect(resolveSignalSubjectGroups({}, 'group:primary', new Set(['group:primary']))).toEqual({ directGroupIds: ['group:primary'], source: 'agent-primary-default' });
		expect(() => resolveSignalSubjectGroups({ subjectGroupIds: ['group:outside'] }, 'group:primary', new Set(['group:primary']))).toThrow(/outside the frozen workday topology/u);
	});
});
