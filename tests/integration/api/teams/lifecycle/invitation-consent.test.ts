import {
	authorizeApp,
	createTestApp,
	createTestPostgresDatabase,
	createTestStore,
	describe,
	expect,
	it,
	json,
} from '../../../../support/api-harness.ts';

const acceptanceHeaders = {
	'x-treeseed-acceptance-email-bypass': '1',
	'x-treeseed-service-id': 'web',
	'x-treeseed-service-secret': 'web-test-secret',
};

async function verifiedUser(app: ReturnType<typeof createTestApp>, email: string, username: string) {
	const signup = await json(await app.request('/v1/auth/web/sign-up', {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...acceptanceHeaders },
		body: JSON.stringify({ email, username, password: 'InvitationConsent123!', name: username }),
	}));
	const confirmed = await json(await app.request('/v1/auth/web/confirm-email', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ token: signup.payload.confirmationToken }),
	}));
	return confirmed.payload.accessToken as string;
}

async function invitedTeam() {
	const db = createTestPostgresDatabase();
	const store = createTestStore(db);
	const app = createTestApp({ db, store });
	const ownerToken = await authorizeApp(app, { principalId: 'consent-owner' });
	const created = await json(await app.request('/v1/teams', {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
		body: JSON.stringify({ name: 'consent-team', displayName: 'Consent Team' }),
	}));
	const invite = await json(await app.request(`/v1/teams/${created.payload.id}/invites`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			authorization: `Bearer ${ownerToken}`,
			...acceptanceHeaders,
		},
		body: JSON.stringify({ email: 'invited@example.com', roleKey: 'reviewer' }),
	}));
	return { app, store, teamId: created.payload.id, invite };
}

describe('team invitation consent', () => {
	it('keeps a newly registered invited user outside the team until verification and explicit acceptance', async () => {
		const { app, store, teamId, invite } = await invitedTeam();
		const signup = await json(await app.request('/v1/auth/web/sign-up', {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...acceptanceHeaders },
			body: JSON.stringify({
				email: 'invited@example.com',
				username: 'new-invited-user',
				password: 'InvitationConsent123!',
				name: 'New Invited User',
				inviteToken: invite.token,
				returnTo: `/team-invites/${invite.token}/accept`,
			}),
		}));
		expect((await store.listTeamMembers(teamId)).some((member) => member.email === 'invited@example.com')).toBe(false);
		const confirmed = await json(await app.request('/v1/auth/web/confirm-email', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ token: signup.payload.confirmationToken }),
		}));
		expect((await store.listTeamMembers(teamId)).some((member) => member.email === 'invited@example.com')).toBe(false);
		const accepted = await json(await app.request(`/v1/team-invites/${invite.token}/accept`, {
			method: 'POST',
			headers: { authorization: `Bearer ${confirmed.payload.accessToken}` },
		}));
		expect(accepted.ok).toBe(true);
		expect((await store.listTeamMembers(teamId)).some((member) => member.email === 'invited@example.com')).toBe(true);
	});

	it('rejects invitation acceptance by a verified mismatched user', async () => {
		const { app, invite } = await invitedTeam();
		const mismatched = await verifiedUser(app, 'other@example.com', 'other-user');
		const response = await app.request(`/v1/team-invites/${invite.token}/accept`, {
			method: 'POST',
			headers: { authorization: `Bearer ${mismatched}` },
		});
		expect(response.status).toBe(400);
		expect(await json(response)).toMatchObject({ ok: false, code: 'email_mismatch' });
	});

	it('preserves explicit expired revoked accepted and replay states', async () => {
		const { app, store, teamId, invite } = await invitedTeam();
		const invited = await verifiedUser(app, 'invited@example.com', 'invited-user');
		expect((await store.listTeamMembers(teamId))
			.some((member) => member.email === 'invited@example.com')).toBe(false);
		const accepted = await json(await app.request(`/v1/team-invites/${invite.token}/accept`, {
			method: 'POST',
			headers: { authorization: `Bearer ${invited}` },
		}));
		expect(accepted.ok).toBe(true);
		const replay = await json(await app.request(`/v1/team-invites/${invite.token}/accept`, {
			method: 'POST',
			headers: { authorization: `Bearer ${invited}` },
		}));
		expect(replay).toMatchObject({ ok: true, alreadyAccepted: true });
		const revoked = await store.createTeamInvite(teamId, { email: 'revoked@example.com', roleKey: 'reviewer' });
		await store.run(`UPDATE team_invites SET status = 'revoked' WHERE id = ?`, [revoked.invite.id]);
		const revokedPreview = await json(await app.request(`/v1/team-invites/${revoked.token}`));
		expect(revokedPreview.payload.invite.status).toBe('revoked');
		const expired = await store.createTeamInvite(teamId, { email: 'expired@example.com', roleKey: 'reviewer' });
		await store.run(`UPDATE team_invites SET expires_at = ? WHERE id = ?`, ['2000-01-01T00:00:00.000Z', expired.invite.id]);
		const expiredPreview = await json(await app.request(`/v1/team-invites/${expired.token}`));
		expect(expiredPreview.payload.invite.status).toBe('expired');
	});
});
