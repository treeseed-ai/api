import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, Core, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../support/api-harness.ts';

describe('market api', () => {
it('supports multiple verified account emails for login, primary selection, deletion, reset, and invite lookup', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const password = 'TreeSeed-auth-test-123!';
		const signup = await json(await app.request('/v1/auth/web/sign-up', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				email: 'multi-primary@example.com',
				username: 'multi-email-user',
				password,
				name: 'Multi Email User',
			}),
		}));
		expect(signup.ok).toBe(true);
		expect(await store.all(`SELECT * FROM user_email_addresses WHERE normalized_email = ?`, ['multi-primary@example.com'])).toEqual([
			expect.objectContaining({ status: 'pending', is_primary: 1 }),
		]);
		expect(await store.findUserByEmail('multi-primary@example.com')).toBeNull();

		const confirmed = await json(await app.request('/v1/auth/web/confirm-email', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ token: signup.payload.confirmationToken }),
		}));
		expect(confirmed.ok).toBe(true);
		const userId = confirmed.payload.principal.id;
		const headers = {
			authorization: `Bearer ${confirmed.payload.accessToken}`,
			'content-type': 'application/json',
		};
		const initialEmails = await json(await app.request('/v1/auth/web/emails', { headers }));
		expect(initialEmails.payload).toEqual([
			expect.objectContaining({ email: 'multi-primary@example.com', verified: true, isPrimary: true }),
		]);

		const added = await json(await app.request('/v1/auth/web/emails', {
			method: 'POST',
			headers,
			body: JSON.stringify({ email: 'multi-secondary@example.com' }),
		}));
		expect(added.ok).toBe(true);
		expect(added.payload).toMatchObject({
			verificationSent: true,
			confirmationToken: expect.any(String),
			emailAddress: expect.objectContaining({ email: 'multi-secondary@example.com', verified: false }),
		});
		const pendingSecondarySignin = await json(await app.request('/v1/auth/web/sign-in', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ email: 'multi-secondary@example.com', password }),
		}));
		expect(pendingSecondarySignin.ok).toBe(false);
		expect(pendingSecondarySignin.code).toBe('email_confirmation_required');

		const resent = await json(await app.request(`/v1/auth/web/emails/${added.payload.emailAddress.id}/verify`, {
			method: 'POST',
			headers,
		}));
		expect(resent.ok).toBe(true);
		expect(resent.payload.confirmationToken).toEqual(expect.any(String));
		const secondaryConfirmed = await json(await app.request('/v1/auth/web/confirm-email', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ token: resent.payload.confirmationToken }),
		}));
		expect(secondaryConfirmed.ok).toBe(true);
		const secondarySignin = await json(await app.request('/v1/auth/web/sign-in', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ email: 'multi-secondary@example.com', password }),
		}));
		expect(secondarySignin.ok).toBe(true);

		const primary = await json(await app.request(`/v1/auth/web/emails/${added.payload.emailAddress.id}/primary`, {
			method: 'POST',
			headers,
		}));
		expect(primary.ok).toBe(true);
		expect(primary.payload.emailAddress).toMatchObject({ email: 'multi-secondary@example.com', isPrimary: true });
		expect(await store.all(`SELECT email FROM users WHERE id = ?`, [userId])).toEqual([{ email: 'multi-secondary@example.com' }]);
		expect(await store.all(`SELECT email FROM market_auth_credentials WHERE user_id = ?`, [userId])).toEqual([{ email: 'multi-secondary@example.com' }]);

		const reset = await json(await app.request('/v1/auth/web/password-reset/request', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ email: 'multi-primary@example.com' }),
		}));
		expect(reset.ok).toBe(true);
		expect(reset.payload.resetToken).toEqual(expect.any(String));
		const team = await createTeam(app, secondarySignin.payload.accessToken);
		const invite = await store.createTeamInvite(team.id, { email: 'multi-primary@example.com', roleKey: 'contributor' });
		expect(invite.existingUser).toBe(true);
		expect(invite.member?.userId).toBe(userId);

		const originalEmail = initialEmails.payload[0];
		const deletedOriginal = await json(await app.request(`/v1/auth/web/emails/${originalEmail.id}`, {
			method: 'DELETE',
			headers,
		}));
		expect(deletedOriginal.ok).toBe(true);
		const lastDelete = await json(await app.request(`/v1/auth/web/emails/${added.payload.emailAddress.id}`, {
			method: 'DELETE',
			headers,
		}));
		expect(lastDelete.ok).toBe(false);
		expect(lastDelete.code).toBe('last_verified_email');
	}, 30000);
});
