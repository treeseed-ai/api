import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, Core, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../support/api-harness.ts';

describe('market api', () => {
it('manages team profiles, invites, member roles, and guarded deletion', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const created = await json(await app.request('/v1/teams', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				name: 'Alpha-Team',
				displayName: 'Alpha Team',
				logoUrl: 'https://example.com/logo.png',
				description: 'Public team summary.',
			}),
		}));
		expect(created.ok).toBe(true);
		expect(created.payload).toMatchObject({
			name: 'alpha-team',
			displayName: 'Alpha Team',
			logoUrl: 'https://example.com/logo.png',
			profileSummary: 'Public team summary.',
		});
		const creatorMembers = await json(await app.request(`/v1/teams/${created.payload.id}/members`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		const creatorMember = creatorMembers.payload.find((entry: { userId: string }) => entry.userId === 'user-1');
		expect(creatorMember).toMatchObject({ roleKey: 'team_owner' });
		expect(creatorMember.roles).toContain('team_owner');

		const updated = await json(await app.request(`/v1/teams/${created.payload.id}`, {
			method: 'PATCH',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				name: 'alpha-collective',
				displayName: 'Alpha Collective',
			}),
		}));
		expect(updated.ok).toBe(true);
		expect(updated.team.name).toBe('alpha-collective');
		expect(updated.team.displayName).toBe('Alpha Collective');

		const duplicate = await json(await app.request('/v1/teams', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				name: 'other-team',
				displayName: 'Other Team',
			}),
		}));
		const renameTaken = await json(await app.request(`/v1/teams/${duplicate.payload.id}`, {
			method: 'PATCH',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ name: 'alpha-collective' }),
		}));
		expect(renameTaken).toMatchObject({ ok: false, code: 'taken' });

		const invite = await json(await app.request(`/v1/teams/${created.payload.id}/invites`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				email: 'new-member@example.com',
				roleKey: 'reviewer',
			}),
		}));
		expect(invite.ok).toBe(true);
		expect(invite.token).toMatch(/^tiv_/);

		const accepted = await json(await app.request('/v1/auth/web/sign-up', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				email: 'new-member@example.com',
				username: 'new-member',
				password: 'invite-password-123',
				displayName: 'Invited User',
				inviteToken: invite.token,
			}),
		}));
		expect(accepted.ok).toBe(true);
		expect(accepted.payload.accessToken).toEqual(expect.any(String));

		const members = await json(await app.request(`/v1/teams/${created.payload.id}/members`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		const member = members.payload.find((entry: { email: string }) => entry.email === 'new-member@example.com');
		expect(member.roles).toContain('reviewer');

		const updatedRole = await json(await app.request(`/v1/teams/${created.payload.id}/members/${member.id}`, {
			method: 'PATCH',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ roleKey: 'contributor' }),
		}));
		expect(updatedRole.ok).toBe(true);

		const deleted = await json(await app.request(`/v1/teams/${created.payload.id}`, {
			method: 'DELETE',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ confirmation: 'DELETE alpha-collective' }),
		}));
		expect(deleted.ok).toBe(true);
	});
});
