import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, Core, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../support/api-harness.ts';

describe('market api', () => {
it('rejects plaintext host credential fields on every host write route', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);
		const headers = {
			'content-type': 'application/json',
			authorization: `Bearer ${token}`,
		};
		const encryptedPayload = encryptedHostEnvelope();

		const repositoryPlaintext = await json(await app.request(`/v1/teams/${team.id}/repository-hosts`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				name: 'Unsafe GitHub',
				organizationOrOwner: 'example-org',
				ownership: 'team_owned',
				githubToken: 'ghp_plaintext',
				encryptedPayload,
			}),
		}));
		expect(repositoryPlaintext.ok).toBe(false);
		expect(repositoryPlaintext.error).toBe('Host credential values must be encrypted in encryptedPayload before submission.');
		expect(repositoryPlaintext.fields).toContain('githubToken');

		const genericPlaintext = await json(await app.request(`/v1/teams/${team.id}/hosts`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				name: 'Unsafe SMTP',
				provider: 'smtp',
				ownership: 'team_owned',
				metadata: {
					hostType: 'email',
					smtp: {
						host: 'smtp.example.com',
						port: '587',
						fromEmail: 'hello@example.com',
						replyTo: 'support@example.com',
						secure: 'false',
					},
				},
				smtpPassword: 'plain-smtp-password',
				encryptedPayload,
			}),
		}));
		expect(genericPlaintext.ok).toBe(false);
		expect(genericPlaintext.error).toBe('Host credential values must be encrypted in encryptedPayload before submission.');
		expect(genericPlaintext.fields).toContain('smtpPassword');
		expect(genericPlaintext.fields).not.toContain('metadata.smtp.host');
		expect(genericPlaintext.fields).not.toContain('metadata.smtp.port');

		const smtpPublicSettings = await json(await app.request(`/v1/teams/${team.id}/hosts`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				name: 'SMTP public settings',
				provider: 'smtp',
				ownership: 'team_owned',
				metadata: {
					hostType: 'email',
					smtp: {
						host: 'smtp.example.com',
						port: '587',
						fromEmail: 'hello@example.com',
						replyTo: 'support@example.com',
						secure: 'false',
					},
				},
				encryptedPayload,
			}),
		}));
		expect(smtpPublicSettings.ok).toBe(true);
		expect(smtpPublicSettings.payload.metadata.smtp).toMatchObject({
			host: 'smtp.example.com',
			port: '587',
			fromEmail: 'hello@example.com',
			replyTo: 'support@example.com',
			secure: 'false',
		});

		const webPlaintext = await json(await app.request(`/v1/teams/${team.id}/hosts`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				name: 'Unsafe Cloudflare',
				provider: 'cloudflare',
				ownership: 'team_owned',
				metadata: { hostType: 'web' },
				cloudflareApiToken: 'plain-cloudflare-token',
				encryptedPayload,
			}),
		}));
		expect(webPlaintext.ok).toBe(false);
		expect(webPlaintext.error).toBe('Host credential values must be encrypted in encryptedPayload before submission.');
		expect(webPlaintext.fields).toContain('cloudflareApiToken');
	});
});
