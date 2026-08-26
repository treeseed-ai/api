import { createVerifiedAccount, deleteVerifiedAccount, type VerifiedAccount } from './accounts.ts';
import { expectStatus, type VerifierResponse, VerifierHttp } from './http.ts';
import { mailpitUrl } from './mailpit.ts';

type Team = { id: string; name: string; displayName?: string; updatedAt?: string; lifecycleVersion?: number; status?: string };
type Member = { id: string; userId: string; updatedAt?: string; roles?: string[] };

function teamFrom(response: VerifierResponse) {
	const value = response.data as Team & { team?: Team };
	return value.team ?? value;
}

async function access(client: VerifierHttp, teamId: string) {
	const response = expectStatus(await client.request('GET', `/v1/teams/${teamId}/access`), 200, 'team access');
	return teamFrom(response);
}

export async function verifyTeamJourneys(http: VerifierHttp, mailpitOrigin: string, adminOrigin: string, owner: VerifiedAccount) {
	expectStatus(await http.request('POST', '/v1/teams', { name: 'anonymous-team' }), 401, 'anonymous team creation');
	const ownerClient = http.withToken(owner.accessToken);
	const nonce = `${Date.now()}${Math.floor(Math.random() * 100_000)}`;
	const name = `guarantee-${nonce}`.slice(0, 48);
	const created = expectStatus(await ownerClient.request('POST', '/v1/teams', {
		name, displayName: 'Guarantee Team', profileSummary: 'Exact composition verification.', metadata: { visibility: 'public', publicTeam: true },
	}), 200, 'team creation');
	const team = teamFrom(created);
	if (!team.id) throw new Error('Team creation omitted its identifier.');
	expectStatus(await ownerClient.request('GET', '/v1/teams'), 200, 'team list');
	expectStatus(await http.request('GET', `/v1/teams/by-name/${encodeURIComponent(name)}/profile`), 200, 'public team profile');
	let current = await access(ownerClient, team.id);
	expectStatus(await ownerClient.request('PATCH', `/v1/teams/${team.id}`, { displayName: 'Verified Guarantee Team' }, {
		'if-match': String(current.updatedAt ?? '0'),
	}), 200, 'team update');

	const member = await createVerifiedAccount(http, mailpitOrigin, adminOrigin, 'member');
	const mismatch = await createVerifiedAccount(http, mailpitOrigin, adminOrigin, 'mismatch');
	const invited = expectStatus(await ownerClient.request('POST', `/v1/teams/${team.id}/invites`, { email: member.email, roleKey: 'contributor' }), 200, 'team invite');
	const inviteId = String((invited.data as { invite?: { id?: string } }).invite?.id ?? '');
	if (!inviteId) throw new Error('Team invitation omitted its identifier.');
	const inviteUrl = await mailpitUrl(mailpitOrigin, member.email, `You're invited to join Verified Guarantee Team`);
	const token = inviteUrl.pathname.match(/\/team-invites\/([^/]+)\/accept$/u)?.[1];
	if (!token) throw new Error('Team invitation email omitted its token path.');
	expectStatus(await http.request('GET', `/v1/team-invites/${token}`), 200, 'team invitation presentation');
	expectStatus(await http.withToken(mismatch.accessToken).request('POST', `/v1/team-invites/${token}/accept`, {}), 400, 'team invitation identity mismatch');
	expectStatus(await http.withToken(member.accessToken).request('POST', `/v1/team-invites/${token}/accept`, {}), 200, 'team invitation acceptance');
	const replay = expectStatus(await http.withToken(member.accessToken).request('POST', `/v1/team-invites/${token}/accept`, {}), 200, 'team invitation replay');
	if ((replay.data as { alreadyAccepted?: boolean }).alreadyAccepted !== true) throw new Error('Team invitation replay did not return its terminal receipt.');

	const membersResponse = expectStatus(await ownerClient.request('GET', `/v1/teams/${team.id}/members`), 200, 'team members');
	const members = (membersResponse.data as { items?: Member[] }).items ?? [];
	const ownerMembership = members.find((entry) => entry.roles?.includes('team_owner'));
	const memberMembership = members.find((entry) => entry.userId !== ownerMembership?.userId);
	if (!ownerMembership || !memberMembership) throw new Error('Accepted team memberships were not visible.');
	const memberClient = http.withToken(member.accessToken);
	expectStatus(await memberClient.request('GET', `/v1/teams/${team.id}/access`), 200, 'member team access');
	expectStatus(await memberClient.request('PATCH', `/v1/teams/${team.id}`, { displayName: 'Forbidden' }, { 'if-match': String((await access(memberClient, team.id)).updatedAt ?? '0') }), 403, 'contributor team update');
	expectStatus(await memberClient.request('POST', `/v1/teams/${team.id}/invites`, { email: 'forbidden@example.test', roleKey: 'viewer' }), 403, 'contributor team invite');
	expectStatus(await memberClient.request('PATCH', `/v1/teams/${team.id}/members/${ownerMembership.id}`, { roleKey: 'contributor' }, { 'if-match': String(ownerMembership.updatedAt ?? '0') }), 403, 'contributor role update');
	expectStatus(await memberClient.confirmed('DELETE', `/v1/teams/${team.id}/members/${ownerMembership.id}`, {}, { 'if-match': String(ownerMembership.updatedAt ?? '0') }), 403, 'contributor member removal');
	const blockers = expectStatus(await ownerClient.request('GET', `/v1/teams/${team.id}/members/${ownerMembership.id}/removal-blockers`), 200, 'last owner blockers');
	if (!(blockers.data as { blockers?: Array<{ code?: string }> }).blockers?.some((entry) => entry.code === 'last_owner')) throw new Error('Last-owner blocker was not reported.');

	expectStatus(await ownerClient.request('PATCH', `/v1/teams/${team.id}/members/${memberMembership.id}`, { roleKey: 'project_lead' }, { 'if-match': String(memberMembership.updatedAt ?? '0') }), 200, 'member role update');
	current = await access(ownerClient, team.id);
	expectStatus(await memberClient.confirmed('POST', `/v1/teams/${team.id}/archive`, {}, { 'if-match': String(current.lifecycleVersion ?? 0) }), 403, 'project lead archive');
	expectStatus(await ownerClient.confirmed('POST', `/v1/teams/${team.id}/archive`, {}, { 'if-match': String(current.lifecycleVersion ?? 0) }), 200, 'team archive');
	expectStatus(await http.request('GET', `/v1/teams/by-name/${encodeURIComponent(name)}/profile`), 404, 'archived public team profile');
	current = await access(ownerClient, team.id);
	expectStatus(await ownerClient.request('POST', `/v1/teams/${team.id}/restore`, {}, { 'if-match': String(current.lifecycleVersion ?? 0) }), 200, 'team restore');

	const afterRestore = expectStatus(await ownerClient.request('GET', `/v1/teams/${team.id}/members`), 200, 'restored members');
	const removable = ((afterRestore.data as { items?: Member[] }).items ?? []).find((entry) => entry.id === memberMembership.id);
	if (!removable) throw new Error('Restored member was not found.');
	expectStatus(await ownerClient.confirmed('DELETE', `/v1/teams/${team.id}/members/${removable.id}`, {}, { 'if-match': String(removable.updatedAt ?? '0') }), 200, 'member removal');
	current = await access(ownerClient, team.id);
	expectStatus(await ownerClient.request('GET', `/v1/teams/${team.id}/deletion-readiness`), 200, 'team deletion readiness');
	expectStatus(await ownerClient.confirmed('DELETE', `/v1/teams/${team.id}/permanent-delete`, {
		confirmation: `DELETE ${name}`, currentPassword: owner.password,
	}, { 'if-match': String(current.lifecycleVersion ?? 0) }), 200, 'team permanent deletion');
	await deleteVerifiedAccount(http, member);
	await deleteVerifiedAccount(http, mismatch);
}
