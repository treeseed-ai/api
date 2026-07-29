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

describe('team lifecycle visibility', () => {
	it('hides archived and deleted teams from anonymous profiles', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const ownerToken = await authorizeApp(app, { principalId: 'lifecycle-owner' });
		const created = await json(await app.request('/v1/teams', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ name: 'lifecycle-team', displayName: 'Lifecycle Team', metadata: { visibility: 'public' } }),
		}));
		const before = await app.request('/v1/teams/by-name/lifecycle-team/profile');
		expect(before.status).toBe(200);
		const archived = await json(await app.request(`/v1/teams/${created.payload.id}/archive`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ lifecycleVersion: created.payload.lifecycleVersion }),
		}));
		expect(archived.ok).toBe(true);
		expect(Date.parse(archived.team.restoreDeadlineAt)).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000);
		expect((await app.request('/v1/teams/by-name/lifecycle-team/profile')).status).toBe(404);
		await store.run(`DELETE FROM teams WHERE id = ?`, [created.payload.id]);
		expect((await app.request('/v1/teams/by-name/lifecycle-team/profile')).status).toBe(404);
	});

	it('makes permanent deletion immediately available while requiring exact confirmation and reauthentication', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const ownerToken = await authorizeApp(app, { principalId: 'immediate-delete-owner' });
		const created = await json(await app.request('/v1/teams', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ name: 'immediate-delete-team', displayName: 'Immediate Delete Team' }),
		}));
		const readiness = await json(await app.request(`/v1/teams/${created.payload.id}/deletion-readiness`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(readiness).toMatchObject({
			ok: true,
			ready: true,
			team: { status: 'active', name: 'immediate-delete-team' },
		});
		const wrongConfirmation = await app.request(`/v1/teams/${created.payload.id}/permanent-delete`, {
			method: 'DELETE',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ confirmation: 'wrong-team', currentPassword: 'wrong-password' }),
		});
		expect(wrongConfirmation.status).toBe(400);
		const missingReauthentication = await app.request(`/v1/teams/${created.payload.id}/permanent-delete`, {
			method: 'DELETE',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ confirmation: 'immediate-delete-team' }),
		});
		expect(missingReauthentication.status).toBe(401);
		expect(await store.getTeam(created.payload.id)).not.toBeNull();
	});

	it('hides private active profiles anonymously and restores member access after archival', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const ownerToken = await authorizeApp(app, { principalId: 'private-profile-owner' });
		const created = await json(await app.request('/v1/teams', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				name: 'private-profile-team',
				displayName: 'Private Profile Team',
				metadata: { visibility: 'private' },
			}),
		}));
		expect((await app.request('/v1/teams/by-name/private-profile-team/profile')).status).toBe(404);
		expect((await app.request('/v1/teams/by-name/private-profile-team/profile', {
			headers: { authorization: `Bearer ${ownerToken}` },
		})).status).toBe(200);

		const archived = await json(await app.request(`/v1/teams/${created.payload.id}/archive`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ lifecycleVersion: created.payload.lifecycleVersion }),
		}));
		expect((await app.request('/v1/teams/by-name/private-profile-team/profile', {
			headers: { authorization: `Bearer ${ownerToken}` },
		})).status).toBe(404);

		const restored = await json(await app.request(`/v1/teams/${created.payload.id}/restore`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ lifecycleVersion: archived.team.lifecycleVersion }),
		}));
		expect(restored).toMatchObject({ ok: true, team: { status: 'active' } });
		expect((await app.request('/v1/teams/by-name/private-profile-team/profile')).status).toBe(404);
		const memberProfile = await json(await app.request('/v1/teams/by-name/private-profile-team/profile', {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(memberProfile).toMatchObject({
			ok: true,
			payload: { team: { name: 'private-profile-team' } },
		});
		expect(JSON.stringify(memberProfile.payload)).not.toMatch(/membership|email|role/iu);
	});

	it('reports owned host obligations with canonical resolution links', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const ownerToken = await authorizeApp(app, { principalId: 'blocker-owner' });
		const created = await json(await app.request('/v1/teams', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ name: 'blocker-team', displayName: 'Blocker Team' }),
		}));
		const now = new Date().toISOString();
		await store.run(`INSERT INTO team_web_hosts
			(id, team_id, provider, ownership, name, status, allowed_environments_json, created_at, updated_at)
			VALUES (?, ?, 'cloudflare', 'managed', 'blocker.example.test', 'active', '[]', ?, ?)`, [
			'host-blocker',
			created.payload.id,
			now,
			now,
		]);
		const eligibility = await json(await app.request(`/v1/teams/${created.payload.id}/deletion-readiness`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(eligibility).toMatchObject({ ok: true, ready: false });
		expect(eligibility.blockers).toContainEqual(expect.objectContaining({
			code: 'host',
			id: 'host-blocker',
			href: '/app/hosts',
		}));
	});

	it('distinguishes missing, forbidden, and archived team access states', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const ownerToken = await authorizeApp(app, { principalId: 'typed-access-owner' });
		const nonMemberToken = await authorizeApp(app, { principalId: 'typed-access-outsider' });
		const created = await json(await app.request('/v1/teams', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ name: 'typed-access-team', displayName: 'Typed Access Team' }),
		}));
		expect((await app.request('/v1/teams/team-that-does-not-exist/access', {
			headers: { authorization: `Bearer ${ownerToken}` },
		})).status).toBe(404);
		expect((await app.request(`/v1/teams/${created.payload.id}/access`, {
			headers: { authorization: `Bearer ${nonMemberToken}` },
		})).status).toBe(403);
		const archiveResponse = await json(await app.request(`/v1/teams/${created.payload.id}/archive`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ lifecycleVersion: created.payload.lifecycleVersion }),
		}));
		const archived = await json(await app.request(`/v1/teams/${created.payload.id}/access`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(archived.payload.team.status).toBe('archived');
		expect(archived.payload.team.restoreDeadlineAt).toEqual(expect.any(String));
		const restored = await json(await app.request(`/v1/teams/${created.payload.id}/restore`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ lifecycleVersion: archiveResponse.team.lifecycleVersion }),
		}));
		expect(restored).toMatchObject({
			ok: true,
			team: { status: 'active', restoreDeadlineAt: null },
		});
	});
});
