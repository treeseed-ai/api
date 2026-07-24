import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, Core, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../../support/api-harness.ts';

describe('market api', () => {
it('allows project leads to manage team settings while hiding controls from contributors', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const ownerToken = await authorizeApp(app);
		const team = await createTeam(app, ownerToken);
		const leadToken = await authorizeApp(app, { principalId: 'team-lead', displayName: 'Team Lead' });
		const contributorToken = await authorizeApp(app, { principalId: 'team-contributor', displayName: 'Team Contributor' });
		await store.upsertTeamMember(team.id, 'team-lead', 'project_lead');
		await store.upsertTeamMember(team.id, 'team-contributor', 'contributor');

		const leadMembers = await json(await app.request(`/v1/teams/${team.id}/members`, {
			headers: { authorization: `Bearer ${leadToken}` },
		}));
		expect(leadMembers.ok).toBe(true);
		const ownerMember = leadMembers.payload.find((entry: { userId: string }) => entry.userId === 'user-1');
		const ownerAliasUpdate = await json(await app.request(`/v1/teams/${team.id}/members/${ownerMember.id}`, {
			method: 'PATCH',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${leadToken}`,
			},
			body: JSON.stringify({ roleKey: 'owner' }),
		}));
		expect(ownerAliasUpdate.member.roleKey).toBe('team_owner');

		const contributorMembers = await app.request(`/v1/teams/${team.id}/members`, {
			headers: { authorization: `Bearer ${contributorToken}` },
		});
		expect(contributorMembers.status).toBe(403);
	});
});
