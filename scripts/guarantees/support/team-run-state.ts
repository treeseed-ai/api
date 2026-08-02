export type TeamRunValue = {
	kind?: string;
	value?: Record<string, unknown>;
	device?: string;
};

const phaseMarker: Record<string, string> = {
	invite: 'team.invitation',
	accept: 'team.membership-accepted',
	role: 'team.member-role-changed',
	remove: 'team.member-removed',
	delete: 'team.deleted',
	cleanup: 'team.deleted',
};

function deviceFrom(key: string, entry: TeamRunValue) {
	return entry.device ?? key.split('@').at(-1) ?? 'unknown';
}

export function teamsForPhase(runState: Record<string, TeamRunValue>, phase: string) {
	const marker = phaseMarker[phase];
	const selectedDevices = marker
		? new Set(Object.entries(runState)
			.filter(([key]) => key.startsWith(`${marker}@`))
			.map(([key, entry]) => deviceFrom(key, entry)))
		: null;

	return Object.entries(runState)
		.filter(([key, entry]) => key.startsWith('team.primary@')
			&& entry.value?.name
			&& (!selectedDevices || selectedDevices.has(deviceFrom(key, entry))))
		.map(([key, entry]) => ({
			device: deviceFrom(key, entry),
			name: String(entry.value!.name),
			displayName: String(entry.value!.displayName ?? ''),
		}));
}

export function invitationStateForDevice(runState: Record<string, TeamRunValue>, device: string) {
	return runState[`team.invitation@${device}`]?.value;
}
