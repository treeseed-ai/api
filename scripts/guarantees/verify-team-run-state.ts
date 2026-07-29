import assert from 'node:assert/strict';

type RunValue = {
	kind?: string;
	value?: Record<string, unknown>;
	device?: string;
};

const phase = process.argv[2] ?? '';
const apiBaseUrl = process.env.TREESEED_API_BASE_URL ?? 'http://127.0.0.1:3000';
const serviceId = process.env.TREESEED_ACCEPTANCE_SERVICE_ID ?? 'web';
const serviceSecret = process.env.TREESEED_ACCEPTANCE_SERVICE_SECRET ?? 'treeseed-web-service-dev-secret';
const runState = JSON.parse(process.env.TREESEED_GUARANTEE_RUN_STATE ?? '{}') as Record<string, RunValue>;
const teams = Object.entries(runState)
	.filter(([key, entry]) => key.startsWith('team.primary@') && entry.value?.name)
	.map(([key, entry]) => ({
		device: entry.device ?? key.split('@').at(-1) ?? 'unknown',
		name: String(entry.value!.name),
		displayName: String(entry.value!.displayName ?? ''),
	}));

assert.ok(teams.length > 0, 'Run state contains no UI-created team identifiers.');

async function json(path: string, service = true) {
	const response = await fetch(new URL(path, apiBaseUrl), {
		headers: service ? {
			'x-treeseed-service-id': serviceId,
			'x-treeseed-service-secret': serviceSecret,
		} : {},
	});
	const body = await response.json().catch(() => null);
	assert.equal(response.status, 200, `${path} returned ${response.status}: ${JSON.stringify(body)}`);
	return body?.payload ?? body;
}

function hasAudit(state: any, eventType: string) {
	return (state.audits ?? []).some((event: any) => event.eventType === eventType);
}

for (const expected of teams) {
	const state = await json(`/v1/acceptance/guarantees/team-state?name=${encodeURIComponent(expected.name)}`);
	const recipient = Object.values(runState)
		.find((entry) => String(entry.value?.recipient ?? '').includes(expected.device.replaceAll('_', '-')))
		?.value?.recipient;
	const existingRecipient = Object.values(runState)
		.find((entry) => entry.value?.existingRecipient)
		?.value?.existingRecipient;
	const revokedRecipient = Object.values(runState)
		.find((entry) => String(entry.value?.revokedRecipient ?? '').includes(expected.device.replaceAll('_', '-')))
		?.value?.revokedRecipient;
	switch (phase) {
		case 'create':
			assert.equal(state.team?.name, expected.name);
			assert.ok((state.members ?? []).some((member: any) => member.roles?.includes('team_owner')));
			assert.ok(hasAudit(state, 'team.created'));
			break;
		case 'active':
			assert.equal(state.team?.status, 'active');
			break;
		case 'update':
			assert.equal(state.team?.displayName, expected.displayName.replace('Guarantee', 'Verified'));
			assert.ok(hasAudit(state, 'team.updated'));
			break;
		case 'overview':
			assert.equal(state.team?.name, expected.name);
			assert.ok(Array.isArray(state.members));
			break;
		case 'public-profile': {
			const profile = await json(`/v1/teams/by-name/${encodeURIComponent(expected.name)}/profile`, false);
			assert.equal(profile.team?.name ?? profile.name, expected.name);
			assert.ok(profile.knowledge && Array.isArray(profile.knowledge.catalog));
			assert.ok(Array.isArray(profile.knowledge.knowledgePacks));
			assert.ok(Array.isArray(profile.knowledge.projects));
			assert.ok(Array.isArray(profile.knowledge.trail));
			for (const forbidden of ['email', 'members', 'memberships', 'capacity', 'hosts', 'billing', 'counts']) {
				assert.equal(Object.hasOwn(profile.team ?? profile, forbidden), false, `Public profile leaked ${forbidden}.`);
			}
			break;
		}
		case 'invite':
			assert.ok((state.invitations ?? []).some((invite: any) => invite.email === recipient && invite.status === 'pending'));
			assert.equal((state.invitations ?? []).some((invite: any) => invite.email === revokedRecipient && invite.status === 'pending'), false);
			assert.ok(hasAudit(state, 'team.invitation.created'));
			assert.ok(hasAudit(state, 'team.invitation.resent'));
			assert.ok(hasAudit(state, 'team.invitation.revoked'));
			break;
		case 'accept':
			assert.ok((state.members ?? []).some((member: any) => member.email === recipient));
			assert.ok((state.members ?? []).some((member: any) => member.email === existingRecipient));
			assert.ok(hasAudit(state, 'team.invitation.accepted'));
			break;
		case 'role':
			assert.ok((state.members ?? []).some((member: any) => member.email === recipient && member.roleKey === 'reviewer'));
			assert.ok(hasAudit(state, 'team.member.role_changed'));
			assert.ok(hasAudit(state, 'team.ownership.transferred'));
			break;
		case 'remove':
			assert.equal((state.members ?? []).some((member: any) => member.email === recipient), false);
			assert.equal((state.members ?? []).some((member: any) => member.email === existingRecipient), false);
			assert.ok((state.members ?? []).some((member: any) => member.roles?.includes('team_owner')));
			assert.ok(hasAudit(state, 'team.member.removed'));
			assert.ok(hasAudit(state, 'team.member.left'));
			break;
		case 'delete':
		case 'cleanup':
			assert.equal(state.team, null);
			assert.ok(hasAudit(state, 'team.deleted'));
			break;
		default:
			throw new Error(`Unsupported team guarantee verifier phase: ${phase}`);
	}
}

process.stdout.write(`${JSON.stringify({ ok: true, phase, teams }, null, 2)}\n`);
