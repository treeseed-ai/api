import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

describe('market api', () => {
it('rejects repository host passphrases before bootstrap decrypt attempts', async () => {
		await withEnv({
			TREESEED_CLOUDFLARE_API_TOKEN: 'managed-token',
			TREESEED_CLOUDFLARE_ACCOUNT_ID: 'managed-account',
		}, async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);
		const host = await json(await app.request(`/v1/teams/${team.id}/repository-hosts`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				name: 'Team GitHub',
				ownership: 'team_owned',
				organizationOrOwner: 'treeseed-sites',
				encryptedPayload: encryptedTestHostEnvelope({
					TREESEED_GITHUB_TOKEN: 'github_pat_secret_for_failure_test',
					organizationOrOwner: 'treeseed-sites',
		}, 'correct launch secret'),
			}),
		}));
		const response = await app.request(`/v1/teams/${team.id}/projects/launch`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				slug: 'wrong-passphrase-launch',
				name: 'Wrong Passphrase Launch',
				sourceKind: 'template',
				sourceRef: 'research',
				hostingMode: 'managed',
				repositoryHostId: host.payload.id,
				sensitivePassphrase: 'incorrect launch secret',
			}),
		});
		expect(response.status).toBe(400);
		const launched = await json(response);
		expect(launched.ok).toBe(false);
		expect(launched.code).toBe('sensitive_passphrase_rejected');
		const projects = await json(await app.request(`/v1/projects?teamId=${team.id}`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(projects.payload.find((project: { slug: string }) => project.slug === 'wrong-passphrase-launch')).toBeUndefined();
		const serialized = JSON.stringify(launched);
		expect(serialized).not.toContain('correct launch secret');
		expect(serialized).not.toContain('incorrect launch secret');
		expect(serialized).not.toContain('github_pat_secret_for_failure_test');
		});
	});
});
