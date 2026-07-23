import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

describe('market api', () => {
it('keeps public usernames and team slugs in one namespace', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		await store.createTeam({
			name: 'reserved-team',
			displayName: 'Reserved Team',
		});

		const unavailable = await json(await app.request('/v1/auth/availability/username?value=reserved-team'));
		expect(unavailable.payload).toMatchObject({
			value: 'reserved-team',
			available: false,
			status: 'taken',
			message: 'Username is already taken by a team.',
		});
		const availableEmail = await json(await app.request('/v1/auth/availability/email?value=new-account@example.com'));
		expect(availableEmail.payload).toMatchObject({ value: 'new-account@example.com', available: true, status: 'available' });

		const signup = await json(await app.request('/v1/auth/web/sign-up', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				email: 'reserved-team@example.com',
				username: 'reserved-team',
				password: 'TreeSeed-auth-test-123!',
				name: 'Reserved User',
			}),
		}));
		expect(signup.ok).toBe(false);
		expect(signup.code).toBe('namespace_taken');

		const userSignup = await json(await app.request('/v1/auth/web/sign-up', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				email: 'team-slug-user@example.com',
				username: 'team-slug-user',
				password: 'TreeSeed-auth-test-123!',
				name: 'Team Slug User',
			}),
		}));
		const confirmed = await json(await app.request('/v1/auth/web/confirm-email', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ token: userSignup.payload.confirmationToken }),
		}));
		const teamResponse = await json(await app.request('/v1/teams', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${confirmed.payload.accessToken}`,
			},
			body: JSON.stringify({ slug: 'team-slug-user', name: 'Team Slug User Duplicate' }),
		}));
		expect(teamResponse.ok).toBe(false);
		expect(teamResponse.code).toBe('namespace_taken');
	}, 45000);
});
