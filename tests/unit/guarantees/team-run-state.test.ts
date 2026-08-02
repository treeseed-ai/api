import { describe, expect, it } from 'vitest';
import { invitationStateForDevice, teamsForPhase, type TeamRunValue } from '../../../scripts/guarantees/support/team-run-state.ts';

function marker(device: string, value: Record<string, unknown>): TeamRunValue {
	return { device, kind: 'marker', value };
}

describe('team guarantee run-state correlation', () => {
	it('limits membership phases to devices that produced that phase marker', () => {
		const state = {
			'team.primary@desktop_chromium': marker('desktop_chromium', { name: 'desktop', displayName: 'Desktop' }),
			'team.primary@tablet_chromium': marker('tablet_chromium', { name: 'tablet', displayName: 'Tablet' }),
			'team.primary@mobile_chromium': marker('mobile_chromium', { name: 'mobile', displayName: 'Mobile' }),
			'team.invitation@desktop_chromium': marker('desktop_chromium', { recipient: 'desktop@example.test' }),
			'team.invitation@mobile_chromium': marker('mobile_chromium', { recipient: 'mobile@example.test' }),
		};

		expect(teamsForPhase(state, 'invite').map((team) => team.device)).toEqual([
			'desktop_chromium',
			'mobile_chromium',
		]);
		expect(teamsForPhase(state, 'public-profile')).toHaveLength(3);
	});

	it('reads invitation values from the exact device-scoped marker', () => {
		const state = {
			'team.invitation@desktop_chromium': marker('desktop_chromium', { recipient: 'desktop@example.test' }),
			'team.invitation@mobile_chromium': marker('mobile_chromium', { recipient: 'mobile@example.test' }),
		};

		expect(invitationStateForDevice(state, 'mobile_chromium')?.recipient).toBe('mobile@example.test');
	});
});
