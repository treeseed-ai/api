import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listTreeseedManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, treeseedCore, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../support/api-harness.ts';

describe('market api', () => {
it('owns web auth lifecycle and acceptance session seeding in the API', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const signup = await json(await app.request('/v1/auth/web/sign-up', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				email: 'api-auth@example.com',
				username: 'api-auth-user',
				password: 'TreeSeed-auth-test-123!',
				name: 'API Auth User',
				colorScheme: 'cedar',
				themeMode: 'dark',
			}),
		}));
		expect(signup.ok).toBe(true);
		expect(signup.payload).toMatchObject({
			confirmationRequired: true,
			email: 'api-auth@example.com',
			confirmationToken: expect.any(String),
		});
		const pendingSignin = await json(await app.request('/v1/auth/web/sign-in', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				email: 'api-auth@example.com',
				password: 'TreeSeed-auth-test-123!',
			}),
		}));
		expect(pendingSignin.ok).toBe(false);
		expect(pendingSignin.code).toBe('email_confirmation_required');
		const confirmed = await json(await app.request('/v1/auth/web/confirm-email', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ token: signup.payload.confirmationToken }),
		}));
		expect(confirmed.ok).toBe(true);
		expect(confirmed.payload.accessToken).toEqual(expect.any(String));
		expect(confirmed.payload.principal.metadata.appearance).toEqual({ scheme: 'cedar', mode: 'dark' });
		const personalTeam = await store.getTeamBySlug('api-auth-user');
		expect(personalTeam).toMatchObject({
			name: 'api-auth-user',
			displayName: 'API Auth User',
			metadata: {
				kind: 'personal_research',
				ownerUserId: confirmed.payload.principal.id,
			},
		});
		expect(await store.listTeamMembers(personalTeam!.id)).toEqual([
			expect.objectContaining({
				userId: confirmed.payload.principal.id,
				roles: expect.arrayContaining(['team_owner']),
			}),
		]);
		await expect(store.ensurePersonalResearchTeamForUser(confirmed.payload.principal.id)).resolves.toMatchObject({
			ok: true,
			created: false,
		});
		expect((await store.all(`SELECT id FROM teams WHERE slug = ?`, ['api-auth-user'])).length).toBe(1);
		const signin = await json(await app.request('/v1/auth/web/sign-in', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'user-agent': 'Treeseed Test Browser/1.0',
				'x-forwarded-for': '203.0.113.9, 10.0.0.2',
			},
			body: JSON.stringify({
				email: 'api-auth@example.com',
				password: 'TreeSeed-auth-test-123!',
			}),
		}));
		expect(signin.ok).toBe(true);
		expect(signin.payload.principal.metadata.appearance).toEqual({ scheme: 'cedar', mode: 'dark' });
		const appearance = await json(await app.request('/v1/auth/web/appearance', {
			method: 'PATCH',
			headers: {
				authorization: `Bearer ${signin.payload.accessToken}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ colorScheme: 'tidepool', themeMode: 'light' }),
		}));
		expect(appearance.ok).toBe(true);
		expect(appearance.payload.scheme).toBe('tidepool');
		expect(appearance.payload.mode).toBe('light');
		expect(appearance.payload.accessToken).toEqual(expect.any(String));
		expect(appearance.payload.principal.metadata.appearance).toEqual({ scheme: 'tidepool', mode: 'light' });
		const sessions = await json(await app.request('/v1/auth/web/sessions', {
			headers: { authorization: `Bearer ${signin.payload.accessToken}` },
		}));
		expect(sessions.ok).toBe(true);
		expect(sessions.payload.length).toBeGreaterThan(0);
		expect(sessions.payload).toContainEqual(expect.objectContaining({
			ipAddress: '203.0.113.9',
			userAgent: 'Treeseed Test Browser/1.0',
		}));
		const seeded = await json(await app.request('/v1/acceptance/seed', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-treeseed-service-id': 'web',
				'x-treeseed-service-secret': 'web-test-secret',
			},
			body: JSON.stringify({ namespace: 'acceptance-local-mr4vfvtg-28658395780-1-0a9242de' }),
		}));
		expect(seeded.ok).toBe(true);
		expect(seeded.payload.actors.siteAdmin.accessToken).toEqual(expect.any(String));
		const usernames = Object.values(seeded.payload.actors).map((actor: any) => actor.username).filter(Boolean);
		expect(new Set(usernames).size).toBe(usernames.length);
		expect(seeded.payload.actors.siteAdmin.username).toContain('siteadmin');
		expect(seeded.payload.actors.marketSteward.username).toContain('marketsteward');
		expect(seeded.payload.fixtures.team.id).toEqual(expect.any(String));
		expect(seeded.payload.fixtures.project.id).toEqual(expect.any(String));
		expect(seeded.payload.fixtures.platformOperation.id).toEqual(expect.any(String));
		expect(seeded.payload.fixtures.platformRunner.id).toEqual(expect.any(String));
		expect(seeded.payload.fixtures.host.id).toEqual(expect.any(String));
		expect(seeded.payload.fixtures.catalogItem.id).toEqual(expect.any(String));
		expect(seeded.payload.fixtures.catalogArtifact.version).toBe('1.0.0');
		expect(seeded.payload.fixtures.seedRun.id).toEqual(expect.any(String));
		expect(seeded.payload.fixtures.passwordReset.token).toEqual(expect.any(String));
		await store.run(`DELETE FROM user_identities WHERE provider = ? AND provider_subject = ?`, [
			'acceptance',
			'acceptance-local-mr4vfvtg-28658395780-1-0a9242de:siteAdmin',
		]);
		const reseeded = await json(await app.request('/v1/acceptance/seed', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-treeseed-service-id': 'web',
				'x-treeseed-service-secret': 'web-test-secret',
			},
			body: JSON.stringify({ namespace: 'acceptance-local-mr4vfvtg-28658395780-1-0a9242de' }),
		}));
		expect(reseeded.ok).toBe(true);
		expect(reseeded.payload.actors.siteAdmin.userId).toBe(seeded.payload.actors.siteAdmin.userId);
		const details = await store.getProjectDetails(seeded.payload.fixtures.project.id);
		expect(details).not.toBeNull();
		expect(details!.project.metadata).toMatchObject({
			sourceKind: 'template',
			sourceRef: 'research',
			hostBindings: {
				sourceRepository: expect.objectContaining({ provider: 'github' }),
				publicWeb: expect.objectContaining({ provider: 'cloudflare', managedHostKey: 'treeseed-managed-web' }),
			},
			hostBindingPlans: {
				configWrites: expect.any(Array),
				secretDeployment: expect.objectContaining({ items: expect.any(Array) }),
			},
		});
		expect(details!.repositories).toEqual(expect.arrayContaining([
			expect.objectContaining({ provider: 'github', role: 'software', status: 'ready' }),
		]));
		expect(details!.environments).toEqual(expect.arrayContaining([
			expect.objectContaining({ environment: 'staging', deploymentProfile: 'hosted_project' }),
			expect.objectContaining({ environment: 'prod', deploymentProfile: 'hosted_project' }),
		]));
		expect(await store.listTeamWebHosts(seeded.payload.fixtures.team.id)).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: seeded.payload.fixtures.host.id, provider: 'cloudflare', status: 'active' }),
		]));
		const runners = await store.listMarketOperationRunners({ limit: 10 });
		expect(runners.find((runner: any) => runner.id === seeded.payload.fixtures.platformRunner.id)?.capabilities).toContain('project:web_deployment');
	}, 30000);
});
