import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataType, newDb } from 'pg-mem';
import * as treeseedCore from '@treeseed/sdk';
import { AgentSdk, PlatformRunnerClient } from '@treeseed/sdk';
import { createApiApp } from '../../src/api/app.js';
import { MarketPostgresDatabase } from '../../src/api/market-postgres.js';
import { MarketControlPlaneStore } from '../../src/api/store.js';
import { encryptHostConfig } from '../../src/crypto/host-crypto.ts';
import { listTreeseedManagedHostsFromConfig } from '../../src/market/managed-hosts.js';
import { runOnceWithClient } from '../../src/operations-runner/entrypoint.js';

const runTreeseedHostingAuditMock = vi.hoisted(() => vi.fn(async (input: Record<string, unknown> = {}) => ({
	ok: true,
	environment: input.environment === 'prod' ? 'prod' : input.environment === 'local' ? 'local' : 'staging',
	requestedEnvironment: input.environment ?? 'current',
	repairMode: input.repair === true,
	repaired: false,
	target: { kind: 'persistent', scope: input.environment === 'prod' ? 'prod' : 'staging', label: input.environment === 'prod' ? 'prod' : 'staging' },
	hostKinds: input.hostKinds ?? ['repository', 'web', 'email'],
	checkedAt: '2026-01-01T00:00:00.000Z',
	checks: [],
	missingConfig: [],
	resources: {},
	warnings: [],
	blockers: [],
	nextActions: ['Hosting setup is ready for host saving and project launch.'],
})));

const executeKnowledgeHubProviderLaunchMock = vi.hoisted(() => vi.fn());

vi.mock('@treeseed/sdk', async (importOriginal) => {
	return {
	...(await importOriginal<typeof import('@treeseed/sdk')>()),
	COMMERCE_PRODUCT_KINDS: [
		'template',
		'knowledge_pack',
		'ui_library',
		'admin_interface',
		'api_platform',
		'hosted_project',
		'professional_hosting',
		'scoped_service',
		'capacity_listing',
	],
	COMMERCE_OFFER_MODES: [
		'free',
		'private',
		'contact',
		'one_time',
		'one_time_current_version',
		'subscription',
		'subscription_updates',
		'professional_hosting',
		'scoped_contract',
		'external',
	],
	COMMERCE_VENDOR_TRUST_LEVELS: [
		'public_publisher',
		'verified_seller',
		'trusted_service_vendor',
		'trusted_capacity_vendor',
		'integration_partner',
	],
	COMMERCE_GOVERNANCE_STATES: [
		'draft',
		'submitted',
		'approved',
		'rejected',
		'suspended',
		'archived',
	],
	COMMERCE_OWNERSHIP_MODELS: [
		'team_owned',
		'individual_contributor_owned',
		'multi_contributor_attributed',
		'steward_maintained',
		'cooperative_owned',
		'community_governed',
		'foundation_or_trust_held',
		'transferred_or_succeeded',
	],
	COMMERCE_STEWARDSHIP_ROLES: [
		'owner',
		'seller',
		'maintainer',
		'governance_steward',
		'support_steward',
		'security_steward',
		'community_steward',
		'successor',
	],
	COMMERCE_STRIPE_ACCOUNT_STATUSES: [
		'not_started',
		'pending',
		'restricted',
		'enabled',
		'disabled',
	],
	COMMERCE_STRIPE_ENVIRONMENTS: ['test', 'live'],
	COMMERCE_STRIPE_ONBOARDING_STATUSES: [
		'not_started',
		'started',
		'returned',
		'completed',
		'expired',
	],
	executeKnowledgeHubProviderLaunch: executeKnowledgeHubProviderLaunchMock,
	};
});

vi.mock('@treeseed/sdk/workflow-support', async (importOriginal) => ({
	...(await importOriginal<typeof import('@treeseed/sdk/workflow-support')>()),
	runTreeseedHostingAudit: runTreeseedHostingAuditMock,
}));

const packageRoot = process.cwd();
const marketMigrationRoot = existsSync(resolve(packageRoot, '../sdk/drizzle/market'))
	? resolve(packageRoot, '../sdk/drizzle/market')
	: resolve(packageRoot, 'node_modules/@treeseed/sdk/drizzle/market');

async function withEnv<T>(values: Record<string, string | undefined>, action: () => T | Promise<T>) {
	const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
	for (const [key, value] of Object.entries(values)) {
		if (value == null) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	try {
		return await action();
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value == null) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

async function waitForCondition(assertion: () => Promise<boolean> | boolean, timeoutMs = 1500) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await assertion()) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return false;
}

function createTestPostgresDatabase() {
	const memory = newDb();
	memory.public.registerFunction({
		name: 'md5',
		args: [DataType.text],
		returns: DataType.text,
		implementation: (value: string) => `md5:${value}`,
	});
	const pg = memory.adapters.createPg();
	return MarketPostgresDatabase.fromPool(new pg.Pool(), { migrationRoot: marketMigrationRoot });
}

type ApiTestOptions = {
	db?: ReturnType<typeof createTestPostgresDatabase>;
	store?: MarketControlPlaneStore;
	sdk?: AgentSdk;
	config?: Record<string, unknown>;
	fetchImpl?: typeof fetch;
	logRequests?: boolean;
	mockExternal?: boolean;
	stripeConnectService?: any;
};

function createTestApp(options: ApiTestOptions = {}) {
	return createApiApp({
		...options,
		db: options.db ?? createTestPostgresDatabase(),
		sdk: options.sdk ?? new AgentSdk({
			repoRoot: packageRoot,
		}),
		config: {
			repoRoot: packageRoot,
			authSecret: 'test-secret',
			baseUrl: 'https://market.example.com',
			siteUrl: 'https://market.example.com',
			issuer: 'https://market.example.com',
			projectId: 'treeseed-market',
			projectApiKey: 'market-project-key',
			projectApiPermissions: ['sdk:execute:global', 'agent:execute:global', 'operations:execute:global'],
			webServiceId: 'web',
			webServiceSecret: 'web-test-secret',
			webAssertionSecret: 'web-assertion-secret',
			...(options.config ?? {}),
		},
	});
}

function createTestStore(db = createTestPostgresDatabase()) {
	return new MarketControlPlaneStore({
		repoRoot: packageRoot,
		authSecret: 'test-secret',
		baseUrl: 'https://market.example.com',
		siteUrl: 'https://market.example.com',
		issuer: 'https://market.example.com',
		projectId: 'treeseed-market',
		projectApiKey: 'market-project-key',
		projectApiPermissions: ['sdk:execute:global', 'agent:execute:global', 'operations:execute:global'],
		serviceId: 'web',
		serviceSecret: 'web-test-secret',
		assertionSecret: 'web-assertion-secret',
	}, db);
}

async function json(response: Response) {
	return response.json() as Promise<any>;
}

function git(cwd: string, args: string[]) {
	return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function withHttpMarketApp<T>(app: ReturnType<typeof createTestApp>, action: (baseUrl: string) => Promise<T>) {
	const server = createServer((request, response) => {
		void (async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
			const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
			const webResponse = await app.fetch(new Request(url, {
				method: request.method,
				headers: request.headers as HeadersInit,
				body,
			}));
			response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers.entries()));
			response.end(Buffer.from(await webResponse.arrayBuffer()));
		})().catch((error) => {
			response.writeHead(500, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
		});
	});
	await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
	const address = server.address();
	const baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
	try {
		return await action(baseUrl);
	} finally {
		await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
	}
}

function createRunnerRepoFixture() {
	const root = mkdtempSync(resolve(tmpdir(), 'treeseed-operations-runner-'));
	const repo = resolve(root, 'repo');
	const workspace = resolve(root, 'workspace');
	mkdirSync(resolve(repo, 'src/content/notes'), { recursive: true });
	mkdirSync(workspace, { recursive: true });
	writeFileSync(resolve(repo, 'README.md'), 'runner fixture\n', 'utf8');
	git(repo, ['init', '-b', 'staging']);
	git(repo, ['config', 'user.email', 'test@example.com']);
	git(repo, ['config', 'user.name', 'TreeSeed Test']);
	git(repo, ['add', '.']);
	git(repo, ['commit', '-m', 'init']);
	return { root, repo, workspace };
}

function unsignedTestJwt(payload: Record<string, unknown>) {
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
	return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.`;
}

async function authorizeApp(app: ReturnType<typeof createTestApp>, input: { principalId?: string; displayName?: string } = {}) {
	const started = await json(await app.request('/auth/device/start', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ scopes: ['auth:me'] }),
	}));
	await app.request('/auth/device/approve', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			userCode: started.userCode,
			principalId: input.principalId ?? 'user-1',
			displayName: input.displayName ?? 'Market User',
			scopes: ['auth:me'],
		}),
	});
	const tokenPayload = await json(await app.request('/auth/device/poll', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ deviceCode: started.deviceCode }),
	}));
	return tokenPayload.accessToken as string;
}

async function createTeamAndProject(app: ReturnType<typeof createTestApp>, token: string, projectInput: Record<string, unknown>) {
	const team = await json(await app.request('/v1/teams', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({ slug: 'team-one', name: 'Team One' }),
	}));
	const project = await json(await app.request(`/v1/teams/${team.payload.id}/projects`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			authorization: `Bearer ${token}`,
		},
		body: JSON.stringify(projectInput),
	}));
	return {
		team: team.payload,
		project: project.payload.project,
	};
}

async function createTeam(app: ReturnType<typeof createTestApp>, token: string) {
	const team = await json(await app.request('/v1/teams', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({ slug: 'team-one', name: 'Team One' }),
	}));
	return team.payload;
}

function encryptedHostEnvelope(overrides: Record<string, unknown> = {}) {
	return {
		version: 1,
		algorithm: 'secretbox',
		kdf: {
			algorithm: 'argon2id',
			opsLimit: 2,
			memLimit: 67108864,
		},
		salt: 'c2FsdA==',
		nonce: 'bm9uY2U=',
		ciphertext: 'Y2lwaGVydGV4dA==',
		...overrides,
	};
}

function encryptedTestHostEnvelope(config: Record<string, unknown>, passphrase: string) {
	return encryptedHostEnvelope({
		algorithm: 'test-json',
		passphrase,
		ciphertext: Buffer.from(JSON.stringify(config), 'utf8').toString('base64'),
	});
}

function mockCloudflareDnsPreflight({ createOk = true } = {}) {
	return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
		const url = String(input);
		const method = String(init.method ?? 'GET').toUpperCase();
		if (url.includes('/zones?')) {
			return new Response(JSON.stringify({ success: true, result: [{ id: 'zone-1', name: 'example.test' }] }), { status: 200 });
		}
		if (url.includes('/dns_records') && method === 'POST') {
			if (!createOk) {
				return new Response(JSON.stringify({
					success: false,
					errors: [{ code: 10000, message: 'Authentication error' }],
				}), { status: 403 });
			}
			return new Response(JSON.stringify({ success: true, result: { id: 'dns-preflight-record' } }), { status: 200 });
		}
		if (url.includes('/dns_records/dns-preflight-record') && method === 'DELETE') {
			return new Response(JSON.stringify({ success: true, result: { id: 'dns-preflight-record' } }), { status: 200 });
		}
		return new Response(JSON.stringify({ success: true, result: {} }), { status: 200 });
	});
}

async function createDeploymentReadyProject(id: string) {
	const db = createTestPostgresDatabase();
	const store = createTestStore(db);
	const app = createTestApp({
		db,
		store,
		config: {
			platformRunnerSecret: 'platform-runner-secret',
		},
	});
	const token = await authorizeApp(app);
	const { team, project } = await createTeamAndProject(app, token, {
		id,
		slug: id,
		name: id.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' '),
	});
	await store.upsertHubRepository(project.id, {
		teamId: team.id,
		role: 'software',
		provider: 'github',
		owner: 'treeseed-ai',
		name: id,
		url: `https://github.com/treeseed-ai/${id}`,
		defaultBranch: 'staging',
		status: 'ready',
	});
	await json(await app.request(`/v1/teams/${team.id}/web-hosts`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
		body: JSON.stringify({
			name: 'Team Cloudflare',
			ownership: 'team_owned',
			encryptedPayload: encryptedHostEnvelope(),
		}),
	}));
	await store.upsertProjectEnvironment(project.id, {
		environment: 'staging',
		deploymentProfile: 'hosted_project',
		baseUrl: `https://staging.${id}.example.com`,
		pagesProjectName: id,
	});
	return { app, db, store, token, team, project };
}

describe('market api', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		executeKnowledgeHubProviderLaunchMock.mockReset();
		runTreeseedHostingAuditMock.mockReset();
		runTreeseedHostingAuditMock.mockImplementation(async (input: Record<string, unknown> = {}) => ({
			ok: true,
			environment: input.environment === 'prod' ? 'prod' : input.environment === 'local' ? 'local' : 'staging',
			requestedEnvironment: input.environment ?? 'current',
			repairMode: input.repair === true,
			repaired: false,
			target: { kind: 'persistent', scope: input.environment === 'prod' ? 'prod' : 'staging', label: input.environment === 'prod' ? 'prod' : 'staging' },
			hostKinds: input.hostKinds ?? ['repository', 'web', 'email'],
			checkedAt: '2026-01-01T00:00:00.000Z',
			checks: [],
			missingConfig: [],
			resources: {},
			warnings: [],
			blockers: [],
			nextActions: ['Hosting setup is ready for host saving and project launch.'],
		}));
	});

	it('allows local acceptance admin token to manage workday runs in local mode', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		try {
			await store.ensureInitialized();
			await store.createTeam({ id: 'treeseed', slug: 'treeseed', name: 'TreeSeed' });
			const app = createTestApp({ db, store, config: { environment: 'local' } });
			const headers = {
				'content-type': 'application/json',
				authorization: 'Bearer tsk_local_treeseed_acceptance_admin',
			};
			const created = await app.request('/v1/teams/treeseed/workday-runs', {
				method: 'POST',
				headers,
				body: JSON.stringify({
					id: 'run-local-acceptance',
					capacityProviderId: 'provider-local',
					status: 'running',
					parameters: { authMode: 'local_acceptance_admin' },
				}),
			});
			expect(created.status).toBe(201);
			const createdPayload = await json(created);
			expect(createdPayload.payload).toMatchObject({
				id: 'run-local-acceptance',
				requestedById: 'team-key:local-capacity-acceptance',
			});

			const event = await app.request('/v1/teams/treeseed/workday-runs/run-local-acceptance/events', {
				method: 'POST',
				headers,
				body: JSON.stringify({
					eventType: 'command.started',
					title: 'Started with local acceptance auth',
				}),
			});
			expect(event.status).toBe(201);

			const listed = await json(await app.request('/v1/teams/treeseed/workday-runs', { headers }));
			expect(listed.payload.map((run: Record<string, unknown>) => run.id)).toContain('run-local-acceptance');
		} finally {
			db.close();
		}
	});

	it('rejects unauthenticated workday run mutation without local acceptance auth', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		try {
			await store.ensureInitialized();
			await store.createTeam({ id: 'treeseed', slug: 'treeseed', name: 'TreeSeed' });
			const app = createTestApp({ db, store, config: { environment: 'staging' } });
			const response = await app.request('/v1/teams/treeseed/workday-runs', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ id: 'run-hosted-denied', status: 'running' }),
			});
			expect(response.status).toBe(401);
		} finally {
			db.close();
		}
	});

	it('logs local API request URLs with sensitive query values redacted', async () => {
		const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		const app = createTestApp({ logRequests: true });

		const response = await app.request('/v1/markets/current?token=secret-token&teamId=team-1');

		expect(response.status).toBe(200);
		expect(write).toHaveBeenCalledWith(expect.stringContaining('[api] GET /v1/markets/current?token=[redacted]&teamId=team-1 -> 200'));
	});

	it('owns web auth lifecycle and acceptance session seeding in the API', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store, mockExternal: true });
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
			body: JSON.stringify({ namespace: 'acceptance-test' }),
		}));
		expect(seeded.ok).toBe(true);
		expect(seeded.payload.actors.siteAdmin.accessToken).toEqual(expect.any(String));
		expect(seeded.payload.actors.providerKey.accessToken).toEqual(expect.any(String));
		expect(seeded.payload.fixtures.team.id).toEqual(expect.any(String));
		expect(seeded.payload.fixtures.project.id).toEqual(expect.any(String));
		expect(seeded.payload.fixtures.provider.id).toEqual(expect.any(String));
		expect(seeded.payload.fixtures.platformOperation.id).toEqual(expect.any(String));
		expect(seeded.payload.fixtures.platformRunner.id).toEqual(expect.any(String));
		expect(seeded.payload.fixtures.host.id).toEqual(expect.any(String));
		expect(seeded.payload.fixtures.catalogItem.id).toEqual(expect.any(String));
		expect(seeded.payload.fixtures.catalogArtifact.version).toBe('1.0.0');
		expect(seeded.payload.fixtures.seedRun.id).toEqual(expect.any(String));
		expect(seeded.payload.fixtures.passwordReset.token).toEqual(expect.any(String));
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

	it('supports TreeSeed Commons governance participation', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store, mockExternal: true });
		async function signUpParticipant(email: string, username: string, name: string) {
			const signup = await json(await app.request('/v1/auth/web/sign-up', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ email, username, password: 'TreeSeed-commons-test-123!', name }),
			}));
			expect(signup.ok).toBe(true);
			const confirmed = await json(await app.request('/v1/auth/web/confirm-email', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ token: signup.payload.confirmationToken }),
			}));
			expect(confirmed.ok).toBe(true);
			return confirmed.payload;
		}

		const first = await signUpParticipant('commons-one@example.com', 'commons-one', 'Commons One');
		const second = await signUpParticipant('commons-two@example.com', 'commons-two', 'Commons Two');
		expect(await store.getTeamBySlug('treeseed')).toMatchObject({ id: 'treeseed', displayName: 'TreeSeed' });
		expect(await store.listTeamMembers('treeseed')).toEqual(expect.arrayContaining([
			expect.objectContaining({ userId: first.principal.id, roles: ['viewer'] }),
			expect.objectContaining({ userId: second.principal.id, roles: ['viewer'] }),
		]));

		const me = await json(await app.request('/v1/commons/participants/me', {
			headers: { authorization: `Bearer ${first.accessToken}` },
		}));
		expect(me.ok).toBe(true);
		expect(me.payload).toMatchObject({
			userId: first.principal.id,
			teamId: 'treeseed',
			status: 'active',
			verifiedEmail: true,
		});

		const question = await json(await app.request('/v1/commons/questions', {
			method: 'POST',
			headers: { authorization: `Bearer ${first.accessToken}`, 'content-type': 'application/json' },
			body: JSON.stringify({
				title: 'How should the Commons prioritize engineering work?',
				body: 'I want a structured way to raise roadmap questions before proposals.',
			}),
		}));
		expect(question.ok).toBe(true);
		expect(question.payload.status).toBe('open');

		const proposal = await json(await app.request('/v1/commons/proposals', {
			method: 'POST',
			headers: { authorization: `Bearer ${first.accessToken}`, 'content-type': 'application/json' },
			body: JSON.stringify({
				title: 'Create a Commons proposal lane',
				summary: 'Participants can submit, back, vote, and steward decisions.',
				body: 'The lane should preserve cooperative governance and ownership model boundaries.',
			}),
		}));
		expect(proposal.ok).toBe(true);
		expect(proposal.payload.status).toBe('draft');
		const submitted = await json(await app.request(`/v1/commons/proposals/${proposal.payload.id}/submit`, {
			method: 'POST',
			headers: { authorization: `Bearer ${first.accessToken}` },
		}));
		expect(submitted.ok).toBe(true);
		expect(submitted.payload.status).toBe('submitted');

		const backed = await json(await app.request(`/v1/commons/proposals/${proposal.payload.id}/back`, {
			method: 'POST',
			headers: { authorization: `Bearer ${second.accessToken}`, 'content-type': 'application/json' },
			body: JSON.stringify({ reason: 'This improves participant signal without making votes automatically binding.' }),
		}));
		expect(backed.ok).toBe(true);
		expect(backed.payload.backingCount).toBe(1);
		expect(backed.payload.status).toBe('backing');

		const seeded = await json(await app.request('/v1/acceptance/seed', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-treeseed-service-id': 'web',
				'x-treeseed-service-secret': 'web-test-secret',
			},
			body: JSON.stringify({ namespace: 'commons-governance' }),
		}));
		const adminToken = seeded.payload.actors.siteAdmin.accessToken;
		const voting = await json(await app.request(`/v1/commons/proposals/${proposal.payload.id}/start-voting`, {
			method: 'POST',
			headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
			body: JSON.stringify({ reason: 'Steward opened a bounded voting window.' }),
		}));
		expect(voting.ok).toBe(true);
		expect(voting.payload.status).toBe('voting');

		const voted = await json(await app.request(`/v1/commons/proposals/${proposal.payload.id}/vote`, {
			method: 'POST',
			headers: { authorization: `Bearer ${first.accessToken}`, 'content-type': 'application/json' },
			body: JSON.stringify({ vote: 'support', reason: 'Transparent participant governance matters.' }),
		}));
		expect(voted.ok).toBe(true);
		expect(voted.payload.voteSupportWeight).toBeGreaterThan(0);

		const decision = await json(await app.request(`/v1/commons/proposals/${proposal.payload.id}/steward-decision`, {
			method: 'POST',
			headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
			body: JSON.stringify({
				status: 'accepted',
				reason: 'Accepted as advisory Commons capacity.',
				capacityBudget: 'commons',
			}),
		}));
		expect(decision.ok).toBe(true);
		expect(decision.payload.proposal.status).toBe('accepted');
		expect(decision.payload.decision.status).toBe('accepted');

		const secondParticipant = await store.getCommonsParticipantByUserId(second.principal.id);
		const delegation = await json(await app.request('/v1/commons/delegations', {
			method: 'POST',
			headers: { authorization: `Bearer ${first.accessToken}`, 'content-type': 'application/json' },
			body: JSON.stringify({
				toParticipantId: secondParticipant!.id,
				scope: 'treeseed_commons',
				reason: 'Delegate Commons review when unavailable.',
			}),
		}));
		expect(delegation.ok).toBe(true);
		expect(delegation.payload.status).toBe('active');

		const events = await json(await app.request(`/v1/commons/proposals/${proposal.payload.id}/events`));
		expect(events.ok).toBe(true);
		expect(events.payload.map((entry: any) => entry.eventType)).toEqual(expect.arrayContaining([
			'proposal.created',
			'proposal.submitted',
			'proposal.backed',
			'proposal.voting_started',
			'proposal.voted',
			'proposal.steward_decision',
			'decision.created',
		]));
		expect(JSON.stringify({ decision, events })).not.toMatch(/payout|commission|dividend|patronage|secret_?/iu);
	});

	it('creates accepted governance decisions from project proposals through admin approval', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store, mockExternal: true });
		const token = await authorizeApp(app, { principalId: 'project-governance-user', displayName: 'Project Governance User' });
		const { team, project } = await createTeamAndProject(app, token, {
			slug: 'governance-project',
			name: 'Governance Project',
		});
		const headers = {
			authorization: `Bearer ${token}`,
			'content-type': 'application/json',
		};

		const defaultPolicy = await json(await app.request(`/v1/projects/${project.id}/governance-policy`, { headers }));
		expect(defaultPolicy.ok).toBe(true);
		expect(defaultPolicy.payload).toMatchObject({
			teamId: team.id,
			providerId: 'admin_approval_v1',
			active: true,
		});

		const proposal = await json(await app.request(`/v1/projects/${project.id}/proposals`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				title: 'Adopt proposal governance',
				summary: 'Use accepted proposals as the only source of executable decisions.',
				body: 'The decision record should be generated from the accepted proposal snapshot and voting evidence.',
				proposalType: 'architecture',
			}),
		}));
		expect(proposal.ok).toBe(true);
		expect(proposal.payload).toMatchObject({
			projectId: project.id,
			status: 'draft',
			governanceProviderId: 'admin_approval_v1',
			activeVersion: 1,
		});

		const opened = await json(await app.request(`/v1/projects/${project.id}/proposals/${proposal.payload.id}/open`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ reason: 'Ready for manager approval.' }),
		}));
		expect(opened.ok).toBe(true);
		expect(opened.payload.status).toBe('open');

		const accepted = await json(await app.request(`/v1/projects/${project.id}/proposals/${proposal.payload.id}/admin-decision`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ status: 'approved', reason: 'Approved by project manager.' }),
		}));
		expect(accepted.ok).toBe(true);
		expect(accepted.payload.status).toBe('accepted');
		expect(accepted.payload.decisionId).toEqual(expect.any(String));
		expect(accepted.payload.outcome).toMatchObject({
			status: 'accepted',
			decisionEligible: true,
		});

		const decisions = await json(await app.request(`/v1/projects/${project.id}/decisions`, { headers }));
		expect(decisions.ok).toBe(true);
		expect(decisions.payload).toEqual([
			expect.objectContaining({
				proposalId: proposal.payload.id,
				status: 'accepted',
				proposalContentHash: proposal.payload.activeContentHash,
				governanceProviderId: 'admin_approval_v1',
			}),
		]);

		const events = await json(await app.request(`/v1/projects/${project.id}/proposals/${proposal.payload.id}/events`, { headers }));
		expect(events.ok).toBe(true);
		expect(events.payload.map((event: any) => event.eventType)).toEqual(expect.arrayContaining([
			'proposal.created',
			'proposal.open',
			'proposal.accepted',
			'decision.created',
		]));
	});

	it('keeps public usernames and team slugs in one namespace', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store, mockExternal: true });
		await store.createTeam({
			name: 'reserved-team',
			displayName: 'Reserved Team',
		});

		const unavailable = await json(await app.request('/v1/auth/web/username/check?username=reserved-team'));
		expect(unavailable.payload).toMatchObject({
			username: 'reserved-team',
			available: false,
			status: 'taken',
			message: 'Username is already taken by a team.',
		});

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

	it('deletes projects and project-owned records through the project API', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const token = await authorizeApp(app);
		const { team, project } = await createTeamAndProject(app, token, {
			slug: 'delete-me',
			name: 'Delete Me',
			description: 'Temporary project',
		});
		const headers = {
			'content-type': 'application/json',
			authorization: `Bearer ${token}`,
		};

		const blockers = await json(await app.request(`/v1/projects/${project.id}/deletion-blockers`, { headers }));
		expect(blockers.ok).toBe(true);
		expect(blockers.payload).toEqual([]);

		await app.request(`/v1/projects/${project.id}/work-policy`, {
			method: 'PUT',
			headers,
			body: JSON.stringify({
				environment: 'local',
				enabled: true,
				dailyCreditBudget: 100,
			}),
		});

		const rejected = await json(await app.request(`/v1/projects/${project.id}`, {
			method: 'DELETE',
			headers,
			body: JSON.stringify({ confirmation: 'DELETE wrong' }),
		}));
		expect(rejected.ok).toBe(false);
		expect(rejected.code).toBe('confirmation');

		const deleted = await json(await app.request(`/v1/projects/${project.id}`, {
			method: 'DELETE',
			headers,
			body: JSON.stringify({ confirmation: 'DELETE delete-me' }),
		}));
		expect(deleted.ok).toBe(true);
		expect(deleted.payload.projectId).toBe(project.id);
		expect(deleted.deploymentHref).toBe(`/app/projects/deployment/${deleted.payload.id}`);

		const after = await app.request(`/v1/projects/${project.id}`, {
			headers: { authorization: `Bearer ${token}` },
		});
		expect(after.status).toBe(200);
		expect(await waitForCondition(async () => {
			const job = await store.findJobById(deleted.job.id);
			const deployment = await store.findProjectDeploymentById(deleted.payload.id);
			return job?.status === 'completed' && deployment?.status === 'succeeded';
		})).toBe(true);
		const deployment = await store.findProjectDeploymentById(deleted.payload.id);
		expect(deployment?.action).toBe('delete_project');
		expect(deployment?.status).toBe('succeeded');
		expect((await store.getProject(project.id))?.metadata.deletion.status).toBe('succeeded');
		const projects = await json(await app.request(`/v1/projects?teamId=${team.id}`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(projects.payload.find((entry: { id: string }) => entry.id === project.id)).toBeUndefined();
		const profile = await json(await app.request(`/v1/teams/by-name/${team.name}/profile`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(profile.payload.activity.projects.find((entry: { id: string }) => entry.id === project.id)).toBeUndefined();
	}, 30000);

	it('updates project profile settings through the project API', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const token = await authorizeApp(app);
		const { team, project } = await createTeamAndProject(app, token, {
			slug: 'settings-before',
			name: 'Settings Before',
			description: 'Before description',
		});
		const headers = {
			'content-type': 'application/json',
			authorization: `Bearer ${token}`,
		};

		const updated = await json(await app.request(`/v1/projects/${project.id}`, {
			method: 'PUT',
			headers,
			body: JSON.stringify({
				slug: 'settings-after',
				name: 'Settings After',
				description: 'After description',
			}),
		}));
		expect(updated.ok).toBe(true);
		expect(updated.payload.project.slug).toBe('settings-after');
		expect(updated.payload.project.name).toBe('Settings After');

		const listed = await json(await app.request(`/v1/projects?teamId=${team.id}`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(listed.payload.find((entry: { id: string }) => entry.id === project.id)?.slug).toBe('settings-after');

		const duplicate = await json(await app.request(`/v1/teams/${team.id}/projects`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ slug: 'taken-project', name: 'Taken Project' }),
		}));
		const rejected = await json(await app.request(`/v1/projects/${duplicate.payload.project.id}`, {
			method: 'PUT',
			headers,
			body: JSON.stringify({
				slug: 'settings-after',
				name: 'Taken Project',
			}),
		}));
		expect(rejected.ok).toBe(false);
		expect(rejected.code).toBe('slug_taken');
	});

	it('scopes project slug uniqueness to a team', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const token = await authorizeApp(app);
		const headers = {
			'content-type': 'application/json',
			authorization: `Bearer ${token}`,
		};
		const firstTeam = await json(await app.request('/v1/teams', {
			method: 'POST',
			headers,
			body: JSON.stringify({ slug: 'slug-team-one', name: 'Slug Team One' }),
		}));
		const secondTeam = await json(await app.request('/v1/teams', {
			method: 'POST',
			headers,
			body: JSON.stringify({ slug: 'slug-team-two', name: 'Slug Team Two' }),
		}));

		const firstProject = await json(await app.request(`/v1/teams/${firstTeam.payload.id}/projects`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ slug: 'shared-slug', name: 'Shared Slug One' }),
		}));
		const secondProject = await json(await app.request(`/v1/teams/${secondTeam.payload.id}/projects`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ slug: 'shared-slug', name: 'Shared Slug Two' }),
		}));
		expect(firstProject.ok).toBe(true);
		expect(secondProject.ok).toBe(true);
		expect(firstProject.payload.project.teamId).toBe(firstTeam.payload.id);
		expect(secondProject.payload.project.teamId).toBe(secondTeam.payload.id);

		const duplicate = await json(await app.request(`/v1/teams/${firstTeam.payload.id}/projects`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ slug: 'shared-slug', name: 'Duplicate Shared Slug' }),
		}));
		expect(duplicate.ok).toBe(false);
		expect(duplicate.code).toBe('slug_taken');
	});

	it('blocks project deletion while active work is attached', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const { project } = await createTeamAndProject(app, token, {
			slug: 'busy-project',
			name: 'Busy Project',
		});
		const headers = {
			'content-type': 'application/json',
			authorization: `Bearer ${token}`,
		};

		await app.request(`/v1/projects/${project.id}/workday-requests`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				environment: 'local',
				type: 'one_off_run',
				reason: 'block deletion',
			}),
		});
		const blockers = await json(await app.request(`/v1/projects/${project.id}/deletion-blockers`, { headers }));
		expect(blockers.payload.some((entry: { code: string }) => entry.code === 'workday_request')).toBe(true);

		const deleted = await json(await app.request(`/v1/projects/${project.id}`, {
			method: 'DELETE',
			headers,
			body: JSON.stringify({ confirmation: 'DELETE busy-project' }),
		}));
		expect(deleted.ok).toBe(false);
		expect(deleted.code).toBe('blocked');
	});

	it('requires sensitive unlock and records project infrastructure cleanup status', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store, mockExternal: true });
		const token = await authorizeApp(app);
		const { team, project } = await createTeamAndProject(app, token, {
			slug: 'delete-hosted',
			name: 'Delete Hosted',
			metadata: {
				cloudflareHost: {
					mode: 'team_owned',
					hostId: 'web-host-delete',
					dns: { zoneName: 'example.test' },
					domains: {
						manageDns: true,
						zoneName: 'example.test',
						productionDomain: 'delete-hosted.example.test',
						stagingDomain: 'delete-hosted-staging.example.test',
					},
				},
			},
		});
		await store.upsertRepositoryHost(team.id, {
			id: 'repo-host-delete',
			name: 'Delete GitHub',
			organizationOrOwner: 'treeseed-sites',
			ownership: 'team_owned',
			encryptedPayload: encryptedTestHostEnvelope({ TREESEED_GITHUB_TOKEN: 'github-token', organizationOrOwner: 'treeseed-sites' }, 'pass'),
		});
		await store.createTeamWebHost(team.id, {
			id: 'web-host-delete',
			name: 'Delete Cloudflare',
			provider: 'cloudflare',
			ownership: 'team_owned',
			encryptedPayload: encryptedTestHostEnvelope({ TREESEED_CLOUDFLARE_API_TOKEN: 'cloudflare-token', TREESEED_CLOUDFLARE_ACCOUNT_ID: 'account-1' }, 'pass'),
			metadata: {
				dns: { managed: true, zoneName: 'example.test' },
			},
		});
		await store.upsertHubRepository(project.id, {
			teamId: team.id,
			role: 'software',
			repositoryHostId: 'repo-host-delete',
			provider: 'github',
			owner: 'treeseed-sites',
			name: 'delete-hosted-site',
			defaultBranch: 'main',
			status: 'active',
			metadata: { create: true },
		});
		await store.upsertProjectEnvironment(project.id, {
			environment: 'staging',
			deploymentProfile: 'hosted_project',
			baseUrl: 'https://delete-hosted-staging.example.test',
			cloudflareAccountId: 'account-1',
			pagesProjectName: 'delete-hosted-site',
				workerName: 'delete-hosted-staging-worker',
				r2BucketName: 'delete-hosted-content',
				d1DatabaseName: 'delete-hosted-site-data',
			});
		await store.upsertProjectInfrastructureResource(project.id, {
			environment: 'staging',
			provider: 'cloudflare',
			resourceKind: 'kv',
			logicalName: 'form_guard',
			locator: 'kv-form-guard-id',
			metadata: {
				id: 'kv-form-guard-id',
				name: 'delete-hosted-form-guard',
				binding: 'FORM_GUARD_KV',
			},
		});
		await store.upsertProjectInfrastructureResource(project.id, {
			environment: 'staging',
			provider: 'cloudflare',
			resourceKind: 'turnstile-widget',
			logicalName: 'form_guard_turnstile',
			locator: 'turnstile-sitekey-1',
			metadata: {
				sitekey: 'turnstile-sitekey-1',
				name: 'delete-hosted-turnstile-staging',
				mode: 'managed',
			},
		});
		const headers = {
			'content-type': 'application/json',
			authorization: `Bearer ${token}`,
		};
		const locked = await json(await app.request(`/v1/projects/${project.id}`, {
			method: 'DELETE',
			headers,
			body: JSON.stringify({ confirmation: 'DELETE delete-hosted' }),
		}));
		expect(locked.ok).toBe(false);
		expect(locked.code).toBe('sensitive_passphrase_rejected');

		const rejected = await json(await app.request(`/v1/projects/${project.id}`, {
			method: 'DELETE',
			headers,
			body: JSON.stringify({ confirmation: 'DELETE delete-hosted', sensitivePassphrase: 'pass' }),
		}));
		expect(rejected.ok).toBe(false);
		expect(rejected.code).toBe('sensitive_passphrase_rejected');
		expect(await store.listProjectDeployments(project.id, { action: 'delete_project', limit: 10 })).toEqual([]);
	});

	it('deletes recorded Cloudflare form guard KV namespaces during project deletion', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const token = await authorizeApp(app);
		const { team, project } = await createTeamAndProject(app, token, {
			slug: 'delete-form-guard-kv',
			name: 'Delete Form Guard KV',
			metadata: {
				cloudflareHost: {
					mode: 'team_owned',
					hostId: 'web-host-delete-kv',
				},
			},
		});
		await store.createTeamWebHost(team.id, {
			id: 'web-host-delete-kv',
			name: 'Delete KV Cloudflare',
			provider: 'cloudflare',
			ownership: 'team_owned',
			encryptedPayload: encryptedTestHostEnvelope({ TREESEED_CLOUDFLARE_API_TOKEN: 'cloudflare-token', TREESEED_CLOUDFLARE_ACCOUNT_ID: 'account-1' }, 'pass'),
			metadata: {},
		});
		await store.upsertProjectInfrastructureResource(project.id, {
			environment: 'staging',
			provider: 'cloudflare',
			resourceKind: 'kv',
			logicalName: 'form_guard',
			locator: 'kv-form-guard-id',
			metadata: {
				id: 'kv-form-guard-id',
				name: 'delete-form-guard-kv-namespace',
				binding: 'FORM_GUARD_KV',
			},
		});
		await store.upsertProjectInfrastructureResource(project.id, {
			environment: 'staging',
			provider: 'cloudflare',
			resourceKind: 'turnstile-widget',
			logicalName: 'form_guard_turnstile',
			locator: 'turnstile-sitekey-2',
			metadata: {
				sitekey: 'turnstile-sitekey-2',
				name: 'delete-form-guard-turnstile',
				mode: 'managed',
			},
		});
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
			const url = String(input);
			const method = String(init.method ?? 'GET').toUpperCase();
			if (url.includes('/storage/kv/namespaces/kv-form-guard-id') && method === 'DELETE') {
				return new Response(JSON.stringify({ success: true, result: { id: 'kv-form-guard-id' } }), { status: 200 });
			}
			if (url.includes('/challenges/widgets/turnstile-sitekey-2') && method === 'DELETE') {
				return new Response(JSON.stringify({ success: true, result: { sitekey: 'turnstile-sitekey-2' } }), { status: 200 });
			}
			return new Response(JSON.stringify({ success: true, result: [] }), { status: 200 });
		});
		const started = await json(await app.request(`/v1/projects/${project.id}`, {
			method: 'DELETE',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ confirmation: 'DELETE delete-form-guard-kv', sensitivePassphrase: 'pass' }),
		}));
		expect(started.ok).toBe(false);
		expect(started.code).toBe('sensitive_passphrase_rejected');
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('skips Cloudflare cleanup when launch failed before recording Cloudflare resources', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const token = await authorizeApp(app);
		const { team, project } = await createTeamAndProject(app, token, {
			slug: 'delete-failed-launch',
			name: 'Delete Failed Launch',
			metadata: {
				launchPhase: 'failed',
				launchFailure: {
					code: 'api_bootstrap_failed',
					message: 'Cloudflare API request failed after 1 attempts: POST /zones/zone-1/dns_records: Authentication error',
				},
				cloudflareHost: {
					mode: 'team_owned',
					hostId: 'web-host-failed-launch',
					domains: {
						manageDns: true,
						zoneName: 'example.test',
						productionDomain: 'delete-failed-launch.example.test',
						stagingDomain: 'delete-failed-launch-staging.example.test',
					},
				},
			},
		});
		await store.upsertRepositoryHost(team.id, {
			id: 'repo-host-failed-launch',
			name: 'Failed Launch GitHub',
			organizationOrOwner: 'treeseed-sites',
			ownership: 'team_owned',
			encryptedPayload: encryptedTestHostEnvelope({ TREESEED_GITHUB_TOKEN: 'github-token', organizationOrOwner: 'treeseed-sites' }, 'pass'),
		});
		await store.createTeamWebHost(team.id, {
			id: 'web-host-failed-launch',
			name: 'Failed Launch Cloudflare',
			provider: 'cloudflare',
			ownership: 'team_owned',
			encryptedPayload: encryptedTestHostEnvelope({ TREESEED_CLOUDFLARE_API_TOKEN: 'bad-cloudflare-token', TREESEED_CLOUDFLARE_ACCOUNT_ID: 'account-1' }, 'pass'),
			metadata: { dns: { managed: true, zoneName: 'example.test' } },
		});
		await store.upsertHubRepository(project.id, {
			teamId: team.id,
			role: 'software',
			repositoryHostId: 'repo-host-failed-launch',
			provider: 'github',
			owner: 'treeseed-sites',
			name: 'delete-failed-launch-site',
			defaultBranch: 'main',
			status: 'queued',
			metadata: { create: true },
		});
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
			const url = String(input);
			const method = String(init.method ?? 'GET').toUpperCase();
			if (url.startsWith('https://api.github.com/') && method === 'DELETE') {
				return new Response(null, { status: 204 });
			}
			if (url.startsWith('https://api.cloudflare.com/')) {
				return new Response(JSON.stringify({
					success: false,
					errors: [{ code: 10000, message: 'Authentication error' }],
				}), { status: 403 });
			}
			return new Response(JSON.stringify({ success: true, result: {} }), { status: 200 });
		});
		const started = await json(await app.request(`/v1/projects/${project.id}`, {
			method: 'DELETE',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ confirmation: 'DELETE delete-failed-launch', sensitivePassphrase: 'pass' }),
		}));
		expect(started.ok).toBe(false);
		expect(started.code).toBe('sensitive_passphrase_rejected');
		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});

	it('stores team Cloudflare web hosts as opaque encrypted payloads', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);
		const created = await app.request(`/v1/teams/${team.id}/web-hosts`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				name: 'Team Cloudflare',
				provider: 'cloudflare',
				ownership: 'team_owned',
				accountLabel: 'Example Account',
				allowedEnvironments: ['staging', 'prod'],
				encryptedPayload: encryptedHostEnvelope(),
				metadata: {
					hostType: 'web',
					accountHint: 'example',
				},
			}),
		});
		expect(created.status).toBe(201);
		const payload = await json(created);
		expect(payload.payload.encryptedPayload.ciphertext).toBe('Y2lwaGVydGV4dA==');
		expect(JSON.stringify(payload)).not.toContain('cf-secret-token');

		const listed = await json(await app.request(`/v1/teams/${team.id}/web-hosts`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(listed.payload).toHaveLength(1);
		expect(listed.payload[0].ownership).toBe('team_owned');
		expect(listed.payload[0].allowedEnvironments).toEqual(['staging', 'prod']);

		const updated = await json(await app.request(`/v1/teams/${team.id}/web-hosts/${payload.payload.id}`, {
			method: 'PUT',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				name: 'Team Cloudflare Updated',
				metadata: { accountHint: 'updated' },
			}),
		}));
		expect(updated.payload.name).toBe('Team Cloudflare Updated');
		expect(updated.payload.accountLabel).toBe('Example Account');
		expect(updated.payload.metadata.hostType).toBe('web');
		expect(updated.payload.metadata.accountHint).toBe('updated');
		expect(updated.payload.encryptedPayload.ciphertext).toBe('Y2lwaGVydGV4dA==');

		const direct = await json(await app.request(`/v1/teams/${team.id}/web-hosts/${payload.payload.id}`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(direct.payload.name).toBe('Team Cloudflare Updated');

		const genericUpdated = await json(await app.request(`/v1/teams/${team.id}/hosts/${payload.payload.id}`, {
			method: 'PUT',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				name: 'Team Cloudflare Generic Rename',
				metadata: { hostType: 'web', accountHint: 'updated' },
			}),
		}));
		expect(genericUpdated.payload.name).toBe('Team Cloudflare Generic Rename');
		expect(genericUpdated.payload.accountLabel).toBe('Example Account');
		expect(genericUpdated.payload.encryptedPayload.ciphertext).toBe('Y2lwaGVydGV4dA==');
		const genericDirect = await json(await app.request(`/v1/teams/${team.id}/hosts/${payload.payload.id}`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(genericDirect.payload.name).toBe('Team Cloudflare Generic Rename');
		expect(genericDirect.payload.encryptedPayload.ciphertext).toBe('Y2lwaGVydGV4dA==');

		const deleted = await json(await app.request(`/v1/teams/${team.id}/web-hosts/${payload.payload.id}`, {
			method: 'DELETE',
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(deleted.ok).toBe(true);
	});

	it('preserves generic email host encrypted payloads during metadata-only updates', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);
		const created = await json(await app.request(`/v1/teams/${team.id}/hosts`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				name: 'Team SMTP',
				provider: 'smtp',
				ownership: 'team_owned',
				accountLabel: 'Example Mail',
				encryptedPayload: encryptedHostEnvelope(),
				metadata: { hostType: 'email' },
			}),
		}));
		expect(created.payload.encryptedPayload.ciphertext).toBe('Y2lwaGVydGV4dA==');

		const updated = await json(await app.request(`/v1/teams/${team.id}/hosts/${created.payload.id}`, {
			method: 'PUT',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				name: 'Team SMTP Renamed',
				metadata: { hostType: 'email', purpose: 'transactional' },
			}),
		}));
		expect(updated.payload.name).toBe('Team SMTP Renamed');
		expect(updated.payload.accountLabel).toBe('Example Mail');
		expect(updated.payload.metadata).toMatchObject({ hostType: 'email', purpose: 'transactional' });
		expect(updated.payload.encryptedPayload.ciphertext).toBe('Y2lwaGVydGV4dA==');
	});

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

	it('audits team hosting readiness without exposing secrets', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);
		const audited = await json(await app.request(`/v1/teams/${team.id}/hosting-audit`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				environment: 'local',
				hostKinds: ['repository'],
			}),
		}));
		expect(audited.ok).toBe(true);
		expect(audited.payload.ok).toBe(true);
		expect(runTreeseedHostingAuditMock).toHaveBeenCalledWith(expect.objectContaining({
			environment: 'local',
			hostKinds: ['repository'],
			repair: false,
		}));
		expect(JSON.stringify(audited)).not.toContain('secret-token');
	});

	it('stores team Railway agent hosts as opaque encrypted payloads', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);
		const created = await app.request(`/v1/teams/${team.id}/web-hosts`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				name: 'Team Agents',
				provider: 'railway',
				ownership: 'team_owned',
				accountLabel: 'Agent Workspace',
				allowedEnvironments: ['staging', 'prod'],
				encryptedPayload: encryptedHostEnvelope(),
				metadata: {
					hostType: 'agent',
					configuredKeys: ['TREESEED_RAILWAY_API_TOKEN', 'TREESEED_RAILWAY_WORKSPACE', 'TREESEED_WORKER_POOL_SCALER'],
				},
			}),
		});
		expect(created.status).toBe(201);
		const payload = await json(created);
		expect(payload.payload.provider).toBe('railway');
		expect(payload.payload.metadata.hostType).toBe('agent');
		expect(payload.payload.encryptedPayload.ciphertext).toBe('Y2lwaGVydGV4dA==');
		expect(JSON.stringify(payload)).not.toContain('railway-secret-token');

		const validated = await json(await app.request(`/v1/teams/${team.id}/web-hosts/${payload.payload.id}/validate`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				decryptedConfig: {
					TREESEED_RAILWAY_API_TOKEN: 'railway-secret-token',
					TREESEED_RAILWAY_WORKSPACE: 'knowledge-coop',
					TREESEED_WORKER_POOL_SCALER: 'railway',
				},
			}),
		}));
		expect(validated.payload.validation.receivedKeys).toEqual([
			'TREESEED_RAILWAY_API_TOKEN',
			'TREESEED_RAILWAY_WORKSPACE',
			'TREESEED_WORKER_POOL_SCALER',
		]);
		expect(JSON.stringify(validated)).not.toContain('railway-secret-token');
	});

		it('lists generic hosts with TreeSeed managed web and capacity provider host records', async () => {
			const app = createTestApp();
			const token = await authorizeApp(app);
			const team = await createTeam(app, token);
			const created = await app.request(`/v1/teams/${team.id}/hosts`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
				body: JSON.stringify({
					name: 'Team Capacity Provider Host',
					provider: 'railway',
					ownership: 'team_owned',
					accountLabel: 'Capacity Provider Workspace',
					allowedEnvironments: ['staging', 'prod'],
					encryptedPayload: encryptedHostEnvelope(),
					metadata: {
						hostType: 'capacity_provider',
						configuredKeys: ['TREESEED_RAILWAY_API_TOKEN', 'TREESEED_RAILWAY_WORKSPACE', 'TREESEED_WORKER_POOL_SCALER'],
					},
				}),
		});
		expect(created.status).toBe(201);

		const listed = await json(await app.request(`/v1/teams/${team.id}/hosts`, {
			headers: { authorization: `Bearer ${token}` },
		}));
			expect(listed.payload.map((host: any) => host.id)).toEqual(expect.arrayContaining([
				'treeseed-managed-web',
			]));
			expect(listed.payload.find((host: any) => host.name === 'Team Capacity Provider Host')).toMatchObject({
				provider: 'railway',
				ownership: 'team_owned',
				metadata: expect.objectContaining({ hostType: 'capacity_provider' }),
			});
			expect(JSON.stringify(listed)).not.toContain('railway-secret-token');
		});

	it('marks TreeSeed managed hosts active from existing platform provider env vars', async () => {
		await withEnv({
			TREESEED_CLOUDFLARE_API_TOKEN: 'platform-cloudflare-token',
			TREESEED_CLOUDFLARE_ACCOUNT_ID: 'platform-cloudflare-account',
			}, async () => {
			const app = createTestApp();
			const token = await authorizeApp(app);
			const team = await createTeam(app, token);

			const listed = await json(await app.request(`/v1/teams/${team.id}/hosts`, {
				headers: { authorization: `Bearer ${token}` },
				}));
				const web = listed.payload.find((host: any) => host.id === 'treeseed-managed-web');
				expect(web.status).toBe('active');
				expect(web.metadata.missingConfigKeys).toEqual([]);
				expect(JSON.stringify(listed)).not.toContain('platform-cloudflare-token');
			});
		});

	it('does not read local machine config for remote managed host status', async () => {
		await withEnv({
			TREESEED_LOCAL_DEV_MODE: undefined,
			TREESEED_ENVIRONMENT: 'staging',
			TREESEED_CLOUDFLARE_API_TOKEN: undefined,
			TREESEED_CLOUDFLARE_ACCOUNT_ID: undefined,
			}, async () => {
			const hosts = await listTreeseedManagedHostsFromConfig('team_remote', {
				env: {
					TREESEED_ENVIRONMENT: 'staging',
				},
				});
				expect(hosts.find((host: any) => host.id === 'treeseed-managed-web')?.status).toBe('configuration_required');
				expect(hosts.find((host: any) => host.id === 'treeseed-managed-capacity-provider')).toBeUndefined();
			});
		});

	it('validates team-owned Cloudflare hosts only with caller-provided decrypted config and does not persist values', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);
		const created = await json(await app.request(`/v1/teams/${team.id}/web-hosts`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				name: 'Team Cloudflare',
				ownership: 'team_owned',
				encryptedPayload: encryptedHostEnvelope(),
			}),
		}));

		const validated = await json(await app.request(`/v1/teams/${team.id}/web-hosts/${created.payload.id}/validate`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				decryptedConfig: {
					TREESEED_CLOUDFLARE_API_TOKEN: 'cf-secret-token',
					TREESEED_CLOUDFLARE_ACCOUNT_ID: 'account-1',
				},
			}),
		}));
		expect(validated.payload.validation.receivedKeys).toEqual(['TREESEED_CLOUDFLARE_ACCOUNT_ID', 'TREESEED_CLOUDFLARE_API_TOKEN']);
		expect(JSON.stringify(validated)).not.toContain('cf-secret-token');

		const listed = await json(await app.request(`/v1/teams/${team.id}/web-hosts`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(JSON.stringify(listed)).not.toContain('cf-secret-token');
	});

	it('records failed Cloudflare DNS write validation for team-owned web hosts', async () => {
		mockCloudflareDnsPreflight({ createOk: false });
		const app = createTestApp();
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);
		const created = await json(await app.request(`/v1/teams/${team.id}/web-hosts`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				name: 'Team Cloudflare DNS Limited',
				ownership: 'team_owned',
				metadata: {
					hostType: 'web',
					dns: { managed: true, zoneName: 'example.test', zoneId: 'zone-1' },
				},
				encryptedPayload: encryptedHostEnvelope(),
			}),
		}));

		const validated = await json(await app.request(`/v1/teams/${team.id}/web-hosts/${created.payload.id}/validate`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				decryptedConfig: {
					TREESEED_CLOUDFLARE_API_TOKEN: 'cf-secret-token',
					TREESEED_CLOUDFLARE_ACCOUNT_ID: 'account-1',
				},
			}),
		}));
		expect(validated.payload.validation.status).toBe('failed');
		expect(validated.payload.validation.message).toContain('Cloudflare DNS write preflight failed');
		expect(validated.payload.validation.message).toContain('DNS Write and Zone Read access');
		expect(JSON.stringify(validated)).not.toContain('cf-secret-token');
	});

	it('prevents deleting Cloudflare hosts that are still assigned to projects', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);
		const host = await json(await app.request(`/v1/teams/${team.id}/web-hosts`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				name: 'Team Cloudflare',
				ownership: 'team_owned',
				encryptedPayload: encryptedHostEnvelope(),
			}),
		}));
		await json(await app.request(`/v1/teams/${team.id}/projects`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				slug: 'hosted-project',
				name: 'Hosted Project',
				metadata: {
					cloudflareHost: {
						mode: 'team_owned',
						hostId: host.payload.id,
					},
				},
			}),
		}));

		const deleted = await app.request(`/v1/teams/${team.id}/web-hosts/${host.payload.id}`, {
			method: 'DELETE',
			headers: { authorization: `Bearer ${token}` },
		});
		expect(deleted.status).toBe(409);
		const payload = await json(deleted);
		expect(payload.error).toBe('in_use');
		expect(payload.projects).toEqual([
			expect.objectContaining({ slug: 'hosted-project', name: 'Hosted Project' }),
		]);
	});

	it('launch rejects team Cloudflare host passphrases before project creation', async () => {
		const fetchMock = mockCloudflareDnsPreflight();
		const app = createTestApp({ mockExternal: true });
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);
		const passphrase = 'correct horse battery staple';
		const host = await json(await app.request(`/v1/teams/${team.id}/web-hosts`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				name: 'Team Cloudflare',
				ownership: 'team_owned',
				metadata: {
					hostType: 'web',
					dns: { managed: true, zoneName: 'example.test', zoneId: 'zone-1' },
				},
				encryptedPayload: encryptedTestHostEnvelope({
					TREESEED_CLOUDFLARE_API_TOKEN: 'cf-secret-token',
					TREESEED_CLOUDFLARE_ACCOUNT_ID: 'account-1',
				}, passphrase),
			}),
		}));
		const launched = await app.request(`/v1/teams/${team.id}/projects/launch`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				slug: 'hosted-with-team-cloudflare',
				name: 'Hosted With Team Cloudflare',
				sourceKind: 'blank',
				hostingMode: 'managed',
				cloudflareHostMode: 'team_owned',
				cloudflareHostId: host.payload.id,
				sensitivePassphrase: passphrase,
				targetEnvironments: ['staging', 'prod'],
				domains: {
					productionDomain: 'example.test',
					stagingDomain: 'staging.example.test',
					zoneName: 'example.test',
					zoneId: 'zone-1',
					manageDns: true,
				},
			}),
		});
		expect(launched.status).toBe(400);
		const launchPayload = await json(launched);
		expect(JSON.stringify(launchPayload)).not.toContain('cf-secret-token');
		expect(JSON.stringify(launchPayload)).not.toContain(passphrase);
		expect(launchPayload.ok).toBe(false);
		expect(launchPayload.code).toBe('sensitive_passphrase_rejected');
		const projects = await json(await app.request(`/v1/projects?teamId=${team.id}`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(projects.payload.find((project: { slug: string }) => project.slug === 'hosted-with-team-cloudflare')).toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects team-owned Cloudflare launch before DNS preflight when unlock material is supplied', async () => {
		const fetchMock = mockCloudflareDnsPreflight({ createOk: false });
		const app = createTestApp({ mockExternal: true });
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);
		const passphrase = 'correct horse battery staple';
		const host = await json(await app.request(`/v1/teams/${team.id}/web-hosts`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				name: 'Team Cloudflare DNS Limited',
				ownership: 'team_owned',
				metadata: {
					hostType: 'web',
					dns: { managed: true, zoneName: 'example.test', zoneId: 'zone-1' },
				},
				encryptedPayload: encryptedTestHostEnvelope({
					TREESEED_CLOUDFLARE_API_TOKEN: 'cf-secret-token',
					TREESEED_CLOUDFLARE_ACCOUNT_ID: 'account-1',
				}, passphrase),
			}),
		}));

		const launched = await app.request(`/v1/teams/${team.id}/projects/launch`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				slug: 'dns-limited-cloudflare',
				name: 'DNS Limited Cloudflare',
				sourceKind: 'blank',
				hostingMode: 'managed',
				cloudflareHostMode: 'team_owned',
				cloudflareHostId: host.payload.id,
				sensitivePassphrase: passphrase,
				targetEnvironments: ['staging', 'prod'],
				domains: {
					productionDomain: 'example.test',
					stagingDomain: 'staging.example.test',
					zoneName: 'example.test',
					zoneId: 'zone-1',
					manageDns: true,
				},
			}),
		});
		expect(launched.status).toBe(400);
		const payload = await json(launched);
		expect(payload.ok).toBe(false);
		expect(payload.code).toBe('sensitive_passphrase_rejected');
		const projects = await json(await app.request(`/v1/projects?teamId=${team.id}`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(projects.payload.find((project: { slug: string }) => project.slug === 'dns-limited-cloudflare')).toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects repository host passphrases before bootstrap decrypt attempts', async () => {
		await withEnv({
			TREESEED_CLOUDFLARE_API_TOKEN: 'managed-token',
			TREESEED_CLOUDFLARE_ACCOUNT_ID: 'managed-account',
		}, async () => {
		const app = createTestApp({ mockExternal: true });
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

	it('launch rejects legacy repository topology names', async () => {
		const app = createTestApp({ mockExternal: true });
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);

		const launched = await app.request(`/v1/teams/${team.id}/projects/launch`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				slug: 'legacy-topology-launch',
				name: 'Legacy Topology Launch',
				sourceKind: 'blank',
				intent: {
					repository: {
						topology: 'split_software_content',
					},
				},
			}),
		});

		expect(launched.status).toBe(400);
		const payload = await json(launched);
		expect(payload.code).toBe('legacy_project_topology_rejected');
		const projects = await json(await app.request(`/v1/projects?teamId=${team.id}`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(projects.payload.find((project: { slug: string }) => project.slug === 'legacy-topology-launch')).toBeUndefined();
	});

	it('persists a durable launch record when launch hosting readiness fails', async () => {
		await withEnv({
			TREESEED_CLOUDFLARE_API_TOKEN: 'managed-token',
			TREESEED_CLOUDFLARE_ACCOUNT_ID: 'managed-account',
		}, async () => {
			runTreeseedHostingAuditMock.mockResolvedValueOnce({
				ok: false,
				environment: 'staging',
				requestedEnvironment: 'current',
				repairMode: false,
				repaired: false,
				target: { kind: 'persistent', scope: 'staging', label: 'staging' },
				hostKinds: ['repository', 'web', 'email'],
				checkedAt: '2026-01-01T00:00:00.000Z',
				checks: [],
				missingConfig: ['TREESEED_CLOUDFLARE_ACCOUNT_ID'] as any,
				resources: {},
				warnings: [],
				blockers: [{ code: 'missing_config', message: 'Cloudflare account is missing.' }] as any,
				nextActions: ['Fix hosting configuration.'],
			});
			const app = createTestApp();
			const token = await authorizeApp(app);
			const team = await createTeam(app, token);

			const launched = await app.request(`/v1/teams/${team.id}/projects/launch`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					slug: 'audit-fails-before-persist',
					launchRequestId: '4a4ed9df-79a6-4297-abaa-01c09f3468e1',
					name: 'Audit Fails Before Persist',
					sourceKind: 'template',
					sourceRef: 'research',
					hostingMode: 'managed',
					cloudflareHostMode: 'treeseed_managed',
					emailHostMode: 'treeseed_managed',
					repositoryHostId: 'platform:github:hosted-hubs',
				}),
			});

			expect(launched.status).toBe(202);
			const launchPayload = await json(launched);
			expect(launchPayload.operationId).toBe('4a4ed9df-79a6-4297-abaa-01c09f3468e1');
			expect(launchPayload.deploymentHref).toBe(`/app/projects/deployment/${launchPayload.deploymentId}`);
			expect(launchPayload.payload.launchJob.status).toBe('running');
			const projects = await json(await app.request(`/v1/projects?teamId=${team.id}`, {
				headers: { authorization: `Bearer ${token}` },
			}));
			expect(projects.payload.some((project: { slug: string }) => project.slug === 'audit-fails-before-persist')).toBe(true);
			expect(await waitForCondition(async () => {
				const job = await json(await app.request('/v1/jobs/4a4ed9df-79a6-4297-abaa-01c09f3468e1', {
					headers: { authorization: `Bearer ${token}` },
				}));
				return job.payload.status === 'failed';
			}, 8000)).toBe(true);
			const job = await json(await app.request('/v1/jobs/4a4ed9df-79a6-4297-abaa-01c09f3468e1', {
				headers: { authorization: `Bearer ${token}` },
			}));
			expect(job.payload.status).toBe('failed');
			expect(job.payload.error.code).toBe('hosting_readiness_audit_failed');
			const deploymentDetail = await json(await app.request(`/v1/project-deployments/${launchPayload.deploymentId}`, {
				headers: { authorization: `Bearer ${token}` },
			}));
			expect(deploymentDetail.payload.events).toEqual(expect.arrayContaining([
				expect.objectContaining({
					kind: 'launch.audit_failed',
					payload: expect.objectContaining({
						audit: expect.objectContaining({
							blockers: expect.arrayContaining([expect.objectContaining({ code: 'missing_config' })]),
							missingConfig: expect.arrayContaining(['TREESEED_CLOUDFLARE_ACCOUNT_ID']),
						}),
					}),
				}),
			]));
			const details = await json(await app.request(`/v1/projects/${launchPayload.projectId}`, {
				headers: { authorization: `Bearer ${token}` },
			}));
			expect(details.payload.deployments).toEqual(expect.arrayContaining([
				expect.objectContaining({ environment: 'staging', action: 'launch_project', status: 'failed', platformOperationId: launchPayload.operationId }),
				expect.objectContaining({ environment: 'prod', action: 'launch_project', status: 'failed', platformOperationId: launchPayload.operationId }),
			]));
		});
	});

	it('launch with TreeSeed managed Cloudflare host records paid hosting metadata', async () => {
		await withEnv({
			TREESEED_CLOUDFLARE_API_TOKEN: 'managed-token',
			TREESEED_CLOUDFLARE_ACCOUNT_ID: 'managed-account',
		}, async () => {
			const app = createTestApp({ mockExternal: true });
			const token = await authorizeApp(app);
			const team = await createTeam(app, token);

			const launched = await app.request(`/v1/teams/${team.id}/projects/launch`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					slug: 'hosted-with-treeseed-cloudflare',
					name: 'Hosted With TreeSeed Cloudflare',
					sourceKind: 'blank',
					hostingMode: 'managed',
					cloudflareHostMode: 'treeseed_managed',
				}),
			});
			expect(launched.status).toBe(202);
			const launchPayload = await json(launched);
			expect(launchPayload.payload.launchJob.status).toBe('running');
			const projects = await json(await app.request(`/v1/projects?teamId=${team.id}`, {
				headers: { authorization: `Bearer ${token}` },
			}));
			const projectId = projects.payload.find((project: { slug: string }) => project.slug === 'hosted-with-treeseed-cloudflare')?.id;
			expect(projectId).toBeTruthy();
			const details = await json(await app.request(`/v1/projects/${projectId}`, {
				headers: { authorization: `Bearer ${token}` },
			}));
			expect(details.payload.project.metadata.cloudflareHost.mode).toBe('treeseed_managed');
			expect(details.payload.project.metadata.cloudflareHost.billing.fee).toBe('treeseed_cloudflare_hosting');
			expect(details.payload.entitlement.tier).toBe('paid_hosting');
		});
	});

		it('rejects removed runtime host fields during project launch', async () => {
			await withEnv({
				TREESEED_CLOUDFLARE_API_TOKEN: 'managed-token',
				TREESEED_CLOUDFLARE_ACCOUNT_ID: 'managed-account',
			}, async () => {
				executeKnowledgeHubProviderLaunchMock.mockRejectedValue(new Error('launch intentionally stopped'));
				const app = createTestApp();
			const token = await authorizeApp(app);
			const team = await createTeam(app, token);

			const launched = await app.request(`/v1/teams/${team.id}/projects/launch`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					slug: 'hosted-with-capacity-provider',
					name: 'Hosted With Capacity Provider',
						sourceKind: 'blank',
						hostingMode: 'managed',
						cloudflareHostMode: 'treeseed_managed',
						processingHostMode: 'treeseed_managed',
						processingHostId: 'treeseed-managed-runtime',
					}),
				});
				expect(launched.status).toBe(400);
				const launchPayload = await json(launched);
				expect(launchPayload.error).toMatch(/no longer accepts runtime host configuration/u);
				expect(executeKnowledgeHubProviderLaunchMock).not.toHaveBeenCalled();
		});
	});

	it('rejects malformed dynamic host bindings before project launch creates a project', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);

		const launched = await app.request(`/v1/teams/${team.id}/projects/launch`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				slug: 'bad-host-bindings',
				name: 'Bad Host Bindings',
				sourceKind: 'template',
				sourceRef: 'research',
				hostingMode: 'managed',
				hostBindings: {
					publicWeb: {
						requirementKind: 'capacity-provider',
						type: 'web',
						provider: 'cloudflare',
					},
				},
			}),
		});
		expect(launched.status).toBe(400);
		const payload = await json(launched);
		expect(payload.code).toBe('invalid_host_bindings');
		expect(payload.error).toContain('unsupported value "capacity-provider"');
		const projects = await json(await app.request(`/v1/projects?teamId=${team.id}`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(projects.payload.some((project: { slug: string }) => project.slug === 'bad-host-bindings')).toBe(false);
	});

	it('rejects the deprecated legacy basic template before project creation', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);

		const launched = await app.request(`/v1/teams/${team.id}/projects/launch`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				slug: 'deprecated-basic-template',
				name: 'Deprecated Basic Template',
				sourceKind: 'template',
				sourceRef: 'basic',
				hostingMode: 'managed',
			}),
		});
		expect(launched.status).toBe(400);
		const payload = await json(launched);
		expect(payload.code).toBe('unknown_template');
		expect(payload.error).toContain('Unknown template "basic"');
		const projects = await json(await app.request(`/v1/projects?teamId=${team.id}`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(projects.payload.some((project: { slug: string }) => project.slug === 'deprecated-basic-template')).toBe(false);
	});

	it('requires an explicit template selection for template project launch', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);

		const launched = await app.request(`/v1/teams/${team.id}/projects/launch`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				slug: 'missing-template-selection',
				name: 'Missing Template Selection',
				sourceKind: 'template',
				hostingMode: 'managed',
			}),
		});
		expect(launched.status).toBe(400);
		const payload = await json(launched);
		expect(payload.code).toBe('missing_template');
		expect(payload.error).toContain('requires a selected template');
		const projects = await json(await app.request(`/v1/projects?teamId=${team.id}`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(projects.payload.some((project: { slug: string }) => project.slug === 'missing-template-selection')).toBe(false);
	});

	it('launches with dynamic host bindings and records the binding snapshot', async () => {
		await withEnv({
			TREESEED_CLOUDFLARE_API_TOKEN: 'managed-token',
			TREESEED_CLOUDFLARE_ACCOUNT_ID: 'managed-account',
		}, async () => {
			const app = createTestApp({ mockExternal: true });
			const token = await authorizeApp(app);
			const team = await createTeam(app, token);

			const launched = await app.request(`/v1/teams/${team.id}/projects/launch`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					slug: 'dynamic-host-bindings',
					name: 'Dynamic Host Bindings',
					sourceKind: 'template',
					sourceRef: 'research',
					hostingMode: 'managed',
					hostBindings: {
						sourceRepository: {
							requirementKind: 'host',
							type: 'repository',
							provider: 'github',
							hostId: 'platform:github:hosted-hubs',
							mode: 'treeseed_managed',
						},
						publicWeb: {
							requirementKind: 'host',
							type: 'web',
							provider: 'cloudflare',
							managedHostKey: 'treeseed-managed-cloudflare',
							mode: 'treeseed_managed',
						},
						transactionalEmail: {
							requirementKind: 'host',
							type: 'email',
							provider: 'smtp',
							managedHostKey: 'treeseed-managed-email',
							mode: 'treeseed_managed',
						},
					},
				}),
			});
			expect(launched.status).toBe(202);
			const payload = await json(launched);
			expect(payload.payload.project.project.metadata.templateLineage).toEqual([
				expect.objectContaining({ kind: 'template', ref: 'research' }),
			]);
			expect(payload.payload.project.project.metadata.hostBindings).toMatchObject({
				sourceRepository: expect.objectContaining({ provider: 'github', provenance: expect.objectContaining({ selectedBy: 'managed-default' }) }),
				publicWeb: expect.objectContaining({ provider: 'cloudflare', managedHostKey: expect.any(String) }),
				transactionalEmail: expect.objectContaining({ provider: 'smtp', managedHostKey: expect.any(String) }),
			});
			expect(payload.payload.launchJob.input.hostBindings.publicWeb.provider).toBe('cloudflare');
			expect(JSON.stringify(payload)).not.toContain('managed-token');
		});
	});

	it('inspects, audits, and queues governed project host operations', async () => {
		await withEnv({
			TREESEED_CLOUDFLARE_API_TOKEN: 'managed-token',
			TREESEED_CLOUDFLARE_ACCOUNT_ID: 'managed-account',
		}, async () => {
			const db = createTestPostgresDatabase();
			const store = createTestStore(db);
			const app = createTestApp({
				db,
				store,
				mockExternal: true,
				config: {
					platformRunnerSecret: 'platform-runner-secret',
				},
			});
			const token = await authorizeApp(app);
			const team = await createTeam(app, token);

			const launched = await app.request(`/v1/teams/${team.id}/projects/launch`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					slug: 'host-ops-project',
					name: 'Host Ops Project',
					sourceKind: 'template',
					sourceRef: 'research',
					hostingMode: 'managed',
					hostBindings: {
						sourceRepository: {
							requirementKind: 'host',
							type: 'repository',
							provider: 'github',
							hostId: 'platform:github:hosted-hubs',
							mode: 'treeseed_managed',
						},
						publicWeb: {
							requirementKind: 'host',
							type: 'web',
							provider: 'cloudflare',
							managedHostKey: 'treeseed-managed-cloudflare',
							mode: 'treeseed_managed',
						},
					},
				}),
			});
			expect(launched.status).toBe(202);
			const launchedPayload = await json(launched);
			const projectId = launchedPayload.projectId;

			const inspected = await json(await app.request(`/v1/projects/${projectId}/hosts`, {
				headers: { authorization: `Bearer ${token}` },
			}));
			expect(inspected.payload.view.requirements.map((entry: { requirementKey: string }) => entry.requirementKey)).toEqual([
				'sourceRepository',
				'publicWeb',
				'transactionalEmail',
			]);
			expect(inspected.payload.view.requirements.find((entry: { requirementKey: string }) => entry.requirementKey === 'publicWeb')).toMatchObject({
				audit: expect.objectContaining({
					marketHostId: expect.any(String),
					repositoryConfig: 'planned',
				}),
			});
			const fixture = createRunnerRepoFixture();
			await store.upsertHubRepository(projectId, {
				role: 'software',
				provider: 'local',
				owner: 'fixture',
				name: 'host-ops-project',
				url: fixture.repo,
				defaultBranch: 'staging',
				status: 'active',
			});

			const invalid = await app.request(`/v1/projects/${projectId}/hosts/publicWeb/replace`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					hostBinding: {
						requirementKind: 'host',
						type: 'email',
						provider: 'smtp',
						hostId: 'smtp-host-1',
					},
				}),
			});
			expect(invalid.status).toBe(400);
			expect((await json(invalid)).code).toBe('invalid_host_binding_operation');

			const audited = await app.request(`/v1/projects/${projectId}/hosts/audit`, {
				method: 'POST',
				headers: { authorization: `Bearer ${token}` },
			});
			expect(audited.status).toBe(202);
			const auditPayload = await json(audited);
			expect(auditPayload.operation).toMatchObject({
				namespace: 'project_hosts',
				operation: 'host_binding_audit',
				status: 'queued',
			});
			expect(auditPayload.payload.view.summary.status).toBe('ok');
			try {
				await withHttpMarketApp(app, async (baseUrl) => {
					const client = new PlatformRunnerClient({
						marketUrl: baseUrl,
						marketId: 'local',
						runnerSecret: 'platform-runner-secret',
					});
					const result = await runOnceWithClient({
						runnerId: 'treeseed-ops-host-runner-01',
						environment: 'staging',
						dataDir: fixture.workspace,
					}, client, 'test', {
						deploymentStore: store,
						operationKey: 'project_hosts:host_binding_audit',
					});
					expect(result).toMatchObject({
						ok: true,
						claimed: true,
						operation: expect.objectContaining({
							id: auditPayload.operation.id,
							status: 'succeeded',
						}),
					});
				});
				const completedAudit = await store.findPlatformOperationById(auditPayload.operation.id);
				expect(completedAudit?.status).toBe('succeeded');
				expect(completedAudit?.output?.hostBindingPlans?.secretDeployment?.items).toEqual(expect.any(Array));
				const afterAudit = await store.getProjectDetails(projectId);
				expect(afterAudit?.project.metadata.hostBindingPlans.secretDeployment.items).toEqual(expect.any(Array));
				expect(afterAudit?.project.metadata.hostBindingSecretSync).toBeNull();
				expect(JSON.stringify(afterAudit?.project.metadata)).not.toContain('managed-token');
			} finally {
				rmSync(fixture.root, { recursive: true, force: true });
			}

			const replaced = await app.request(`/v1/projects/${projectId}/hosts/publicWeb/replace`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					hostBinding: {
						requirementKind: 'host',
						type: 'web',
						provider: 'cloudflare',
						managedHostKey: 'treeseed-managed-cloudflare',
						mode: 'treeseed_managed',
					},
				}),
			});
			expect(replaced.status).toBe(202);
			const replacePayload = await json(replaced);
			expect(replacePayload.operation).toMatchObject({
				namespace: 'project_hosts',
				operation: 'host_binding_replace',
				status: 'queued',
			});
			expect(JSON.stringify(replacePayload)).not.toContain('managed-token');
			const details = await json(await app.request(`/v1/projects/${projectId}`, {
				headers: { authorization: `Bearer ${token}` },
			}));
			expect(details.payload.project.metadata.lastHostOperation).toMatchObject({
				kind: 'replace',
				requirementKey: 'publicWeb',
			});
			expect(details.payload.project.metadata.hostBindingAudit.summary.status).toBe('ok');
		});
	}, 20_000);

	it('rejects missing and incompatible dynamic host bindings before project creation', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);

		for (const [slug, hostBinding, message] of [
			['missing-public-web-host', {
				requirementKind: 'host',
				type: 'web',
				provider: 'cloudflare',
				mode: 'team_owned',
			}, /publicWeb is required/u],
			['incompatible-public-web-host', {
				requirementKind: 'host',
				type: 'web',
				provider: 'smtp',
				mode: 'treeseed_managed',
			}, /requires provider cloudflare/u],
		] as const) {
			const launched = await app.request(`/v1/teams/${team.id}/projects/launch`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					slug,
					name: slug,
					sourceKind: 'template',
					sourceRef: 'research',
					hostingMode: 'managed',
					hostBindings: {
						publicWeb: hostBinding,
					},
				}),
			});
			expect(launched.status).toBe(400);
			const payload = await json(launched);
			expect(payload.code).toBe('invalid_host_bindings');
			expect(payload.error).toMatch(message);
		}
		const projects = await json(await app.request(`/v1/projects?teamId=${team.id}`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(projects.payload.some((project: { slug: string }) => project.slug === 'missing-public-web-host' || project.slug === 'incompatible-public-web-host')).toBe(false);
	}, 15_000);

	it('launch with TreeSeed managed Cloudflare host fails when operational credentials are missing', async () => {
		await withEnv({
			TREESEED_CLOUDFLARE_API_TOKEN: undefined,
			TREESEED_CLOUDFLARE_ACCOUNT_ID: undefined,
		}, async () => {
			vi.spyOn(process, 'cwd').mockReturnValue('/tmp/treeseed-missing-managed-host-config');
			executeKnowledgeHubProviderLaunchMock.mockRejectedValue(new Error('launch should not run'));
			const app = createTestApp();
			const token = await authorizeApp(app);
			const team = await createTeam(app, token);

			const launched = await app.request(`/v1/teams/${team.id}/projects/launch`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					slug: 'hosted-with-missing-treeseed-cloudflare',
					name: 'Hosted With Missing TreeSeed Cloudflare',
					sourceKind: 'blank',
					hostingMode: 'managed',
					cloudflareHostMode: 'treeseed_managed',
				}),
			});
			expect(launched.status).toBe(500);
			const payload = await json(launched);
			expect(payload.error).toBe('TreeSeed managed Cloudflare hosting is not configured.');
			expect(payload.missing).toEqual(['TREESEED_CLOUDFLARE_API_TOKEN', 'TREESEED_CLOUDFLARE_ACCOUNT_ID']);
			expect(executeKnowledgeHubProviderLaunchMock).not.toHaveBeenCalled();
		});
	}, 15_000);

	it('routes remote inline dispatch through a hosted project api connection', async () => {
		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = String(input);
			expect(url).toBe('https://project.example.com/internal/core/sdk/read');
			const headers = Object.fromEntries(new Headers(init?.headers).entries());
			expect(headers.authorization).toBe('Bearer hosted-project-key');
			return new Response(JSON.stringify({
				ok: true,
				model: 'knowledge',
				operation: 'read',
				payload: {
					slug: 'remote-knowledge',
				},
			}), {
				status: 200,
				headers: {
					'content-type': 'application/json',
					'x-treeseed-remote-contract-version': '1',
				},
			});
		});
		const app = createTestApp({ fetchImpl: fetchMock as unknown as typeof fetch });
		const token = await authorizeApp(app);
		const { project } = await createTeamAndProject(app, token, {
			id: 'hosted-project',
			slug: 'hosted-project',
			name: 'Hosted Project',
		});

		await app.request(`/v1/projects/${project.id}/connection`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				mode: 'hosted',
				projectApiBaseUrl: 'https://project.example.com',
				metadata: {
					projectApiKey: 'hosted-project-key',
				},
			}),
		});

		const dispatched = await app.request(`/v1/projects/${project.id}/dispatch`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				namespace: 'sdk',
				operation: 'read',
				input: {
					model: 'knowledge',
					slug: 'research/inquiry/questions-as-records',
				},
			}),
		});

		expect(dispatched.status).toBe(200);
		expect(await json(dispatched)).toMatchObject({
			ok: true,
			mode: 'inline',
			target: 'project_api',
			payload: {
				payload: {
					slug: 'remote-knowledge',
				},
			},
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('delegates project agents artifact, approval, and Codex readiness requests with read-only fallbacks', async () => {
		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === 'https://project.example.com/v1/agent-artifacts') {
				return new Response(JSON.stringify({
					ok: true,
					payload: {
						projectId: 'hosted-project',
						items: [{
							artifactKind: 'knowledge_draft',
							id: 'knowledge:runtime',
							title: 'Runtime',
							targetPath: 'src/content/knowledge/architecture/runtime/runtime.mdx',
							totalScore: 29,
							recommendation: 'promote',
						}],
						warnings: [],
					},
				}), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			if (url === 'https://project.example.com/v1/agent-artifacts/knowledge%3Aruntime') {
				return new Response(JSON.stringify({
					ok: true,
					payload: {
						projectId: 'hosted-project',
						artifact: {
							id: 'knowledge:runtime',
							artifactKind: 'knowledge_draft',
							title: 'Runtime',
						},
					},
				}), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			if (url === 'https://project.example.com/v1/agent-artifacts/knowledge%3Aruntime/source-map') {
				return new Response(JSON.stringify({
					ok: true,
					payload: {
						projectId: 'hosted-project',
						artifactId: 'knowledge:runtime',
						sourceMap: [{ path: 'packages/agent/src/services/manager.ts', evidence: 'direct' }],
					},
				}), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			if (url === 'https://project.example.com/v1/agent-artifacts/knowledge%3Aruntime/diff') {
				return new Response(JSON.stringify({
					ok: true,
					payload: {
						projectId: 'hosted-project',
						artifactId: 'knowledge:runtime',
						changedPaths: ['src/content/knowledge/architecture/runtime/runtime.mdx'],
					},
				}), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			if (url === 'https://project.example.com/v1/approvals') {
				return new Response(JSON.stringify({
					ok: true,
					payload: {
						projectId: 'hosted-project',
						items: [{ id: 'promotion:runtime', taskId: 'task-promote' }],
						warnings: [],
					},
				}), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			if (url === 'https://project.example.com/v1/approvals/promotion%3Aruntime') {
				return new Response(JSON.stringify({
					ok: true,
					payload: {
						projectId: 'hosted-project',
						approval: { id: 'promotion:runtime', state: 'pending' },
					},
				}), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			if (url === 'https://project.example.com/v1/agents/status') {
				return new Response(JSON.stringify({
					ok: true,
					payload: {
						projectId: 'hosted-project',
						agents: [{ agentSlug: 'treeseed-docs-planner', handler: 'planner', status: 'idle' }],
					},
				}), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			if (url === 'https://project.example.com/v1/research-notes') {
				return new Response(JSON.stringify({
					ok: true,
					payload: {
						projectId: 'hosted-project',
						items: [{ taskId: 'task-research', researchNote: { id: 'research:runtime' } }],
						warnings: [],
					},
				}), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			if (url === 'https://project.example.com/v1/knowledge-drafts') {
				return new Response(JSON.stringify({
					ok: true,
					payload: {
						projectId: 'hosted-project',
						items: [{ taskId: 'task-draft', knowledgeDraft: { id: 'knowledge:runtime', title: 'Runtime' } }],
						warnings: [],
					},
				}), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			if (url === 'https://project.example.com/v1/optimization-reports') {
				return new Response(JSON.stringify({
					ok: true,
					payload: {
						projectId: 'hosted-project',
						items: [{ taskId: 'task-optimize', optimizationReport: { id: 'optimization:runtime', draftId: 'knowledge:runtime', totalScore: 29, recommendation: 'promote' } }],
						warnings: [],
					},
				}), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			if (url === 'https://project.example.com/v1/approvals/promotion%3Aruntime/decision') {
				return new Response(JSON.stringify({
					ok: true,
					payload: {
						id: 'promotion:runtime',
						decision: JSON.parse(String(init?.body ?? '{}')).decision,
						releaseAttempted: false,
						stagingAttempted: false,
					},
				}), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			if (url === 'https://project.example.com/v1/providers/codex/readiness') {
				return new Response(JSON.stringify({
					ok: true,
					payload: {
						ok: true,
						providerSelected: true,
						sdkInstalled: true,
						nodeVersionOk: true,
						authDetected: false,
						subscriptionPlan: 'pro',
						warnings: [],
						blockingIssues: [],
					},
				}), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			if (url === 'https://project.example.com/v1/operations/grants') {
				return new Response(JSON.stringify({
					ok: true,
					payload: {
						projectId: 'hosted-project',
						items: [{
							id: 'grant-stage-docs',
							operations: ['stage'],
							modes: ['dry_run'],
							allowedPaths: ['src/content/knowledge/**'],
						}],
						warnings: [],
					},
				}), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			if (url === 'https://project.example.com/v1/operations/events') {
				return new Response(JSON.stringify({
					ok: true,
					payload: {
						projectId: 'hosted-project',
						items: [{
							id: 'event-stage-1',
							operation: 'stage',
							status: 'completed',
							changedPaths: ['src/content/knowledge/architecture/runtime/runtime.mdx'],
							stagedPaths: ['src/content/knowledge/architecture/runtime/runtime.mdx'],
						}],
						lifecycle: {
							worktreeSnapshots: [{ kind: 'verified_snapshot', taskId: 'task-promote' }],
							stagingMerges: [{ mergedToStaging: true, commitSha: 'abc123' }],
							mergeFailures: [],
							repairTasks: [],
							releaseApprovals: [],
							releaseResults: [],
							codexUsage: [],
						},
						warnings: [],
					},
				}), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			if (url === 'https://project.example.com/v1/operations/stage/dry-run') {
				return new Response(JSON.stringify({
					ok: true,
					payload: {
						projectId: 'hosted-project',
						dryRun: true,
						decision: { allowed: true },
						result: { status: 'completed' },
					},
				}), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			if (url === 'https://project.example.com/v1/workdays/current') {
				return new Response(JSON.stringify({
					ok: true,
					payload: {
						id: 'workday-1',
						state: 'active',
						updatedAt: '2026-05-13T00:00:00.000Z',
					},
				}), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			if (url === 'https://project.example.com/v1/workdays/reports') {
				return new Response(JSON.stringify({
					ok: true,
					payload: {
						projectId: 'hosted-project',
						items: [{ id: 'report-1', kind: 'workday_summary', workDayId: 'workday-1', createdAt: '2026-05-13T00:01:00.000Z' }],
						warnings: [],
					},
				}), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			return new Response(JSON.stringify({ ok: false }), { status: 404, headers: { 'content-type': 'application/json' } });
		});
		const app = createTestApp({ fetchImpl: fetchMock as unknown as typeof fetch });
		const token = await authorizeApp(app);
		const { project } = await createTeamAndProject(app, token, {
			id: 'hosted-project',
			slug: 'hosted-project',
			name: 'Hosted Project',
		});

		await app.request(`/v1/projects/${project.id}/connection`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				mode: 'hosted',
				projectApiBaseUrl: 'https://project.example.com',
				metadata: {
					projectApiKey: 'hosted-project-key',
				},
			}),
		});

		const headers = { authorization: `Bearer ${token}` };
		const artifacts = await json(await app.request(`/v1/projects/${project.id}/agent-artifacts`, { headers }));
		expect(artifacts.payload.items).toEqual([expect.objectContaining({ id: 'knowledge:runtime' })]);

		const artifactDetail = await json(await app.request(`/v1/projects/${project.id}/agent-artifacts/knowledge%3Aruntime`, { headers }));
		expect(artifactDetail.payload.artifact).toMatchObject({ id: 'knowledge:runtime' });

		const sourceMap = await json(await app.request(`/v1/projects/${project.id}/agent-artifacts/knowledge%3Aruntime/source-map`, { headers }));
		expect(sourceMap.payload.sourceMap).toEqual([expect.objectContaining({ path: 'packages/agent/src/services/manager.ts' })]);

		const artifactDiff = await json(await app.request(`/v1/projects/${project.id}/agent-artifacts/knowledge%3Aruntime/diff`, { headers }));
		expect(artifactDiff.payload.changedPaths).toEqual(['src/content/knowledge/architecture/runtime/runtime.mdx']);

		const approvals = await json(await app.request(`/v1/projects/${project.id}/approvals`, { headers }));
		expect(approvals.payload.items).toEqual([expect.objectContaining({ id: 'promotion:runtime' })]);

		const approvalDetail = await json(await app.request(`/v1/projects/${project.id}/approvals/promotion%3Aruntime`, { headers }));
		expect(approvalDetail.payload.approval).toMatchObject({ id: 'promotion:runtime' });

		const operationGrants = await json(await app.request(`/v1/projects/${project.id}/operations/grants`, { headers }));
		expect(operationGrants.payload.items).toEqual([expect.objectContaining({ id: 'grant-stage-docs' })]);

		const operationEvents = await json(await app.request(`/v1/projects/${project.id}/operations/events`, { headers }));
		expect(operationEvents.payload.items).toEqual([expect.objectContaining({ operation: 'stage' })]);
		expect(operationEvents.payload.lifecycle).toMatchObject({
			worktreeSnapshots: [expect.objectContaining({ kind: 'verified_snapshot' })],
			stagingMerges: [expect.objectContaining({ mergedToStaging: true })],
		});

		const operationDryRun = await json(await app.request(`/v1/projects/${project.id}/operations/stage/dry-run`, {
			method: 'POST',
			headers: {
				...headers,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ request: { mode: 'dry_run' } }),
		}));
		expect(operationDryRun.payload).toMatchObject({
			dryRun: true,
			result: { status: 'completed' },
		});

		const delegatedDecision = await json(await app.request(`/v1/projects/${project.id}/approvals/promotion%3Aruntime/decision`, {
			method: 'POST',
			headers: {
				...headers,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ decision: 'approve_as_book_content', reason: 'Reviewed in Agents page.' }),
		}));
		expect(delegatedDecision.payload).toMatchObject({
			id: 'promotion:runtime',
			decision: 'approve_as_book_content',
			releaseAttempted: false,
			stagingAttempted: false,
		});
		const decisionCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/v1/approvals/promotion%3Aruntime/decision'));
		expect(decisionCall?.[1]).toMatchObject({ method: 'POST' });
		expect(JSON.parse(String(decisionCall?.[1]?.body ?? '{}'))).toMatchObject({
			decision: 'approve_as_book_content',
			reason: 'Reviewed in Agents page.',
		});

		const delegatedAliasDecision = await json(await app.request(`/v1/projects/${project.id}/approvals/promotion%3Aruntime/decision`, {
			method: 'POST',
			headers: {
				...headers,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ decision: 'approve', reason: 'Reviewed from the governance table.' }),
		}));
		expect(delegatedAliasDecision.payload).toMatchObject({
			id: 'promotion:runtime',
			decision: 'approve',
		});

		const invalidDecision = await app.request(`/v1/projects/${project.id}/approvals/promotion%3Aruntime/decision`, {
			method: 'POST',
			headers: {
				...headers,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ decision: 'publish_release' }),
		});
		expect(invalidDecision.status).toBe(400);
		expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/v1/approvals/promotion%3Aruntime/decision'))).toHaveLength(2);

		const readiness = await json(await app.request(`/v1/projects/${project.id}/providers/codex/readiness`, { headers }));
		expect(readiness.payload).toMatchObject({ providerSelected: true, subscriptionPlan: 'pro' });

		const agents = await json(await app.request(`/v1/projects/${project.id}/agents`, { headers }));
		expect(agents.payload).toMatchObject({
			projectId: 'hosted-project',
			agents: [expect.objectContaining({ agentSlug: 'treeseed-docs-planner' })],
			generatedArtifacts: [expect.objectContaining({ id: 'knowledge:runtime', totalScore: 29 })],
			researchNotes: [expect.objectContaining({ taskId: 'task-research' })],
			knowledgeDrafts: [expect.objectContaining({ taskId: 'task-draft' })],
			optimizationReports: [expect.objectContaining({ taskId: 'task-optimize' })],
			approvals: [expect.objectContaining({ id: 'promotion:runtime' })],
			operationGrants: [expect.objectContaining({ id: 'grant-stage-docs' })],
			operationEvents: [expect.objectContaining({ operation: 'stage' })],
			operationLifecycle: expect.objectContaining({
				worktreeSnapshots: [expect.objectContaining({ kind: 'verified_snapshot' })],
				stagingMerges: [expect.objectContaining({ mergedToStaging: true })],
			}),
			codexReadiness: expect.objectContaining({ providerSelected: true, subscriptionPlan: 'pro' }),
			currentWorkday: expect.objectContaining({ id: 'workday-1', state: 'active' }),
			runtimeReports: [expect.objectContaining({ id: 'report-1' })],
			docsAutomation: expect.objectContaining({
				researchNoteCount: 1,
				knowledgeDraftCount: 1,
				optimizationReportCount: 1,
				generatedArtifactCount: 1,
			}),
		});

		const agentDetail = await json(await app.request(`/v1/projects/${project.id}/agents/treeseed-docs-planner`, { headers }));
		expect(agentDetail.payload.agent).toMatchObject({ agentSlug: 'treeseed-docs-planner', handler: 'planner' });

		const disconnectedProjectResponse = await json(await app.request(`/v1/teams/${project.teamId}/projects`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				id: 'disconnected-project',
				slug: 'disconnected-project',
				name: 'Disconnected Project',
			}),
		}));
		const disconnectedProject = disconnectedProjectResponse.payload.project;
		const fallback = await json(await app.request(`/v1/projects/${disconnectedProject.id}/agent-artifacts`, { headers }));
		expect(fallback.payload).toMatchObject({
			items: [],
			warnings: ['Project runtime is not connected or unavailable.'],
		});
		const fallbackOperations = await json(await app.request(`/v1/projects/${disconnectedProject.id}/operations/grants`, { headers }));
		expect(fallbackOperations.payload).toMatchObject({
			items: [],
			warnings: ['Project runtime is not connected or unavailable.'],
		});

		const fallbackDryRun = await app.request(`/v1/projects/${disconnectedProject.id}/operations/stage/dry-run`, {
			method: 'POST',
			headers: {
				...headers,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ request: { mode: 'dry_run' } }),
		});
		expect(fallbackDryRun.status).toBe(409);

		const unavailableDecision = await json(await app.request(`/v1/projects/${disconnectedProject.id}/approvals/promotion%3Aruntime/decision`, {
			method: 'POST',
			headers: {
				...headers,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ decision: 'reject' }),
		}));
		expect(unavailableDecision).toMatchObject({
			ok: false,
			payload: {
				approvalId: 'promotion:runtime',
				warnings: ['Project runtime is not connected or unavailable.'],
				releaseAttempted: false,
				stagingAttempted: false,
			},
		});

		const disconnectedAgents = await json(await app.request(`/v1/projects/${disconnectedProject.id}/agents`, { headers }));
		expect(disconnectedAgents.payload).toMatchObject({
			generatedArtifacts: [],
			approvals: [],
			operationGrants: [],
			operationEvents: [],
			operationLifecycle: expect.objectContaining({
				worktreeSnapshots: [],
				stagingMerges: [],
			}),
			currentWorkday: null,
			runtimeReports: [],
			runtimeWarnings: ['Project runtime is not connected or unavailable.'],
		});
	});

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

	it('blocks team deletion while the team owns projects', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);
		await json(await app.request(`/v1/teams/${team.id}/projects`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				slug: 'owned-project',
				name: 'Owned Project',
			}),
		}));
		const blocked = await json(await app.request(`/v1/teams/${team.id}`, {
			method: 'DELETE',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ confirmation: 'DELETE team-one' }),
		}));
		expect(blocked).toMatchObject({ ok: false, code: 'blocked' });
		expect(blocked.blockers.some((entry: { code: string }) => entry.code === 'project')).toBe(true);
	});

	it('serves deep health and runner health summaries', async () => {
		const app = createTestApp();
		const deepHealth = await json(await app.request('/healthz/deep'));
		expect(deepHealth).toMatchObject({
			ok: true,
			status: 'ok',
			checks: {
				database: true,
			},
		});

		const token = await authorizeApp(app);
		const { project } = await createTeamAndProject(app, token, {
			id: 'health-project',
			slug: 'health-project',
			name: 'Health Project',
		});
		const connection = await json(await app.request(`/v1/projects/${project.id}/connection`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				mode: 'hosted',
				projectApiBaseUrl: 'https://project.example.com',
				metadata: {
					projectApiKey: 'hosted-project-key',
				},
			}),
		}));
		const runnerToken = connection.payload.runnerToken as string;
		await app.request(`/v1/projects/${project.id}/runner/agent-pools/primary/register`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${runnerToken}`,
			},
			body: JSON.stringify({
				environment: 'staging',
				teamId: project.teamId,
				managerId: 'manager-1',
				desiredWorkers: 1,
				observedQueueDepth: 2,
			}),
		});
		const runnerHealth = await json(await app.request(`/v1/projects/${project.id}/runner/health?environment=staging`, {
			headers: {
				authorization: `Bearer ${runnerToken}`,
			},
		}));
		expect(runnerHealth.ok).toBe(true);
		expect(Array.isArray(runnerHealth.payload.pools)).toBe(true);
		expect(runnerHealth.payload.pools[0]?.latestRegistration?.managerId).toBe('manager-1');
	});

	it('uses the Drizzle-owned web session schema before serving deep health', async () => {
		const db = createTestPostgresDatabase();
		const app = createTestApp({ db });
		const deepHealth = await json(await app.request('/healthz/deep'));
		expect(deepHealth).toMatchObject({
			ok: true,
			status: 'ok',
			checks: {
				database: true,
			},
		});

		const tableInfo = await db.prepare(`
			SELECT column_name AS name
			FROM information_schema.columns
			WHERE table_name = 'web_sessions'
		`).all();
		const columns = new Set(((tableInfo.results ?? []) as Array<{ name: string }>).map((row) => row.name));
		expect([...columns]).toEqual(expect.arrayContaining([
			'better_auth_session_id',
			'ip_address',
			'user_agent',
			'last_seen_at',
			'revoked_at',
		]));
	});

	it('queues project runner jobs and records lifecycle events', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const { team, project } = await createTeamAndProject(app, token, {
			id: 'runner-project',
			slug: 'runner-project',
			name: 'Runner Project',
		});

		const keyResponse = await json(await app.request(`/v1/teams/${team.id}/api-keys`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				name: 'Dispatch Key',
				permissions: ['dispatch:execute:team'],
			}),
		}));
		const connectionResponse = await json(await app.request(`/v1/projects/${project.id}/connection`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				mode: 'self_hosted',
				executionOwner: 'project_runner',
			}),
		}));

		const dispatched = await app.request(`/v1/projects/${project.id}/dispatch`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${keyResponse.payload.token}`,
			},
			body: JSON.stringify({
				namespace: 'sdk',
				operation: 'refreshGraph',
				input: {},
			}),
		});
		expect(dispatched.status).toBe(200);
		const dispatchedPayload = await json(dispatched);
		expect(dispatchedPayload).toMatchObject({
			ok: true,
			mode: 'job',
			target: 'project_runner',
		});

		const jobId = dispatchedPayload.job.id as string;
		const runnerToken = connectionResponse.payload.runnerToken as string;
		const pulled = await json(await app.request(`/v1/projects/${project.id}/runner/jobs/pull`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${runnerToken}`,
			},
			body: JSON.stringify({ runnerId: 'runner-1', limit: 1 }),
		}));
		expect(pulled.payload[0].id).toBe(jobId);

		await app.request(`/v1/jobs/${jobId}/progress`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${runnerToken}`,
			},
			body: JSON.stringify({ summary: 'runner started', data: { percent: 50 } }),
		});
		await app.request(`/v1/jobs/${jobId}/complete`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${runnerToken}`,
			},
			body: JSON.stringify({ output: { snapshotRoot: 'graph-1' } }),
		});

		const job = await json(await app.request(`/v1/jobs/${jobId}`, {
			headers: {
				authorization: `Bearer ${token}`,
			},
		}));
		expect(job.payload.status).toBe('completed');

		const events = await json(await app.request(`/v1/jobs/${jobId}/events`, {
			headers: {
				authorization: `Bearer ${token}`,
			},
		}));
		expect(events.payload.map((entry: { kind: string }) => entry.kind)).toEqual([
			'created',
			'claimed',
			'progress',
			'completed',
		]);
	});

	it('creates platform operations and lets the Treeseed operations runner claim and complete them', async () => {
		const app = createTestApp({
			config: {
				platformRunnerSecret: 'platform-runner-secret',
			},
		});
		const token = await authorizeApp(app);

		const created = await json(await app.request('/v1/platform/operations', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				namespace: 'repository',
				operation: 'write_content_record',
				idempotencyKey: 'platform-op-one',
				input: { collection: 'notes', slug: 'hello' },
			}),
		}));
		expect(created.ok).toBe(true);
		expect(created.operation).toMatchObject({
			namespace: 'repository',
			operation: 'write_content_record',
			status: 'queued',
			target: 'market_operations_runner',
		});

		const unauthenticatedClaim = await app.request('/v1/platform/runners/jobs/claim', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ runnerId: 'runner-1' }),
		});
		expect(unauthenticatedClaim.status).toBe(401);

		const team = await createTeam(app, token);
		const providerCreated = await json(await app.request(`/v1/teams/${team.id}/capacity-providers`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				name: 'Not A Platform Runner',
				launchMode: 'self_hosted',
			}),
		}));
		const providerClaim = await app.request('/v1/platform/runners/jobs/claim', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${providerCreated.apiKey.plaintext}`,
			},
			body: JSON.stringify({ runnerId: 'provider-1' }),
		});
		expect(providerClaim.status).toBe(401);
		for (const path of [
			`/v1/platform/runners/jobs/${created.operation.id}/renew-lease`,
			`/v1/platform/runners/jobs/${created.operation.id}/checkpoint`,
			`/v1/platform/runners/jobs/${created.operation.id}/complete`,
			`/v1/platform/runners/jobs/${created.operation.id}/fail`,
		]) {
			const providerUpdate = await app.request(path, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${providerCreated.apiKey.plaintext}`,
				},
				body: JSON.stringify({ runnerId: 'provider-1' }),
			});
			expect(providerUpdate.status).toBe(401);
		}

		const registered = await json(await app.request('/v1/platform/runners/register', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: 'Bearer platform-runner-secret',
			},
			body: JSON.stringify({
				runnerId: 'treeseed-ops-test-1',
				environment: 'staging',
				capabilities: ['repository:write_content_record'],
			}),
		}));
		expect(registered.runner).toMatchObject({
			id: 'treeseed-ops-test-1',
			environment: 'staging',
		});

		const claimed = await json(await app.request('/v1/platform/runners/jobs/claim', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: 'Bearer platform-runner-secret',
			},
			body: JSON.stringify({ runnerId: 'treeseed-ops-test-1', limit: 1 }),
		}));
		expect(claimed.operation.id).toBe(created.operation.id);
		expect(claimed.operation.status).toBe('leased');

		const staleCheckpoint = await app.request(`/v1/platform/runners/jobs/${created.operation.id}/checkpoint`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: 'Bearer platform-runner-secret',
			},
			body: JSON.stringify({
				runnerId: 'treeseed-ops-other',
				output: { changedPaths: [] },
			}),
		});
		expect(staleCheckpoint.status).toBe(409);

		const renewed = await json(await app.request(`/v1/platform/runners/jobs/${created.operation.id}/renew-lease`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: 'Bearer platform-runner-secret',
			},
			body: JSON.stringify({
				runnerId: 'treeseed-ops-test-1',
				leaseSeconds: 600,
			}),
		}));
		expect(renewed.operation.leaseExpiresAt).toEqual(expect.any(String));

		const checkpoint = await json(await app.request(`/v1/platform/runners/jobs/${created.operation.id}/checkpoint`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: 'Bearer platform-runner-secret',
			},
			body: JSON.stringify({
				runnerId: 'treeseed-ops-test-1',
				output: { changedPaths: [] },
				event: { kind: 'runner.progress', data: { phase: 'verified' } },
			}),
		}));
		expect(checkpoint.operation.status).toBe('running');

		const completed = await json(await app.request(`/v1/platform/runners/jobs/${created.operation.id}/complete`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: 'Bearer platform-runner-secret',
			},
			body: JSON.stringify({
				runnerId: 'treeseed-ops-test-1',
				output: { changedPaths: ['src/content/notes/hello.mdx'] },
			}),
		}));
		expect(completed.operation.status).toBe('succeeded');

		const events = await json(await app.request(`/v1/platform/operations/${created.operation.id}/events`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(events.events.map((event: Record<string, unknown>) => event.kind)).toEqual([
			'created',
			'claimed',
			'runner.lease_renewed',
			'runner.progress',
			'completed',
		]);
	});

	it('queues project web deployment operations with readiness, idempotency, events, retry, resume, and cancel semantics', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({
			db,
			store,
			config: {
				platformRunnerSecret: 'platform-runner-secret',
			},
		});
		const token = await authorizeApp(app);
		const { team, project } = await createTeamAndProject(app, token, {
			id: 'deploy-project',
			slug: 'deploy-project',
			name: 'Deploy Project',
		});

		const forbidden = await app.request(`/v1/projects/${project.id}/deployments/web`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ environment: 'staging', action: 'deploy_web', capacityProviderId: 'forbidden' }),
		});
		expect(forbidden.status).toBe(400);
		expect(await json(forbidden)).toMatchObject({ error: { code: 'validation_failed' } });

		const noRepo = await app.request(`/v1/projects/${project.id}/deployments/web`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ environment: 'staging', action: 'deploy_web' }),
		});
		expect(noRepo.status).toBe(409);
		expect(await json(noRepo)).toMatchObject({ error: { code: 'repository_not_ready' } });

		await store.upsertHubRepository(project.id, {
			teamId: team.id,
			role: 'software',
			provider: 'github',
			owner: 'treeseed-ai',
			name: 'deploy-project',
			url: 'https://github.com/treeseed-ai/deploy-project',
			defaultBranch: 'staging',
			status: 'ready',
		});
		await json(await app.request(`/v1/teams/${team.id}/web-hosts`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({
				name: 'Team Cloudflare',
				ownership: 'team_owned',
				encryptedPayload: encryptedHostEnvelope(),
			}),
		}));
		await store.upsertProjectEnvironment(project.id, {
			environment: 'staging',
			deploymentProfile: 'hosted_project',
			baseUrl: 'https://staging.deploy-project.example.com',
			pagesProjectName: 'deploy-project',
		});

		const productionWithoutConfirmation = await app.request(`/v1/projects/${project.id}/deployments/web`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ environment: 'prod', action: 'deploy_web' }),
		});
		expect(productionWithoutConfirmation.status).toBe(409);
		expect(await json(productionWithoutConfirmation)).toMatchObject({ error: { code: 'deployment_not_ready' } });

		const queued = await json(await app.request(`/v1/projects/${project.id}/deployments/web`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({
				environment: 'staging',
				action: 'deploy_web',
				source: 'market_ui',
				idempotencyKey: 'deploy-project-staging-one',
			}),
		}));
		expect(queued).toMatchObject({
			ok: true,
			pollUrl: expect.stringContaining('/v1/platform/operations/'),
			eventsUrl: expect.stringContaining(`/v1/projects/${project.id}/deployments/`),
			stateUrl: `/v1/projects/${project.id}/deployment-state`,
			deployment: {
				projectId: project.id,
				teamId: team.id,
				environment: 'staging',
				action: 'deploy_web',
				status: 'queued',
				idempotencyKey: 'deploy-project-staging-one',
			},
			operation: {
				namespace: 'project',
				operation: 'web_deployment',
				status: 'queued',
				target: 'market_operations_runner',
			},
		});
		expect(JSON.stringify(queued)).not.toContain('runnerToken');
		expect(JSON.stringify(queued)).not.toContain('capacityProviderId');

		const repeated = await json(await app.request(`/v1/projects/${project.id}/deployments/web`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({
				environment: 'staging',
				action: 'deploy_web',
				idempotencyKey: 'deploy-project-staging-one',
			}),
		}));
		expect(repeated.deployment.id).toBe(queued.deployment.id);
		expect(repeated.operation.id).toBe(queued.operation.id);

		const listed = await json(await app.request(`/v1/projects/${project.id}/deployments`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(listed.payload).toEqual([
			expect.objectContaining({ id: queued.deployment.id, platformOperationId: queued.operation.id }),
		]);

		const detail = await json(await app.request(`/v1/projects/${project.id}/deployments/${queued.deployment.id}`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(detail.payload).toMatchObject({ id: queued.deployment.id, platformOperationId: queued.operation.id });

		const events = await json(await app.request(`/v1/projects/${project.id}/deployments/${queued.deployment.id}/events`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(events.payload.map((event: any) => event.kind)).toEqual(expect.arrayContaining([
			'deployment.requested',
			'deployment.operation_queued',
			'created',
		]));

		const state = await json(await app.request(`/v1/projects/${project.id}/deployment-state`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(state).toMatchObject({
			ok: true,
			project: { id: project.id },
			latestDeployments: {
				staging: expect.objectContaining({ id: queued.deployment.id }),
			},
			readiness: {
				ready: false,
			},
		});
		expect(state.activeOperations).toHaveLength(1);

		const resumed = await app.request(`/v1/projects/${project.id}/deployments/${queued.deployment.id}/resume`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({}),
		});
		expect(resumed.status).toBe(409);
		expect(await json(resumed)).toMatchObject({ error: { code: 'operation_not_retryable' } });

		const cancelled = await json(await app.request(`/v1/projects/${project.id}/deployments/${queued.deployment.id}/cancel`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({}),
		}));
		expect(cancelled).toMatchObject({
			ok: true,
			cancellation: 'completed',
			deployment: {
				status: 'cancelled',
				completedAt: expect.any(String),
			},
		});

		const retried = await json(await app.request(`/v1/projects/${project.id}/deployments/${queued.deployment.id}/retry`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ idempotencyKey: 'deploy-project-staging-retry-one' }),
		}));
		expect(retried).toMatchObject({
			ok: true,
			originalDeployment: { id: queued.deployment.id },
			retryDeployment: {
				retryOfDeploymentId: queued.deployment.id,
				status: 'queued',
				platformOperationId: retried.operation.id,
			},
			operation: {
				namespace: 'project',
				operation: 'web_deployment',
			},
		});
	});

	it('enforces deployment governance and audit/redaction boundaries', async () => {
		const { app, store, team, project } = await createDeploymentReadyProject('deployment-governance-project');
		await store.upsertProjectEnvironment(project.id, {
			environment: 'prod',
			deploymentProfile: 'hosted_project',
			baseUrl: 'https://deployment-governance-project.example.com',
			pagesProjectName: 'deployment-governance-project',
		});

		const readOnlyKey = await store.createTeamApiKey(team.id, {
			name: 'Read only deployment key',
			permissions: ['project:read'],
		});
		const noPermissionKey = await store.createTeamApiKey(team.id, {
			name: 'No deployment key',
			permissions: [],
		});
		const apiKeyRead = await app.request(`/v1/projects/${project.id}/deployments`, {
			headers: { authorization: `Bearer ${readOnlyKey.token}` },
		});
		expect(apiKeyRead.status).toBe(200);
		const apiKeyDeniedRead = await app.request(`/v1/projects/${project.id}/deployments`, {
			headers: { authorization: `Bearer ${noPermissionKey.token}` },
		});
		expect(apiKeyDeniedRead.status).toBe(403);

		const contributorToken = await authorizeApp(app, { principalId: 'deployment-contributor', displayName: 'Deployment Contributor' });
		await store.upsertTeamMember(team.id, 'deployment-contributor', 'contributor');
		const contributorDeploy = await app.request(`/v1/projects/${project.id}/deployments/web`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${contributorToken}` },
			body: JSON.stringify({ environment: 'staging', action: 'deploy_web', idempotencyKey: 'contributor-deploy-denied' }),
		});
		expect(contributorDeploy.status).toBe(403);
		expect(await json(contributorDeploy)).toMatchObject({ error: { code: 'not_authorized' } });

		const contributorMonitor = await json(await app.request(`/v1/projects/${project.id}/deployments/web`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${contributorToken}` },
			body: JSON.stringify({ environment: 'staging', action: 'monitor', idempotencyKey: 'contributor-monitor-ok' }),
		}));
		expect(contributorMonitor.deployment).toMatchObject({ action: 'monitor', status: 'queued' });
		const directDeploymentRead = await app.request(`/v1/project-deployments/${contributorMonitor.deployment.id}`, {
			headers: { authorization: `Bearer ${readOnlyKey.token}` },
		});
		expect(directDeploymentRead.status).toBe(200);
		const directDeploymentDenied = await app.request(`/v1/project-deployments/${contributorMonitor.deployment.id}`, {
			headers: { authorization: `Bearer ${noPermissionKey.token}` },
		});
		expect(directDeploymentDenied.status).toBe(403);
		const contributorMonitorRepeat = await json(await app.request(`/v1/projects/${project.id}/deployments/web`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${contributorToken}` },
			body: JSON.stringify({ environment: 'staging', action: 'monitor', idempotencyKey: 'contributor-monitor-ok' }),
		}));
		expect(contributorMonitorRepeat.deployment.id).toBe(contributorMonitor.deployment.id);

		const reviewerToken = await authorizeApp(app, { principalId: 'deployment-reviewer', displayName: 'Deployment Reviewer' });
		await store.upsertTeamMember(team.id, 'deployment-reviewer', 'reviewer');
		const reviewerDeploy = await json(await app.request(`/v1/projects/${project.id}/deployments/web`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${reviewerToken}` },
			body: JSON.stringify({ environment: 'staging', action: 'deploy_web', idempotencyKey: 'reviewer-staging-deploy-ok' }),
		}));
		expect(reviewerDeploy.deployment).toMatchObject({ environment: 'staging', action: 'deploy_web', status: 'queued' });
		const reviewerProduction = await app.request(`/v1/projects/${project.id}/deployments/web`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${reviewerToken}` },
			body: JSON.stringify({ environment: 'prod', action: 'deploy_web', confirmProduction: true, idempotencyKey: 'reviewer-prod-denied' }),
		});
		expect(reviewerProduction.status).toBe(403);

		const leadToken = await authorizeApp(app, { principalId: 'deployment-lead', displayName: 'Deployment Lead' });
		await store.upsertTeamMember(team.id, 'deployment-lead', 'project_lead');
		const productionWithoutConfirmation = await app.request(`/v1/projects/${project.id}/deployments/web`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${leadToken}` },
			body: JSON.stringify({ environment: 'prod', action: 'deploy_web', idempotencyKey: 'lead-prod-no-confirm' }),
		});
		expect(productionWithoutConfirmation.status).toBe(409);
		const productionDeploy = await json(await app.request(`/v1/projects/${project.id}/deployments/web`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${leadToken}` },
			body: JSON.stringify({ environment: 'prod', action: 'deploy_web', confirmProduction: true, idempotencyKey: 'lead-prod-confirmed' }),
		}));
		expect(productionDeploy.deployment).toMatchObject({ environment: 'prod', action: 'deploy_web', status: 'queued' });
		const stagingPublish = await json(await app.request(`/v1/projects/${project.id}/deployments/web`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${leadToken}` },
			body: JSON.stringify({ environment: 'staging', action: 'publish_content', idempotencyKey: 'lead-staging-publish' }),
		}));
		expect(stagingPublish.deployment).toMatchObject({ action: 'publish_content', status: 'queued' });

		const failedDeployment = await store.updateProjectDeployment(reviewerDeploy.deployment.id, { status: 'failed', summary: 'Failed for retry test.' });
		const readOnlyRetry = await app.request(`/v1/projects/${project.id}/deployments/${failedDeployment!.id}/retry`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${readOnlyKey.token}` },
			body: JSON.stringify({ idempotencyKey: 'read-only-retry-denied' }),
		});
		expect(readOnlyRetry.status).toBe(403);
		const retry = await json(await app.request(`/v1/projects/${project.id}/deployments/${failedDeployment!.id}/retry`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${reviewerToken}` },
			body: JSON.stringify({ idempotencyKey: 'reviewer-retry-ok' }),
		}));
		expect(retry.retryDeployment.retryOfDeploymentId).toBe(failedDeployment!.id);
		const resume = await app.request(`/v1/projects/${project.id}/deployments/${failedDeployment!.id}/resume`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${reviewerToken}` },
			body: JSON.stringify({}),
		});
		expect(resume.status).toBe(409);

		const cancelKey = await store.createTeamApiKey(team.id, {
			name: 'Cancel deployment key',
			permissions: ['project:deployment:cancel'],
		});
		const cancelled = await json(await app.request(`/v1/projects/${project.id}/deployments/${contributorMonitor.deployment.id}/cancel`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${cancelKey.token}` },
			body: JSON.stringify({}),
		}));
		expect(cancelled.deployment.status).toBe('cancelled');

		const monitorKey = await store.createTeamApiKey(team.id, {
			name: 'Monitor deployment key',
			permissions: ['project:monitor'],
		});
		const apiKeyMonitor = await json(await app.request(`/v1/projects/${project.id}/deployments/web`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${monitorKey.token}` },
			body: JSON.stringify({ environment: 'prod', action: 'monitor', idempotencyKey: 'api-key-monitor-prod-ok' }),
		}));
		expect(apiKeyMonitor.deployment).toMatchObject({ action: 'monitor', environment: 'prod', status: 'queued' });

		await store.appendProjectDeploymentEvent(productionDeploy.deployment.id, {
			kind: 'deployment.security_probe',
			message: 'Security probe.',
			payload: {
				runnerToken: 'runner-token-secret',
				nested: {
					capacityProviderId: 'capacity-provider-secret',
					apiKey: 'sk-secret-token-value',
				},
			},
		});
		await store.recordAuditEvent({
			eventType: 'security_probe',
			actorType: 'user',
			actorId: 'deployment-lead',
			targetType: 'project',
			targetId: project.id,
			data: {
				runnerToken: 'runner-token-secret',
				capacityProviderId: 'capacity-provider-secret',
				rawProviderResponse: { token: 'secret-token' },
			},
		});
		const deploymentEvents = await store.listProjectDeploymentEvents(productionDeploy.deployment.id);
		const auditEvents = await store.listAuditEventsForTarget('project', project.id, 100);
		const auditTypes = auditEvents.map((event: Record<string, unknown>) => event.eventType);
		expect(auditTypes).toEqual(expect.arrayContaining([
			'project_deployment_requested',
			'project_production_deployment_requested',
			'project_content_publish_requested',
			'project_deployment_retry_requested',
			'project_deployment_resume_requested',
			'project_deployment_cancel_requested',
			'project_deployment_cancelled',
		]));
		const contributorRequestEvents = auditEvents.filter((event: any) => event.eventType === 'project_deployment_requested' && event.data?.deploymentId === contributorMonitor.deployment.id);
		expect(contributorRequestEvents).toHaveLength(1);
		const serialized = JSON.stringify({ deploymentEvents, auditEvents });
		expect(serialized).not.toContain('runner-token-secret');
		expect(serialized).not.toContain('capacity-provider-secret');
		expect(serialized).not.toContain('capacityProviderId');
		expect(serialized).not.toContain('runnerToken');
		expect(serialized).not.toContain('sk-secret-token-value');
	}, 20_000);

	it('runs mocked project web deployments through the Treeseed operations runner', async () => {
		const { app, store, token, project } = await createDeploymentReadyProject('runner-web-deploy-project');
		await store.upsertProjectArchitecture(project.id, {
			topology: 'single_repository_site',
			rootPath: '.',
			sitePath: '.',
			contentPath: 'src/content',
			contentRuntimeSource: 'r2_published_manifest',
			localContentMaterialization: 'existing_path',
			contentPublishTarget: {
				kind: 'cloudflare_r2',
				bucket: 'treeseed-content',
				manifestPath: 'teams/runner-web-deploy-project/published/common.json',
			},
		});
		const unrelated = await store.createPlatformOperation({
			namespace: 'market',
			operation: 'noop',
			target: 'market_operations_runner',
			input: {},
			requestedByType: 'user',
			requestedById: 'user-1',
		});
		const queued = await json(await app.request(`/v1/projects/${project.id}/deployments/web`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({
				environment: 'staging',
				action: 'deploy_web',
				idempotencyKey: 'runner-web-deploy-success',
			}),
		}));
		expect(JSON.stringify(queued)).not.toMatch(/railway/i);

		await withHttpMarketApp(app, async (baseUrl) => {
			const client = new PlatformRunnerClient({
				marketUrl: baseUrl,
				marketId: 'local',
				runnerSecret: 'platform-runner-secret',
			});
			const result = await runOnceWithClient({
				runnerId: 'treeseed-ops-web-runner-01',
				environment: 'staging',
				dataDir: packageRoot,
			}, client, 'test', {
				deploymentStore: store,
				operationKey: 'project:web_deployment',
				mockExternal: true,
				mockResult: 'success',
			});
			expect(result).toMatchObject({
				ok: true,
				claimed: true,
				output: {
					ok: true,
					deploymentId: queued.deployment.id,
					externalWorkflow: {
						provider: 'github',
						runId: 9001,
						runUrl: expect.stringContaining('/actions/runs/9001'),
						mock: true,
					},
				},
			});
		});

		expect(unrelated).not.toBeNull();
		const untouched = await store.findPlatformOperationById(unrelated!.id);
		expect(untouched).not.toBeNull();
		expect(untouched!.status).toBe('queued');
		const completedOperation = await store.findPlatformOperationById(queued.operation.id);
		expect(completedOperation).not.toBeNull();
		expect(completedOperation!.status).toBe('succeeded');
		expect(JSON.stringify(completedOperation)).not.toMatch(/railway/i);
		const deployment = await store.findProjectDeploymentById(queued.deployment.id);
		expect(deployment).not.toBeNull();
		expect(deployment).toMatchObject({
			status: 'succeeded',
			completedAt: expect.any(String),
			externalWorkflow: {
				runId: 9001,
				mock: true,
				conclusion: 'success',
			},
			target: {
				baseUrl: 'https://staging.runner-web-deploy-project.example.com',
			},
			monitor: {
				status: 'healthy',
				contentRuntime: {
					contentRuntimeSource: 'r2_published_manifest',
					effectiveContentSource: 'r2_published_manifest',
					manifestKey: 'teams/runner-web-deploy-project/published/common.json',
				},
				checks: expect.arrayContaining([
					expect.objectContaining({ key: 'latest_workflow', status: 'passed' }),
					expect.objectContaining({ key: 'workflow_file', status: 'passed' }),
					expect.objectContaining({ key: 'http_response', status: 'passed' }),
					expect.objectContaining({ key: 'content_runtime', status: 'passed', source: 'r2' }),
				]),
			},
			summary: 'deploy_web for staging succeeded.',
		});
		const events = await store.listProjectDeploymentEvents(deployment!.id);
		expect(events.map((event: Record<string, unknown>) => event.kind)).toEqual(expect.arrayContaining([
			'deployment.preflight.started',
			'deployment.preflight.completed',
			'deployment.workflow.dispatching',
			'deployment.workflow.dispatched',
			'deployment.workflow.running',
			'deployment.workflow.completed',
			'deployment.monitor.started',
			'deployment.monitor.completed',
			'deployment.succeeded',
		]));
		const auditEvents = await store.listAuditEventsForTarget('project', project.id, 50);
		expect(auditEvents.map((event: Record<string, unknown>) => event.eventType)).toEqual(expect.arrayContaining([
			'project_monitor_completed',
			'project_deployment_succeeded',
		]));
		const environments = await store.listProjectEnvironments(project.id);
		expect(environments.find((entry: Record<string, unknown>) => entry.environment === 'staging')).toMatchObject({
			baseUrl: 'https://staging.runner-web-deploy-project.example.com',
			metadata: {
					lastDeploymentId: deployment!.id,
					lastOperationId: queued.operation.id,
				},
			});
		expect(await store.all(`SELECT * FROM capacity_providers`)).toHaveLength(0);
		expect(JSON.stringify(completedOperation!)).not.toContain('capacityProviderId');
	}, 20_000);

	it('records mocked project web deployment failures with GitHub inspect guidance', async () => {
		const { app, store, token, project } = await createDeploymentReadyProject('runner-web-deploy-failure');
		const queued = await json(await app.request(`/v1/projects/${project.id}/deployments/web`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({
				environment: 'staging',
				action: 'deploy_web',
				idempotencyKey: 'runner-web-deploy-failure',
			}),
		}));

		await withHttpMarketApp(app, async (baseUrl) => {
			const client = new PlatformRunnerClient({
				marketUrl: baseUrl,
				marketId: 'local',
				runnerSecret: 'platform-runner-secret',
			});
			const result = await runOnceWithClient({
				runnerId: 'treeseed-ops-web-runner-02',
				environment: 'staging',
				dataDir: packageRoot,
			}, client, 'test', {
				deploymentStore: store,
				operationKey: 'project:web_deployment',
				mockExternal: true,
				mockResult: 'failure',
			});
			expect(result).toMatchObject({
				ok: false,
				claimed: true,
				error: { message: expect.stringContaining('deploy-web.yml') },
			});
		});

		const operation = await store.findPlatformOperationById(queued.operation.id);
		const deployment = await store.findProjectDeploymentById(queued.deployment.id);
		expect(operation).not.toBeNull();
		expect(deployment).not.toBeNull();
		expect(operation!.status).toBe('failed');
		expect(deployment).toMatchObject({
			status: 'failed',
			completedAt: expect.any(String),
			error: {
				provider: 'github',
				inspectCommand: 'gh run view 9001 --repo treeseed-ai/runner-web-deploy-failure --log-failed',
				failedJobName: 'deploy',
				retrySafe: true,
				resumeSafe: false,
				blockerCode: 'github_workflow_failed',
			},
		});
		const events = await store.listProjectDeploymentEvents(deployment!.id);
		expect(events.map((event: Record<string, unknown>) => event.kind)).toEqual(expect.arrayContaining([
			'deployment.workflow.completed',
			'deployment.failed',
		]));
		const auditEvents = await store.listAuditEventsForTarget('project', project.id, 50);
		expect(auditEvents.map((event: Record<string, unknown>) => event.eventType)).toContain('project_deployment_failed');
	});

	it('runs monitor-only deployments without workflow dispatch and exposes latest monitor state', async () => {
		const { app, store, token, project } = await createDeploymentReadyProject('runner-web-monitor-project');
		const queued = await json(await app.request(`/v1/projects/${project.id}/deployments/web`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({
				environment: 'staging',
				action: 'monitor',
				idempotencyKey: 'runner-web-monitor-success',
			}),
		}));

		await withHttpMarketApp(app, async (baseUrl) => {
			const client = new PlatformRunnerClient({
				marketUrl: baseUrl,
				marketId: 'local',
				runnerSecret: 'platform-runner-secret',
			});
			const result = await runOnceWithClient({
				runnerId: 'treeseed-ops-web-runner-monitor',
				environment: 'staging',
				dataDir: packageRoot,
			}, client, 'test', {
				deploymentStore: store,
				operationKey: 'project:web_deployment',
				mockExternal: true,
				mockResult: 'success',
			});
			expect(result).toMatchObject({
				ok: true,
				claimed: true,
				output: {
					ok: true,
					deploymentId: queued.deployment.id,
					externalWorkflow: null,
					monitor: {
						status: 'healthy',
					},
				},
			});
		});

		const deployment = await store.findProjectDeploymentById(queued.deployment.id);
		expect(deployment).toMatchObject({
			status: 'succeeded',
			action: 'monitor',
			monitor: {
				status: 'healthy',
				checks: expect.arrayContaining([
					expect.objectContaining({ key: 'workflow_file', status: 'passed' }),
					expect.objectContaining({ key: 'http_response', status: 'passed' }),
				]),
			},
		});
		const events = await store.listProjectDeploymentEvents(queued.deployment.id);
		expect(events.map((event: Record<string, unknown>) => event.kind)).toEqual(expect.arrayContaining([
			'deployment.preflight.started',
			'deployment.preflight.completed',
			'deployment.monitor.started',
			'deployment.monitor.completed',
			'deployment.succeeded',
		]));
		expect(events.map((event: Record<string, unknown>) => event.kind)).not.toContain('deployment.workflow.dispatching');

		const state = await json(await app.request(`/v1/projects/${project.id}/deployment-state`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(state.latestMonitors.staging).toMatchObject({
			status: 'healthy',
			checks: expect.arrayContaining([
				expect.objectContaining({ key: 'http_response', status: 'passed' }),
			]),
		});
	});

	it('marks claimed project web deployments cancelled before dispatch when cancellation is requested', async () => {
		const { app, store, token, project } = await createDeploymentReadyProject('runner-web-deploy-cancel');
		const queued = await json(await app.request(`/v1/projects/${project.id}/deployments/web`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({
				environment: 'staging',
				action: 'deploy_web',
				idempotencyKey: 'runner-web-deploy-cancel',
			}),
		}));
		const beforeCancel = await store.findProjectDeploymentById(queued.deployment.id);
		expect(beforeCancel).not.toBeNull();
		await store.updateProjectDeployment(beforeCancel!.id, {
			metadata: {
				...(beforeCancel!.metadata ?? {}),
				cancellation: {
					requested: true,
					requestedAt: '2026-01-01T00:00:00.000Z',
					actor: { id: 'user-1', type: 'user' },
				},
			},
		});

		await withHttpMarketApp(app, async (baseUrl) => {
			const client = new PlatformRunnerClient({
				marketUrl: baseUrl,
				marketId: 'local',
				runnerSecret: 'platform-runner-secret',
			});
			const result = await runOnceWithClient({
				runnerId: 'treeseed-ops-web-runner-03',
				environment: 'staging',
				dataDir: packageRoot,
			}, client, 'test', {
				deploymentStore: store,
				operationKey: 'project:web_deployment',
				mockExternal: true,
			});
			expect(result).toMatchObject({
				ok: false,
				claimed: true,
				operation: { status: 'cancelled' },
				error: { message: 'Deployment cancellation was requested.' },
			});
		});

		const deployment = await store.findProjectDeploymentById(queued.deployment.id);
		expect(deployment).not.toBeNull();
		expect(deployment).toMatchObject({
			status: 'cancelled',
			completedAt: expect.any(String),
			error: {
				code: 'deployment_cancelled',
				retrySafe: true,
				resumeSafe: false,
			},
		});
		const events = await store.listProjectDeploymentEvents(deployment!.id);
		expect(events.map((event: Record<string, unknown>) => event.kind)).toContain('deployment.cancelled');
		expect(events.map((event: Record<string, unknown>) => event.kind)).not.toContain('deployment.workflow.dispatching');
		const auditEvents = await store.listAuditEventsForTarget('project', project.id, 50);
		expect(auditEvents.map((event: Record<string, unknown>) => event.eventType)).toContain('project_deployment_cancelled');
	});

	it('tracks platform repository claims with runner ownership and safe release metadata', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		await store.ensureInitialized();
		await store.upsertMarketOperationRunner({
			runnerId: 'treeseed-ops-runner-01',
			environment: 'staging',
			metadata: { dataDir: '/data' },
		});
		const operation = await store.createPlatformOperation({
			namespace: 'repository',
			operation: 'write_content_record',
			input: {
				repository: {
					provider: 'local',
					owner: 'treeseed',
					name: 'market',
					defaultBranch: 'staging',
					cloneUrl: '/tmp/market',
				},
			},
			requestedByType: 'user',
			requestedById: 'user-1',
		});
		expect(operation).not.toBeNull();
		const claimed = await store.claimPlatformOperation({
			runnerId: 'treeseed-ops-runner-01',
			operationId: operation!.id,
			leaseSeconds: 120,
		});
		expect(claimed).not.toBeNull();
		expect(claimed!.assignedRunnerId).toBe('treeseed-ops-runner-01');
		const claimRows = await store.all(`SELECT * FROM platform_repository_claims`);
		expect(claimRows).toHaveLength(1);
		expect(claimRows[0]).toMatchObject({
			repository_key: 'local-treeseed-market',
			runner_id: 'treeseed-ops-runner-01',
			workspace_path: '/data/repositories/local-treeseed-market/repo',
			branch: 'staging',
			claim_state: 'active',
		});
		const events = await store.listPlatformOperationEvents(operation!.id);
		expect(events.map((event: Record<string, unknown>) => event.kind)).toEqual(['created', 'claimed', 'repository.claimed']);
		await store.renewPlatformOperationLease(operation!.id, {
			runnerId: 'treeseed-ops-runner-01',
			leaseSeconds: 240,
		});
		const renewed = await store.all(`SELECT * FROM platform_repository_claims`);
		expect(renewed[0].lease_expires_at).toEqual(expect.any(String));
		await store.completePlatformOperation(operation!.id, {
			runnerId: 'treeseed-ops-runner-01',
			output: {
				branch: 'treeseed/platform-test',
				commitSha: 'abcdef1234567890abcdef1234567890abcdef12',
			},
		});
		const released = await store.all(`SELECT * FROM platform_repository_claims`);
		expect(released[0]).toMatchObject({
			claim_state: 'released',
			branch: 'treeseed/platform-test',
			commit_sha: 'abcdef1234567890abcdef1234567890abcdef12',
			lease_expires_at: null,
		});
	});

	it('skips approval-waiting operations and preserves cancellation/retry safety', async () => {
		const app = createTestApp({
			config: {
				platformRunnerSecret: 'platform-runner-secret',
			},
		});
		const token = await authorizeApp(app);
		const waiting = await json(await app.request('/v1/platform/operations', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				namespace: 'repository',
				operation: 'write_content_record',
				input: {
					approvalRequired: true,
					approvalId: 'approval-one',
					collection: 'notes',
				},
			}),
		}));
		expect(waiting.operation.status).toBe('waiting_for_approval');
		const skipped = await json(await app.request('/v1/platform/runners/jobs/claim', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: 'Bearer platform-runner-secret',
			},
			body: JSON.stringify({ runnerId: 'treeseed-ops-test-1', operationId: waiting.operation.id }),
		}));
		expect(skipped.operation).toBe(null);

		const created = await json(await app.request('/v1/platform/operations', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				namespace: 'market',
				operation: 'noop',
				input: {},
			}),
		}));
		await json(await app.request('/v1/platform/runners/jobs/claim', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: 'Bearer platform-runner-secret',
			},
			body: JSON.stringify({ runnerId: 'treeseed-ops-test-1', operationId: created.operation.id }),
		}));
		const cancelled = await json(await app.request(`/v1/platform/operations/${created.operation.id}/cancel`, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(cancelled.operation.status).toBe('cancelled');
		const completeAfterCancel = await app.request(`/v1/platform/runners/jobs/${created.operation.id}/complete`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: 'Bearer platform-runner-secret',
			},
			body: JSON.stringify({ runnerId: 'treeseed-ops-test-1', output: { late: true } }),
		});
		expect(completeAfterCancel.status).toBe(409);
		const retried = await json(await app.request(`/v1/platform/operations/${created.operation.id}/retry`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ inputPatch: { retry: true } }),
		}));
		expect(retried.operation).toMatchObject({
			status: 'queued',
			assignedRunnerId: null,
			leaseExpiresAt: null,
			input: { retry: true },
		});
	});

	it('lets the Treeseed operations runner complete a queued noop operation through API service auth', async () => {
		const app = createTestApp({
			config: {
				platformRunnerSecret: 'platform-runner-secret',
			},
		});
		const token = await authorizeApp(app);
		const created = await json(await app.request('/v1/platform/operations', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				namespace: 'market',
				operation: 'noop',
				input: { source: 'runner-integration-test' },
			}),
		}));
		await withHttpMarketApp(app, async (baseUrl) => {
			const client = new PlatformRunnerClient({
				marketUrl: baseUrl,
				marketId: 'local',
				runnerSecret: 'platform-runner-secret',
			});
			const result = await runOnceWithClient({
				runnerId: 'treeseed-ops-test-1',
				environment: 'local',
				dataDir: resolve(packageRoot, '.treeseed/test-treeseed-ops'),
			}, client, 'test');
			expect(result).toMatchObject({ ok: true, claimed: true });
		});
		const completed = await json(await app.request(`/v1/platform/operations/${created.operation.id}`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(completed.operation).toMatchObject({
			status: 'succeeded',
			terminal: true,
			output: {
				ok: true,
				message: 'Treeseed operations runner diagnostic completed.',
			},
		});
	});

	it('converts local content write routes into repository platform operations', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const { project } = await createTeamAndProject(app, token, {
			id: 'platform-content-project',
			slug: 'platform-content-project',
			name: 'Platform Content Project',
		});

		const response = await json(await app.request(`/v1/projects/${project.id}/local-content/notes`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				title: 'Queued note',
				summary: 'This should become a platform operation.',
				idempotencyKey: 'note-queued-one',
			}),
		}));

		expect(response.ok).toBe(true);
		expect(response).not.toHaveProperty('payload');
		expect(response.job).toMatchObject({
			namespace: 'repository',
			operation: 'write_content_record',
			status: 'queued',
			input: {
				projectId: project.id,
				collection: 'notes',
				repository: {
					name: 'platform-content-project',
					cloneUrl: packageRoot,
					writeMode: 'workspace',
				},
			},
		});
	});

	it('queues core objective repository sync when project settings change the objective', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const { project } = await createTeamAndProject(app, token, {
			id: 'settings-core-objective-project',
			slug: 'settings-core-objective-project',
			name: 'Settings Core Objective Project',
			metadata: {
				coreObjective: '# Core Objective\n\nOriginal objective.',
			},
		});

		const response = await json(await app.request(`/v1/projects/${project.id}`, {
			method: 'PUT',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				name: 'Settings Core Objective Project',
				slug: 'settings-core-objective-project',
				coreObjective: '# Core Objective\n\nUpdated objective for repository sync.',
			}),
		}));

		expect(response.ok).toBe(true);
		expect(response.payload.project.metadata.coreObjective).toContain('Updated objective');
		expect(response.coreObjectiveJob).toMatchObject({
			namespace: 'repository',
			operation: 'write_content_record',
			status: 'queued',
			input: {
				projectId: project.id,
				repositoryRole: 'content',
				collection: 'objectives',
				normalized: expect.objectContaining({
					slug: 'core',
					body: '# Core Objective\n\nUpdated objective for repository sync.',
				}),
				payload: expect.objectContaining({
					overwrite: true,
					preserveFrontmatter: true,
				}),
				repository: expect.objectContaining({
					writeMode: 'branch',
					push: true,
					branchName: expect.stringContaining('treeseed/core-objective-'),
				}),
				approvalRequired: true,
				approvalSatisfied: true,
				approvalId: expect.stringContaining(`project-settings:${project.id}:core-objective:`),
			},
		});
	});

	it('runs repository content jobs in the runner workspace instead of the API process', async () => {
		const fixture = createRunnerRepoFixture();
		try {
			const app = createTestApp({
				config: {
					platformRunnerSecret: 'platform-runner-secret',
				},
			});
			const token = await authorizeApp(app);
			const { project } = await createTeamAndProject(app, token, {
				id: 'runner-repository-project',
				slug: 'runner-repository-project',
				name: 'Runner Repository Project',
			});
			const queued = await json(await app.request(`/v1/projects/${project.id}/local-content/notes`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					title: 'Runner executed note',
					summary: 'Written by the Treeseed operations runner.',
					repository: {
						provider: 'local',
						owner: 'treeseed',
						name: 'runner-repository-project',
						defaultBranch: 'staging',
						cloneUrl: fixture.repo,
						writeMode: 'workspace',
					},
				}),
			}));
			await withHttpMarketApp(app, async (baseUrl) => {
				const client = new PlatformRunnerClient({
					marketUrl: baseUrl,
					marketId: 'local',
					runnerSecret: 'platform-runner-secret',
				});
				const result = await runOnceWithClient({
					runnerId: 'treeseed-ops-test-1',
					environment: 'local',
					dataDir: fixture.workspace,
				}, client, 'test', { operationId: queued.job.id });
				expect(result).toMatchObject({ ok: true, claimed: true });
			});
			const completed = await json(await app.request(`/v1/platform/operations/${queued.job.id}`, {
				headers: { authorization: `Bearer ${token}` },
			}));
			expect(completed.operation).toMatchObject({
				status: 'succeeded',
				href: '/app/work/notes/runner-executed-note',
				changedPaths: ['src/content/notes/runner-executed-note.mdx'],
				branch: 'staging',
				commitSha: null,
				output: {
					href: '/app/work/notes/runner-executed-note',
					changedPaths: ['src/content/notes/runner-executed-note.mdx'],
					baseBranch: 'staging',
					branch: 'staging',
					commitSha: null,
					verification: null,
					pullRequest: null,
					workflowRun: null,
					workspacePath: '<runner-workspace>',
				},
			});
			expect(JSON.stringify(completed.operation.output)).not.toContain(fixture.workspace);
			expect(existsSync(resolve(fixture.repo, 'src/content/notes/runner-executed-note.mdx'))).toBe(false);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it('queues linked repository initialization through the project API and operations runner', async () => {
		const fixture = createRunnerRepoFixture();
		try {
			const app = createTestApp({
				config: {
					platformRunnerSecret: 'platform-runner-secret',
				},
			});
			const token = await authorizeApp(app);
			const { project } = await createTeamAndProject(app, token, {
				id: 'linked-repository-project',
				slug: 'linked-repository-project',
				name: 'Linked Repository Project',
				metadata: {
					architecture: {
						topology: 'single_repository_site',
						rootPath: '.',
						sitePath: 'docs',
						contentPath: 'docs',
						contentRuntimeSource: 'r2_published_manifest',
						localContentMaterialization: 'none',
					},
				},
			});
			const queued = await json(await app.request(`/v1/projects/${project.id}/repositories/primary/initialize`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					repository: {
						provider: 'local',
						owner: 'treeseed',
						name: 'linked-repository-project',
						defaultBranch: 'staging',
						cloneUrl: fixture.repo,
						writeMode: 'workspace',
					},
					scaffoldFiles: [{
						path: 'docs/README.md',
						content: '# Linked Repository Project\n\nPrepared by a TreeSeed template.\n',
					}],
				}),
			}));
			expect(queued.ok).toBe(true);
			expect(queued.operation).toMatchObject({
				namespace: 'repository',
				operation: 'initialize_linked_repository',
				status: 'queued',
				input: {
					projectId: project.id,
					repositoryRole: 'primary',
					architecture: expect.objectContaining({
						topology: 'single_repository_site',
						sitePath: 'docs',
					}),
					scaffoldFiles: [{
						path: 'docs/README.md',
						content: '# Linked Repository Project\n\nPrepared by a TreeSeed template.\n',
					}],
					repository: expect.objectContaining({
						provider: 'local',
						name: 'linked-repository-project',
						cloneUrl: fixture.repo,
					}),
				},
			});
			await withHttpMarketApp(app, async (baseUrl) => {
				const client = new PlatformRunnerClient({
					marketUrl: baseUrl,
					marketId: 'local',
					runnerSecret: 'platform-runner-secret',
				});
				const result = await runOnceWithClient({
					runnerId: 'treeseed-ops-test-1',
					environment: 'local',
					dataDir: fixture.workspace,
				}, client, 'test', { operationId: queued.operation.id });
				expect(result).toMatchObject({ ok: true, claimed: true });
			});
			const completed = await json(await app.request(`/v1/platform/operations/${queued.operation.id}`, {
				headers: { authorization: `Bearer ${token}` },
			}));
			expect(completed.operation).toMatchObject({
				status: 'succeeded',
				changedPaths: ['docs/README.md'],
				output: {
					changedPaths: ['docs/README.md'],
					workspacePath: '<runner-workspace>',
					output: expect.objectContaining({
						kind: 'linked_repository_initialization',
						mode: 'template_scaffold',
						scaffoldedPaths: ['docs/README.md'],
					}),
				},
			});
			expect(JSON.stringify(completed.operation.output)).not.toContain(fixture.workspace);
			expect(JSON.stringify(completed.operation.output)).not.toMatch(/ghp_|TREESEED_GITHUB_TOKEN=/u);
			expect(existsSync(resolve(fixture.repo, 'docs/README.md'))).toBe(false);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it('runs branch-mode repository jobs with verification and fails before commit when verification fails', async () => {
		const fixture = createRunnerRepoFixture();
		try {
			const app = createTestApp({
				config: {
					platformRunnerSecret: 'platform-runner-secret',
				},
			});
			const token = await authorizeApp(app);
			const branchJob = await json(await app.request('/v1/platform/operations', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					namespace: 'repository',
					operation: 'write_content_record',
					input: {
						projectId: 'runner-branch-project',
						collection: 'notes',
						payload: { title: 'Branch verified note' },
						repository: {
							provider: 'local',
							owner: 'treeseed',
							name: 'runner-branch-project',
							defaultBranch: 'staging',
							cloneUrl: fixture.repo,
							writeMode: 'branch',
							branchName: 'treeseed/branch-verified',
							verificationCommands: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }],
						},
					},
				}),
			}));
			await withHttpMarketApp(app, async (baseUrl) => {
				const client = new PlatformRunnerClient({
					marketUrl: baseUrl,
					marketId: 'local',
					runnerSecret: 'platform-runner-secret',
				});
				const result = await runOnceWithClient({
					runnerId: 'treeseed-ops-runner-01',
					environment: 'staging',
					dataDir: fixture.workspace,
				}, client, 'test', { operationId: branchJob.operation.id });
				expect(result).toMatchObject({ ok: true, claimed: true });
			});
			const completed = await json(await app.request(`/v1/platform/operations/${branchJob.operation.id}`, {
				headers: { authorization: `Bearer ${token}` },
			}));
			expect(completed.operation).toMatchObject({
				status: 'succeeded',
				branch: 'treeseed/branch-verified',
				output: {
					branch: 'treeseed/branch-verified',
					operationBranch: 'treeseed/branch-verified',
					verification: { status: 'passed' },
					pullRequest: null,
					workflowRun: null,
				},
			});
			expect(completed.operation.commitSha).toMatch(/^[a-f0-9]{40}$/u);
			expect(git(fixture.repo, ['branch', '--list', 'treeseed/branch-verified'])).toBe('');

			const failingJob = await json(await app.request('/v1/platform/operations', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					namespace: 'repository',
					operation: 'write_content_record',
					input: {
						projectId: 'runner-branch-project',
						collection: 'notes',
						payload: { title: 'Verification failing note' },
						repository: {
							provider: 'local',
							owner: 'treeseed',
							name: 'runner-failing-project',
							defaultBranch: 'staging',
							cloneUrl: fixture.repo,
							writeMode: 'branch',
							branchName: 'treeseed/failing-branch',
							verificationCommands: [{ command: process.execPath, args: ['-e', 'process.exit(9)'] }],
						},
					},
				}),
			}));
			await withHttpMarketApp(app, async (baseUrl) => {
				const client = new PlatformRunnerClient({
					marketUrl: baseUrl,
					marketId: 'local',
					runnerSecret: 'platform-runner-secret',
				});
				const result = await runOnceWithClient({
					runnerId: 'treeseed-ops-runner-02',
					environment: 'staging',
					dataDir: resolve(fixture.root, 'workspace-2'),
				}, client, 'test', { operationId: failingJob.operation.id });
				expect(result).toMatchObject({ ok: false, claimed: true });
			});
			const failed = await json(await app.request(`/v1/platform/operations/${failingJob.operation.id}`, {
				headers: { authorization: `Bearer ${token}` },
			}));
			expect(failed.operation).toMatchObject({
				status: 'failed',
				error: { message: expect.stringContaining('Repository verification failed') },
			});
			const events = await json(await app.request(`/v1/platform/operations/${failingJob.operation.id}/events`, {
				headers: { authorization: `Bearer ${token}` },
			}));
			expect(events.events.map((event: Record<string, unknown>) => event.kind)).toContain('repository.verification_failed');
			expect(git(fixture.repo, ['branch', '--list', 'treeseed/failing-branch'])).toBe('');
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it('stores project hosting topology and runner-authenticated agent pool registrations', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const { team, project } = await createTeamAndProject(app, token, {
			id: 'topology-project',
			slug: 'topology-project',
			name: 'Topology Project',
		});

		const hosting = await json(await app.request(`/v1/projects/${project.id}/hosting`, {
			method: 'PUT',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				kind: 'hosted_project',
				registration: 'optional',
				marketBaseUrl: 'https://market.example.com',
				sourceRepoOwner: 'treeseed-ai',
				sourceRepoName: 'topology-project',
				sourceRepoUrl: 'https://github.com/treeseed-ai/topology-project',
				sourceRepoWorkflowPath: '.github/workflows/deploy-web.yml',
			}),
		}));
		expect(hosting.payload).toMatchObject({
			projectId: project.id,
			kind: 'hosted_project',
			registration: 'optional',
		});
		const invalidHosting = await json(await app.request(`/v1/projects/${project.id}/hosting`, {
			method: 'PUT',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				kind: 'mystery_host',
			}),
		}));
		expect(invalidHosting.ok).toBe(false);
		expect(invalidHosting.error).toBe('Invalid hosting kind.');
		const advancedConnection = await json(await app.request(`/v1/projects/${project.id}/connection`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				mode: 'hybrid',
				executionOwner: 'project_runner',
				projectApiBaseUrl: '',
			}),
		}));
		expect(advancedConnection.payload.connection).toMatchObject({
			projectId: project.id,
			mode: 'hybrid',
			projectApiBaseUrl: null,
			executionOwner: 'project_runner',
		});
		const invalidConnection = await json(await app.request(`/v1/projects/${project.id}/connection`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				mode: 'chaos',
			}),
		}));
		expect(invalidConnection.ok).toBe(false);
		expect(invalidConnection.error).toBe('Invalid connection mode.');

		const environment = await json(await app.request(`/v1/projects/${project.id}/environments/staging`, {
			method: 'PUT',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				deploymentProfile: 'hosted_project',
				baseUrl: 'https://staging.example.com',
				cloudflareAccountId: 'cf-account-1',
				pagesProjectName: 'topology-project',
				workerName: 'topology-project-staging-worker',
				r2BucketName: 'topology-project-staging-content',
				d1DatabaseName: 'topology-project-staging-db',
				queueName: 'topology-project-staging-queue',
				railwayProjectName: 'topology-project',
			}),
		}));
		expect(environment.payload).toMatchObject({
			projectId: project.id,
			environment: 'staging',
			pagesProjectName: 'topology-project',
		});

		const resource = await json(await app.request(`/v1/projects/${project.id}/resources`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				environment: 'staging',
				provider: 'cloudflare',
				resourceKind: 'r2',
				logicalName: 'content',
				locator: 'teams/team-one/published/common.json',
			}),
		}));
		expect(resource.payload).toMatchObject({
			projectId: project.id,
			provider: 'cloudflare',
			resourceKind: 'r2',
			logicalName: 'content',
		});

		const pool = await json(await app.request(`/v1/projects/${project.id}/agent-pools`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				teamId: team.id,
				environment: 'staging',
				name: 'primary',
				status: 'active',
				autoscale: {
					minWorkers: 0,
					maxWorkers: 4,
					targetQueueDepth: 2,
					cooldownSeconds: 45,
				},
			}),
		}));
		expect(pool.payload).toMatchObject({
			projectId: project.id,
			name: 'primary',
			autoscale: {
				maxWorkers: 4,
				targetQueueDepth: 2,
			},
		});

		const connection = await json(await app.request(`/v1/projects/${project.id}/connection`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				mode: 'hosted',
				executionOwner: 'project_runner',
				rotateRunnerToken: true,
			}),
		}));
		const runnerToken = connection.payload.runnerToken as string;

		const registration = await json(await app.request(`/v1/projects/${project.id}/runner/agent-pools/primary/register`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${runnerToken}`,
			},
			body: JSON.stringify({
				teamId: team.id,
				environment: 'staging',
				managerId: 'manager-1',
				runnerId: 'runner-1',
				serviceName: 'manager',
				desiredWorkers: 2,
				observedQueueDepth: 3,
				observedActiveLeases: 1,
			}),
		}));
		expect(registration.payload.pool).toMatchObject({
			name: 'primary',
			environment: 'staging',
		});
		expect(registration.payload.registration).toMatchObject({
			managerId: 'manager-1',
			desiredWorkers: 2,
			observedQueueDepth: 3,
		});

		const runnerEnvironment = await json(await app.request(`/v1/projects/${project.id}/runner/environments/prod`, {
			method: 'PUT',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${runnerToken}`,
			},
			body: JSON.stringify({
				deploymentProfile: 'hosted_project',
				baseUrl: 'https://prod.example.com',
				pagesProjectName: 'topology-project',
				workerName: 'topology-project-prod-worker',
				r2BucketName: 'topology-project-prod-content',
				railwayProjectName: 'topology-project',
			}),
		}));
		expect(runnerEnvironment.payload).toMatchObject({
			environment: 'prod',
			pagesProjectName: 'topology-project',
		});

		const runnerResource = await json(await app.request(`/v1/projects/${project.id}/runner/resources`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${runnerToken}`,
			},
			body: JSON.stringify({
				environment: 'prod',
				provider: 'railway',
				resourceKind: 'service',
				logicalName: 'manager',
				locator: 'railway://topology-project-prod/manager',
			}),
		}));
		expect(runnerResource.payload).toMatchObject({
			environment: 'prod',
			provider: 'railway',
			resourceKind: 'service',
			logicalName: 'manager',
		});

		const runnerDeployment = await json(await app.request(`/v1/projects/${project.id}/runner/deployments`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${runnerToken}`,
			},
			body: JSON.stringify({
				environment: 'prod',
				deploymentKind: 'mixed',
				status: 'success',
				sourceRef: 'main',
				commitSha: 'def456',
			}),
		}));
		expect(runnerDeployment.payload).toMatchObject({
			environment: 'prod',
			deploymentKind: 'mixed',
			status: 'succeeded',
		});

		const details = await json(await app.request(`/v1/projects/${project.id}`, {
			headers: {
				authorization: `Bearer ${token}`,
			},
		}));
		expect(details.payload.hosting).toMatchObject({
			kind: 'hosted_project',
		});
		expect(details.payload.environments).toHaveLength(2);
		expect(details.payload.resources).toHaveLength(2);
		expect(details.payload.deployments).toHaveLength(1);
		expect(details.payload.agentPools).toHaveLength(1);
	});

	it('stores runner-reported scale decisions and workday summaries', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const { team, project } = await createTeamAndProject(app, token, {
			id: 'manager-project',
			slug: 'manager-project',
			name: 'Manager Project',
		});

		await app.request(`/v1/projects/${project.id}/agent-pools`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				teamId: team.id,
				environment: 'staging',
				name: 'primary',
				status: 'active',
				autoscale: {
					minWorkers: 0,
					maxWorkers: 4,
					targetQueueDepth: 2,
					cooldownSeconds: 45,
				},
			}),
		});
		const connection = await json(await app.request(`/v1/projects/${project.id}/connection`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				mode: 'hosted',
				executionOwner: 'project_runner',
				rotateRunnerToken: true,
			}),
		}));
		const runnerToken = connection.payload.runnerToken as string;

		await app.request(`/v1/projects/${project.id}/runner/agent-pools/primary/register`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${runnerToken}`,
			},
			body: JSON.stringify({
				teamId: team.id,
				environment: 'staging',
				managerId: 'manager-1',
				serviceName: 'manager',
				desiredWorkers: 2,
				observedQueueDepth: 3,
				observedActiveLeases: 1,
			}),
		});

		const decision = await json(await app.request(`/v1/projects/${project.id}/runner/agent-pools/primary/scale-decisions`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${runnerToken}`,
			},
			body: JSON.stringify({
				environment: 'staging',
				poolName: 'primary',
				workDayId: 'workday-1',
				desiredWorkers: 2,
				observedQueueDepth: 3,
				observedActiveLeases: 1,
				reason: 'reconcile',
				metadata: {
					remainingCredits: 4,
				},
			}),
		}));
		expect(decision.payload).toMatchObject({
			projectId: project.id,
			environment: 'staging',
			desiredWorkers: 2,
			reason: 'reconcile',
		});

		const workday = await json(await app.request(`/v1/projects/${project.id}/runner/workdays`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${runnerToken}`,
			},
			body: JSON.stringify({
				environment: 'staging',
				workDayId: 'workday-1',
				kind: 'workday_summary',
				state: 'completed',
				startedAt: '2026-04-15T09:00:00.000Z',
				endedAt: '2026-04-15T17:00:00.000Z',
				summary: {
					totalTasks: 3,
					usedTaskCredits: 4,
					generatedAt: '2026-04-15T17:01:00.000Z',
					docsAutomation: {
						researchNoteCount: 1,
						knowledgeDraftCount: 1,
						optimizationReportCount: 1,
						docsMutationCount: 1,
						pendingApprovalCount: 0,
						verificationFailureCount: 0,
					},
					contentSnapshot: {
						relativePath: 'src/content/workdays/2026-04-15-workday-1.mdx',
						slug: 'workdays/2026-04-15/workday-1/report',
						reportVersion: '20260415T170100Z-test',
						title: 'TreeSeed Documentation Automation Workday - 2026-04-15',
						status: 'completed',
					},
				},
				metadata: {
					reportId: 'report:workday-1',
				},
			}),
		}));
		expect(workday.payload).toMatchObject({
			projectId: project.id,
			environment: 'staging',
			workDayId: 'workday-1',
			kind: 'workday_summary',
			state: 'completed',
		});

		const decisions = await json(await app.request(`/v1/projects/${project.id}/agent-pools/${decision.payload.poolId}/scale-decisions`, {
			headers: {
				authorization: `Bearer ${token}`,
			},
		}));
		expect(decisions.payload).toEqual(expect.arrayContaining([
			expect.objectContaining({
				desiredWorkers: 2,
				workDayId: 'workday-1',
			}),
		]));

		const workdays = await json(await app.request(`/v1/projects/${project.id}/workdays?environment=staging`, {
			headers: {
				authorization: `Bearer ${token}`,
			},
		}));
		expect(workdays.payload).toEqual(expect.arrayContaining([
			expect.objectContaining({
				workDayId: 'workday-1',
				kind: 'workday_summary',
				summary: expect.objectContaining({
					docsAutomation: expect.objectContaining({ docsMutationCount: 1 }),
					contentSnapshot: expect.objectContaining({ relativePath: 'src/content/workdays/2026-04-15-workday-1.mdx' }),
				}),
			}),
		]));

		const projectSummary = await json(await app.request(`/v1/projects/${project.id}/summary`, {
			headers: {
				authorization: `Bearer ${token}`,
			},
		}));
		expect(projectSummary.payload).toMatchObject({
			docsAutomation: {
				latestWorkdayReport: expect.objectContaining({
					workDayId: 'workday-1',
					reportId: 'report:workday-1',
					generatedArtifactCount: 4,
					pendingApprovalCount: 0,
					verificationFailureCount: 0,
				}),
			},
		});

		const inbox = await json(await app.request(`/v1/teams/${team.id}/inbox`, {
			headers: {
				authorization: `Bearer ${token}`,
			},
		}));
		expect(inbox.payload).toEqual(expect.arrayContaining([
			expect.objectContaining({
				kind: 'workday_summary',
				state: 'completed',
				href: expect.stringContaining('/app/projects/'),
				metadata: expect.objectContaining({
					workDayId: 'workday-1',
					reportId: 'report:workday-1',
					generatedArtifactCount: 4,
				}),
			}),
		]));
	});

	it('allows project runners to drive hosted workday task lifecycle and manager leases', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const { team, project } = await createTeamAndProject(app, token, {
			id: 'hosted-runtime-project',
			slug: 'hosted-runtime-project',
			name: 'Hosted Runtime Project',
		});
		const provider = await json(await app.request(`/v1/teams/${team.id}/capacity-providers`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				name: 'Hosted Runtime Capacity',
				launchMode: 'self_hosted',
			}),
		}));
		const capacityProvider = provider.provider;
		const connection = await json(await app.request(`/v1/projects/${project.id}/connection`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				mode: 'hosted',
				executionOwner: 'project_runner',
				rotateRunnerToken: true,
			}),
		}));
		const runnerToken = connection.payload.runnerToken as string;

		const unauthenticated = await app.request(`/v1/projects/${project.id}/runner/tasks`);
		expect(unauthenticated.status).toBe(401);

		const workday = await json(await app.request(`/v1/projects/${project.id}/runner/workdays/start`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${runnerToken}`,
			},
			body: JSON.stringify({
				id: 'hosted-workday-1',
				capacityBudget: 25,
				summary: { runtimeMode: 'hosted' },
			}),
		}));
		expect(workday.payload).toMatchObject({
			id: 'hosted-workday-1',
			projectId: project.id,
			state: 'active',
		});

		const lease = await json(await app.request(`/v1/projects/${project.id}/runner/manager-leases/claim`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${runnerToken}`,
			},
			body: JSON.stringify({
				environment: 'staging',
				workDayId: 'hosted-workday-1',
				managerId: 'manager-hosted',
				ttlSeconds: 60,
				now: '2026-05-14T12:00:00.000Z',
				metadata: { runtimeMode: 'hosted' },
			}),
		}));
		expect(lease.payload).toMatchObject({
			managerId: 'manager-hosted',
			state: 'active',
		});

		const task = await json(await app.request(`/v1/projects/${project.id}/runner/tasks`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${runnerToken}`,
			},
			body: JSON.stringify({
				workDayId: 'hosted-workday-1',
				agentId: 'system',
				type: 'refresh_project_graph',
				idempotencyKey: 'hosted-workday-1:refresh_project_graph',
				payload: { projectId: project.id },
				actor: 'manager',
			}),
		}));
		expect(task.payload).toMatchObject({
			workDayId: 'hosted-workday-1',
			type: 'refresh_project_graph',
			state: 'pending',
		});

		const claimed = await json(await app.request(`/v1/projects/${project.id}/runner/tasks/${task.payload.id}/claim`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${runnerToken}`,
			},
			body: JSON.stringify({
				workerId: 'worker-hosted',
				leaseSeconds: 300,
				actor: 'worker',
			}),
		}));
		expect(claimed.payload).toMatchObject({
			state: 'claimed',
			claimedBy: 'worker-hosted',
		});

		await json(await app.request(`/v1/projects/${project.id}/runner/tasks/${task.payload.id}/events`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${runnerToken}`,
			},
			body: JSON.stringify({
				kind: 'worker_started',
				data: { workerId: 'worker-hosted' },
				actor: 'worker',
			}),
		}));
		const artifactBody = {
			artifactKind: 'codebase_inventory',
			codebaseInventory: {
				kind: 'codebase_inventory',
				generatedAt: '2026-05-14T12:00:00.000Z',
				packages: [],
				modules: [],
				knowledgeGaps: [],
			},
			generatedArtifacts: [{
				artifactKind: 'codebase_inventory',
				id: 'inventory-1',
				title: 'Hosted inventory',
				taskId: task.payload.id,
				sourceRefs: ['packages/agent/src/index.ts'],
			}],
			summary: {
				status: 'completed',
				summary: 'Hosted inventory completed.',
			},
		};
		const artifactUpload = await json(await app.request(`/v1/projects/${project.id}/runner/artifacts`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${runnerToken}`,
			},
			body: JSON.stringify({
				objectKey: 'agent-artifacts/hosted-workday-1/inventory.json',
				content: JSON.stringify(artifactBody),
				contentType: 'application/json',
			}),
		}));
		expect(artifactUpload.payload).toMatchObject({
			artifactStorage: 'r2',
			outputRef: 'r2:agent-artifacts/hosted-workday-1/inventory.json',
		});
		const completed = await json(await app.request(`/v1/projects/${project.id}/runner/tasks/${task.payload.id}/complete`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${runnerToken}`,
			},
			body: JSON.stringify({
				output: {
					artifactKind: 'codebase_inventory',
					artifactStorage: 'r2',
					outputRef: artifactUpload.payload.outputRef,
					objectKey: artifactUpload.payload.objectKey,
					sizeBytes: artifactUpload.payload.sizeBytes,
					sha256: artifactUpload.payload.sha256,
				},
				outputRef: artifactUpload.payload.outputRef,
				summary: { status: 'done' },
				actor: 'worker',
			}),
		}));
		expect(completed.payload).toMatchObject({ state: 'completed' });

		const outputs = await json(await app.request(`/v1/projects/${project.id}/runner/tasks/${task.payload.id}/outputs`, {
			headers: { authorization: `Bearer ${runnerToken}` },
		}));
		expect(outputs.payload).toEqual([
			expect.objectContaining({
				taskId: task.payload.id,
				outputRef: 'r2:agent-artifacts/hosted-workday-1/inventory.json',
				outputJson: expect.stringContaining('Hosted inventory completed'),
			}),
		]);

		const publicWorkdays = await json(await app.request(`/v1/projects/${project.id}/workdays`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(Array.isArray(publicWorkdays.payload)).toBe(true);

		const publicWorkdayDetail = await json(await app.request(`/v1/projects/${project.id}/workdays/hosted-workday-1`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(publicWorkdayDetail.payload).toMatchObject({ id: 'hosted-workday-1' });

		const publicTasks = await json(await app.request(`/v1/projects/${project.id}/tasks`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(publicTasks.payload).toEqual([expect.objectContaining({ id: task.payload.id })]);

		const publicTask = await json(await app.request(`/v1/projects/${project.id}/tasks/${task.payload.id}`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(publicTask.payload).toMatchObject({ id: task.payload.id });

		const publicTaskEvents = await json(await app.request(`/v1/projects/${project.id}/tasks/${task.payload.id}/events`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(publicTaskEvents.payload).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'worker_started' })]));

		const publicArtifacts = await json(await app.request(`/v1/projects/${project.id}/agent-artifacts`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(publicArtifacts.payload.items).toEqual([expect.objectContaining({ id: 'inventory-1', artifactKind: 'codebase_inventory' })]);

		const publicArtifactDetail = await json(await app.request(`/v1/projects/${project.id}/agent-artifacts/inventory-1`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(publicArtifactDetail.payload.artifact).toMatchObject({ id: 'inventory-1' });

		const publicArtifactDiff = await json(await app.request(`/v1/projects/${project.id}/agent-artifacts/inventory-1/diff`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(publicArtifactDiff.payload).toMatchObject({ artifactId: 'inventory-1', changedPaths: [] });

		const approval = await json(await app.request(`/v1/projects/${project.id}/runner/approval-requests`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${runnerToken}`,
			},
			body: JSON.stringify({
				id: 'hosted-approval-1',
				workDayId: 'hosted-workday-1',
				taskId: task.payload.id,
				kind: 'promote_knowledge_draft',
				title: 'Promote hosted docs',
				summary: 'Hosted docs promotion needs approval.',
				metadata: { runtimeMode: 'hosted' },
			}),
		}));
		expect(approval.payload).toMatchObject({
			id: 'hosted-approval-1',
			projectId: project.id,
			teamId: team.id,
			state: 'pending',
		});

		const usage = await json(await app.request(`/v1/projects/${project.id}/runner/capacity/usage`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${runnerToken}`,
			},
			body: JSON.stringify({
				capacityProviderId: capacityProvider.id,
				workDayId: 'hosted-workday-1',
				taskId: task.payload.id,
				phase: 'consume',
				credits: 2,
				source: 'hosted_agent_runtime',
			}),
		}));
		expect(usage.payload.entry).toMatchObject({
			capacityProviderId: capacityProvider.id,
			projectId: project.id,
			credits: 2,
		});

		const listed = await json(await app.request(`/v1/projects/${project.id}/runner/tasks?workDayId=hosted-workday-1`, {
			headers: { authorization: `Bearer ${runnerToken}` },
		}));
		expect(listed.payload).toEqual([
			expect.objectContaining({
				id: task.payload.id,
				state: 'completed',
			}),
		]);
	});

	it('stores hosted project work policies, priority snapshots, and task-credit ledger entries', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const { project } = await createTeamAndProject(app, token, {
			id: 'planning-project',
			slug: 'planning-project',
			name: 'Planning Project',
		});

		const workPolicy = await json(await app.request(`/v1/projects/${project.id}/work-policy`, {
			method: 'PUT',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				environment: 'staging',
				schedule: {
					timezone: 'America/New_York',
					windows: [{ days: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00' }],
				},
				dailyTaskCreditBudget: 12,
				maxQueuedTasks: 4,
				maxQueuedCredits: 8,
				autoscale: {
					minWorkers: 0,
					maxWorkers: 3,
					targetQueueDepth: 2,
					cooldownSeconds: 60,
				},
				creditWeights: [{
					type: 'question',
					credits: 3,
				}],
				metadata: {
					managedBy: 'market',
				},
			}),
		}));
		expect(workPolicy.payload).toMatchObject({
			projectId: project.id,
			environment: 'staging',
			dailyTaskCreditBudget: 12,
			maxQueuedTasks: 4,
		});

		const priorityOverride = await json(await app.request(`/v1/projects/${project.id}/priority-overrides`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				model: 'question',
				subjectId: 'question-1',
				priority: 42,
				estimatedCredits: 3,
				metadata: {
					reason: 'customer-escalation',
				},
			}),
		}));
		expect(priorityOverride.payload).toMatchObject({
			projectId: project.id,
			model: 'question',
			subjectId: 'question-1',
			priority: 42,
		});

		const connection = await json(await app.request(`/v1/projects/${project.id}/connection`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				mode: 'hosted',
				executionOwner: 'project_runner',
				rotateRunnerToken: true,
			}),
		}));
		const runnerToken = connection.payload.runnerToken as string;

		const snapshot = await json(await app.request(`/v1/projects/${project.id}/runner/priority-snapshots`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${runnerToken}`,
			},
			body: JSON.stringify({
				workDayId: 'workday-2',
				generatedAt: '2026-04-15T13:00:00.000Z',
				snapshot: {
					items: [{
						id: 'question-1',
						model: 'question',
						priority: 42,
						title: 'Critical question',
					}],
				},
				metadata: {
					source: 'manager',
				},
			}),
		}));
		expect(snapshot.payload).toMatchObject({
			projectId: project.id,
			workDayId: 'workday-2',
		});

		const taskCredit = await json(await app.request(`/v1/projects/${project.id}/runner/task-credits`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${runnerToken}`,
			},
			body: JSON.stringify({
				workDayId: 'workday-2',
				taskId: 'task-1',
				phase: 'seeded',
				credits: 3,
				metadata: {
					reason: 'queued',
				},
			}),
		}));
		expect(taskCredit.payload).toMatchObject({
			projectId: project.id,
			workDayId: 'workday-2',
			taskId: 'task-1',
			phase: 'seeded',
			credits: 3,
		});

		const listedPolicy = await json(await app.request(`/v1/projects/${project.id}/work-policy?environment=staging`, {
			headers: {
				authorization: `Bearer ${token}`,
			},
		}));
		expect(listedPolicy.payload).toMatchObject({
			environment: 'staging',
			dailyTaskCreditBudget: 12,
		});

		const listedOverrides = await json(await app.request(`/v1/projects/${project.id}/priority-overrides`, {
			headers: {
				authorization: `Bearer ${token}`,
			},
		}));
		expect(listedOverrides.payload).toEqual(expect.arrayContaining([
			expect.objectContaining({
				subjectId: 'question-1',
				priority: 42,
			}),
		]));

		const listedSnapshots = await json(await app.request(`/v1/projects/${project.id}/priority-snapshots?workDayId=workday-2`, {
			headers: {
				authorization: `Bearer ${token}`,
			},
		}));
		expect(listedSnapshots.payload).toEqual(expect.arrayContaining([
			expect.objectContaining({
				workDayId: 'workday-2',
			}),
		]));

		const listedCredits = await json(await app.request(`/v1/projects/${project.id}/workdays/workday-2/task-credits`, {
			headers: {
				authorization: `Bearer ${token}`,
			},
		}));
		expect(listedCredits.payload).toEqual(expect.arrayContaining([
			expect.objectContaining({
				workDayId: 'workday-2',
				taskId: 'task-1',
				credits: 3,
			}),
		]));
	});

	it('blocks dispatch when a project capability grant is disabled', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const { project } = await createTeamAndProject(app, token, {
			id: 'disabled-project',
			slug: 'disabled-project',
			name: 'Disabled Project',
		});

		await app.request(`/v1/projects/${project.id}/capabilities`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				grants: [{
					namespace: 'sdk',
					operation: 'refreshGraph',
					executionClass: 'remote_job',
					allowedTargets: ['project_runner'],
					defaultDispatchMode: 'prefer_remote',
					enabled: false,
				}],
			}),
		});

		const dispatched = await app.request(`/v1/projects/${project.id}/dispatch`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				namespace: 'sdk',
				operation: 'refreshGraph',
				input: {},
			}),
		});

		expect(dispatched.status).toBe(403);
		expect(await json(dispatched)).toMatchObject({
			ok: false,
			error: 'Dispatch capability disabled for project.',
		});
	});

	it('indexes team-owned catalog items and artifact versions centrally', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const { team } = await createTeamAndProject(app, token, {
			id: 'catalog-project',
			slug: 'catalog-project',
			name: 'Catalog Project',
			description: 'Central catalog seed',
			metadata: { listingEnabled: true, manifestKey: 'teams/team-one/published/common.json' },
		});

		const catalogItem = await json(await app.request(`/v1/teams/${team.id}/catalog-items`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				kind: 'template',
				slug: 'starter-pro',
				title: 'Starter Pro',
				summary: 'A team-owned starter template.',
				visibility: 'public',
				listingEnabled: true,
				offerMode: 'subscription_updates',
				artifactKey: 'teams/team-one/artifacts/template/starter-pro-v1.zip',
			}),
		}));

		const artifact = await json(await app.request(`/v1/catalog/${catalogItem.payload.id}/artifacts`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				kind: 'template_artifact',
				version: '1.0.0',
				contentKey: 'teams/team-one/artifacts/template/starter-pro-v1.zip',
			}),
		}));

		const listed = await json(await app.request('/v1/catalog?kind=template'));
		expect(listed.payload[0]).toMatchObject({
			kind: 'template',
			slug: 'starter-pro',
			offerMode: 'subscription_updates',
			listingEnabled: true,
		});

		const versions = await json(await app.request(`/v1/catalog/${catalogItem.payload.id}/artifacts`));
		expect(versions.payload[0]).toMatchObject({
			version: '1.0.0',
			contentKey: 'teams/team-one/artifacts/template/starter-pro-v1.zip',
		});
		expect(artifact.payload.version).toBe('1.0.0');
	});

	it('manages phase 2 commerce cooperative governance vendors, products, offers, prices, catalog sync, and commerce marketplace catalog', async () => {
		const app = createTestApp();
		const seeded = await json(await app.request('/v1/acceptance/seed', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-treeseed-service-id': 'web',
				'x-treeseed-service-secret': 'web-test-secret',
			},
			body: JSON.stringify({ namespace: 'commerce-phase-2' }),
		}));
		const team = seeded.payload.fixtures.team;
		const ownerToken = seeded.payload.actors.teamOwner.accessToken;
		const adminToken = seeded.payload.actors.marketSteward.accessToken;

		const vendor = await json(await app.request(`/v1/commerce/vendors/${team.id}/request`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({
				displayName: 'Cooperative Commerce Team',
				slug: 'cooperative-commerce-team',
				reason: 'Request marketplace seller capability.',
			}),
		}));
		expect(vendor.payload).toMatchObject({
			teamId: team.id,
			status: 'submitted',
			trustLevel: 'public_publisher',
			salesEnabled: false,
		});

		const deniedApproval = await app.request(`/v1/commerce/vendors/${vendor.payload.id}/approve`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({ trustLevel: 'verified_seller' }),
		});
		expect(deniedApproval.status).toBe(403);

		const approvedVendor = await json(await app.request(`/v1/commerce/vendors/${vendor.payload.id}/approve`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${adminToken}`,
			},
			body: JSON.stringify({
				trustLevel: 'verified_seller',
				salesEnabled: true,
				reason: 'Seller governance review passed.',
			}),
		}));
		expect(approvedVendor.payload).toMatchObject({
			status: 'approved',
			trustLevel: 'verified_seller',
			salesEnabled: true,
		});

		const product = await json(await app.request('/v1/commerce/products', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({
				sellerTeamId: team.id,
				kind: 'template',
				slug: 'cooperative-starter',
				title: 'Cooperative Starter',
				summary: 'A starter product with cooperative ownership.',
				visibility: 'public',
				ownershipModel: 'cooperative_owned',
				ownership: {
					model: 'cooperative_owned',
					canonicalOwnerType: 'cooperative',
					canonicalOwnerId: 'coop-commerce-phase-2',
					publicSummary: 'Owned by the cooperative contributor group.',
				},
				metadata: { cooperativeGovernance: true },
			}),
		}));
		expect(product.payload).toMatchObject({
			sellerTeamId: team.id,
			status: 'draft',
			visibility: 'public',
			ownershipModel: 'cooperative_owned',
		});

		const ownership = await json(await app.request(`/v1/commerce/products/${product.payload.id}/ownership`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(ownership.payload[0]).toMatchObject({
			model: 'cooperative_owned',
			buyerVisible: true,
		});

		const steward = await json(await app.request(`/v1/commerce/products/${product.payload.id}/stewards`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({
				role: 'governance_steward',
				assigneeType: 'team',
				assigneeId: team.id,
				responsibilities: ['review product changes', 'maintain cooperative policy'],
			}),
		}));
		expect(steward.payload).toMatchObject({
			role: 'governance_steward',
			visibleToBuyers: true,
		});

		const contribution = await json(await app.request(`/v1/commerce/products/${product.payload.id}/contributions`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({
				contributorType: 'team',
				contributorId: team.id,
				role: 'knowledge_curator',
				summary: 'Prepared the starter project knowledge.',
				benefitWeight: 0.6,
			}),
		}));
		expect(contribution.payload).toMatchObject({
			role: 'knowledge_curator',
			benefitWeight: 0.6,
		});
		expect(contribution.payload).not.toHaveProperty('payoutAccountId');

		const policy = await json(await app.request(`/v1/commerce/products/${product.payload.id}/governance-policy`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({
				policyKind: 'cooperative',
				title: 'Cooperative Listing Policy',
				approvalRules: { productApproval: 'market_steward' },
				quorumRules: { contributorConsent: 'majority' },
				buyerVisibleSummary: 'Material changes require cooperative review.',
				status: 'active',
			}),
		}));
		expect(policy.payload).toMatchObject({
			policyKind: 'cooperative',
			status: 'active',
		});

		const updatedOwnership = await json(await app.request(`/v1/commerce/products/${product.payload.id}/ownership/${ownership.payload[0].id}`, {
			method: 'PATCH',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({
				publicSummary: 'Updated buyer-visible cooperative ownership.',
				buyerVisible: true,
				reason: 'Clarify ownership summary.',
			}),
		}));
		expect(updatedOwnership.payload).toMatchObject({
			publicSummary: 'Updated buyer-visible cooperative ownership.',
			buyerVisible: true,
		});

		const updatedSteward = await json(await app.request(`/v1/commerce/products/${product.payload.id}/stewards/${steward.payload.id}`, {
			method: 'PATCH',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({
				displayName: 'Cooperative Governance Steward',
				responsibilities: ['review product changes', 'maintain cooperative policy', 'publish buyer-visible governance'],
				visibleToBuyers: true,
				reason: 'Clarify stewardship.',
			}),
		}));
		expect(updatedSteward.payload).toMatchObject({
			displayName: 'Cooperative Governance Steward',
			visibleToBuyers: true,
		});

		const endedSteward = await json(await app.request(`/v1/commerce/products/${product.payload.id}/stewards/${steward.payload.id}/end`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({ reason: 'Rotate steward assignment.' }),
		}));
		expect(endedSteward.payload.endsAt).toEqual(expect.any(String));

		const updatedContribution = await json(await app.request(`/v1/commerce/products/${product.payload.id}/contributions/${contribution.payload.id}`, {
			method: 'PATCH',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({
				summary: 'Updated private contribution note.',
				attributionVisibility: 'private',
				benefitWeight: 0.75,
				reason: 'Contributor requested private attribution.',
			}),
		}));
		expect(updatedContribution.payload).toMatchObject({
			attributionVisibility: 'private',
			benefitWeight: 0.75,
		});
		expect(updatedContribution.payload).not.toHaveProperty('payoutAccountId');
		expect(updatedContribution.payload).not.toHaveProperty('revenueShare');

		const updatedPolicy = await json(await app.request(`/v1/commerce/products/${product.payload.id}/governance-policy/${policy.payload.id}`, {
			method: 'PATCH',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({
				title: 'Updated Cooperative Listing Policy',
				buyerVisibleSummary: 'Updated material changes require cooperative review.',
				status: 'active',
				reason: 'Policy summary update.',
			}),
		}));
		expect(updatedPolicy.payload).toMatchObject({
			title: 'Updated Cooperative Listing Policy',
			buyerVisibleSummary: 'Updated material changes require cooperative review.',
		});

		const secondOwnership = await json(await app.request(`/v1/commerce/products/${product.payload.id}/ownership`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({
				model: 'community_governed',
				canonicalOwnerType: 'community',
				canonicalOwnerId: 'community-commerce-phase-2',
				publicSummary: 'Community governed successor ownership.',
			}),
		}));
		const productWithSecondOwnership = await json(await app.request(`/v1/commerce/products/${product.payload.id}`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(productWithSecondOwnership.payload.ownershipRecordId).toBe(secondOwnership.payload.id);

		const transfer = await json(await app.request(`/v1/commerce/products/${product.payload.id}/ownership-transfer`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({
				fromOwnershipRecordId: secondOwnership.payload.id,
				toOwnershipRecordId: ownership.payload[0].id,
				reason: 'Return ownership to the cooperative.',
				approvalEvidence: { proposal: 'phase-7-transfer' },
			}),
		}));
		expect(transfer.payload).toMatchObject({
			status: 'draft',
			fromOwnershipRecordId: secondOwnership.payload.id,
			toOwnershipRecordId: ownership.payload[0].id,
		});
		const productBeforeTransferApproval = await json(await app.request(`/v1/commerce/products/${product.payload.id}`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(productBeforeTransferApproval.payload.ownershipRecordId).toBe(secondOwnership.payload.id);

		await app.request(`/v1/commerce/products/${product.payload.id}/ownership-transfer/${transfer.payload.id}/submit`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({ reason: 'Ready for transfer decision.' }),
		});
		const approvedTransfer = await json(await app.request(`/v1/commerce/products/${product.payload.id}/ownership-transfer/${transfer.payload.id}/approve`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({ reason: 'Approved by cooperative steward.' }),
		}));
		expect(approvedTransfer.payload.status).toBe('approved');
		const productAfterTransferApproval = await json(await app.request(`/v1/commerce/products/${product.payload.id}`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(productAfterTransferApproval.payload.ownershipRecordId).toBe(ownership.payload[0].id);

		const rejectedTransfer = await json(await app.request(`/v1/commerce/products/${product.payload.id}/ownership-transfer`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({
				fromOwnershipRecordId: ownership.payload[0].id,
				toOwnershipRecordId: secondOwnership.payload.id,
				status: 'submitted',
				reason: 'Rejected transfer exercise.',
			}),
		}));
		await app.request(`/v1/commerce/products/${product.payload.id}/ownership-transfer/${rejectedTransfer.payload.id}/reject`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({ reason: 'Rejected by steward.' }),
		});
		const productAfterRejectedTransfer = await json(await app.request(`/v1/commerce/products/${product.payload.id}`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(productAfterRejectedTransfer.payload.ownershipRecordId).toBe(ownership.payload[0].id);

		const succession = await json(await app.request(`/v1/commerce/products/${product.payload.id}/succession-events`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({
				successorType: 'team',
				successorId: team.id,
				eventType: 'successor_named',
				reason: 'Name team as successor steward.',
			}),
		}));
		expect(succession.payload).toMatchObject({
			eventType: 'successor_named',
			status: 'submitted',
		});
		const workflow = await json(await app.request(`/v1/commerce/products/${product.payload.id}/ownership-workflow`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(workflow.payload).toMatchObject({
			productId: product.payload.id,
			currentOwnershipRecord: expect.objectContaining({ id: ownership.payload[0].id }),
		});
		expect(workflow.payload.successionEvents).toContainEqual(expect.objectContaining({ id: succession.payload.id }));

		const submittedProduct = await json(await app.request(`/v1/commerce/products/${product.payload.id}/submit`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({ reason: 'Ready for marketplace review.' }),
		}));
		expect(submittedProduct.payload.status).toBe('submitted');

		const approvedProduct = await json(await app.request(`/v1/commerce/products/${product.payload.id}/approve`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${adminToken}`,
			},
			body: JSON.stringify({ reason: 'Approved for catalog listing.' }),
		}));
		expect(approvedProduct.payload).toMatchObject({
			status: 'approved',
			catalogItemId: expect.any(String),
		});

		const publicWorkflow = await json(await app.request(`/v1/commerce/products/${product.payload.id}/ownership-workflow`));
		expect(publicWorkflow.payload.currentOwnershipRecord).toMatchObject({
			id: ownership.payload[0].id,
			buyerVisible: true,
		});
		expect(publicWorkflow.payload.contributions).not.toContainEqual(expect.objectContaining({
			id: contribution.payload.id,
			attributionVisibility: 'private',
		}));
		expect(publicWorkflow.payload.pendingTransfers).toEqual([]);
		expect(publicWorkflow.payload.successionEvents).toEqual([]);

		const listedProducts = await json(await app.request('/v1/commerce/products?kind=template'));
		expect(listedProducts.payload).toContainEqual(expect.objectContaining({
			id: product.payload.id,
			status: 'approved',
		}));

		const version = await json(await app.request(`/v1/commerce/products/${product.payload.id}/versions`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({
				version: '1.0.0',
				artifactKey: 'teams/commerce-phase-2/artifacts/cooperative-starter-v1.zip',
				manifestKey: 'teams/commerce-phase-2/manifests/cooperative-starter-v1.json',
				integrity: 'sha256:test',
			}),
		}));
		await app.request(`/v1/commerce/products/${product.payload.id}/versions/${version.payload.id}/submit`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({ reason: 'Version ready.' }),
		});
		const approvedVersion = await json(await app.request(`/v1/commerce/products/${product.payload.id}/versions/${version.payload.id}/approve`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${adminToken}`,
			},
			body: JSON.stringify({ reason: 'Version approved.' }),
		}));
		expect(approvedVersion.payload).toMatchObject({
			status: 'approved',
			catalogArtifactVersionId: expect.any(String),
		});

		const invalidOffer = await app.request('/v1/commerce/offers', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({
				productId: product.payload.id,
				mode: 'paid',
				title: 'Legacy Paid Offer',
			}),
		});
		expect(invalidOffer.status).toBe(400);

		const offer = await json(await app.request('/v1/commerce/offers', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({
				productId: product.payload.id,
				productVersionId: version.payload.id,
				mode: 'subscription_updates',
				title: 'Cooperative Starter Updates',
				termsSummary: 'Subscribers receive updates while active.',
			}),
		}));
		expect(offer.payload).toMatchObject({
			mode: 'subscription_updates',
			status: 'draft',
		});
		expect(offer.payload).not.toHaveProperty('checkoutUrl');

		const price = await json(await app.request(`/v1/commerce/offers/${offer.payload.id}/prices`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({
				amount: 2900,
				currency: 'usd',
				billingInterval: 'month',
			}),
		}));
		expect(price.payload).toMatchObject({
			amount: 2900,
			priceVersion: 1,
			status: 'draft',
			stripePriceId: null,
		});

		const activatedPrice = await json(await app.request(`/v1/commerce/prices/${price.payload.id}/activate`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({ reason: 'Initial active display price.' }),
		}));
		expect(activatedPrice.payload).toMatchObject({
			status: 'active',
			priceVersion: 1,
		});

		const nextPrice = await json(await app.request(`/v1/commerce/offers/${offer.payload.id}/prices`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({
				amount: 3900,
				currency: 'usd',
				billingInterval: 'month',
			}),
		}));
		expect(nextPrice.payload).toMatchObject({
			amount: 3900,
			priceVersion: 2,
		});

		await app.request(`/v1/commerce/offers/${offer.payload.id}/submit`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({ reason: 'Offer ready.' }),
		});
		const approvedOffer = await json(await app.request(`/v1/commerce/offers/${offer.payload.id}/approve`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${adminToken}`,
			},
			body: JSON.stringify({ reason: 'Offer approved.' }),
		}));
		expect(approvedOffer.payload).toMatchObject({
			status: 'approved',
			mode: 'subscription_updates',
		});

		const catalog = await json(await app.request('/v1/catalog?kind=template'));
		expect(catalog.payload).toContainEqual(expect.objectContaining({
			id: approvedProduct.payload.catalogItemId,
			slug: 'cooperative-starter',
			offerMode: 'subscription_updates',
			metadata: expect.objectContaining({
				commerceProductId: product.payload.id,
				ownershipModel: 'cooperative_owned',
			}),
		}));

		const marketplace = await json(await app.request('/v1/commerce/marketplace'));
		expect(marketplace.payload.products).toContainEqual(expect.objectContaining({
			id: product.payload.id,
			title: 'Cooperative Starter',
			vendorId: vendor.payload.id,
			sellerTeamId: team.id,
			ownershipModel: 'cooperative_owned',
			buyerVisibleOwnershipSummary: 'Updated buyer-visible cooperative ownership.',
			offers: expect.arrayContaining([
				expect.objectContaining({
					id: offer.payload.id,
					mode: 'subscription_updates',
					title: 'Cooperative Starter Updates',
					priceId: activatedPrice.payload.id,
					unitAmount: 2900,
					currency: 'usd',
				}),
			]),
		}));
		expect(JSON.stringify(marketplace.payload)).not.toContain('approvalEvidence');
		expect(JSON.stringify(marketplace.payload)).not.toContain('Updated private contribution note.');

		const marketplaceProduct = await json(await app.request(`/v1/commerce/marketplace/products/${product.payload.id}`));
		expect(marketplaceProduct.payload).toMatchObject({
			id: product.payload.id,
			serviceRequestEligible: false,
			checkoutEligible: true,
			capacityListingId: null,
		});
		expect(marketplaceProduct.payload.stewardshipSummary).toEqual(expect.arrayContaining([
			expect.objectContaining({ role: 'governance_steward' }),
		]));

		const artifacts = await json(await app.request(`/v1/catalog/${approvedProduct.payload.catalogItemId}/artifacts`));
		expect(artifacts.payload).toContainEqual(expect.objectContaining({
			version: '1.0.0',
			contentKey: 'teams/commerce-phase-2/artifacts/cooperative-starter-v1.zip',
		}));

		const events = await json(await app.request(`/v1/commerce/governance-events?teamId=${team.id}`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(events.payload).toEqual(expect.arrayContaining([
			expect.objectContaining({ action: 'vendor.request', nextState: 'submitted' }),
			expect.objectContaining({ action: 'product.approve', nextState: 'approved' }),
			expect.objectContaining({ action: 'offer.approve', nextState: 'approved' }),
		]));
	}, 30_000);

	it('manages phase 3 commerce stripe connect onboarding for approved vendors', async () => {
		const calls: string[] = [];
		const stripeAccounts = new Map<string, any>();
		const fakeStripeConnectService = {
			environment: 'test',
			async isConfigured() {
				return true;
			},
			async createExpressAccount({ vendor }: any) {
				calls.push('createExpressAccount');
				const account = {
					id: `acct_${vendor.id}`,
					charges_enabled: false,
					payouts_enabled: false,
					details_submitted: false,
					requirements: {
						currently_due: ['business_profile.url'],
						eventually_due: ['external_account'],
						past_due: [],
						disabled_reason: null,
					},
					capabilities: {
						card_payments: 'pending',
						transfers: 'pending',
					},
				};
				stripeAccounts.set(account.id, account);
				return account;
			},
			async createOnboardingLink({ stripeAccountId }: any) {
				calls.push(`createOnboardingLink:${stripeAccountId}`);
				return { url: `https://connect.stripe.test/onboarding/${stripeAccountId}` };
			},
			async retrieveAccount(stripeAccountId: string) {
				calls.push(`retrieveAccount:${stripeAccountId}`);
				return stripeAccounts.get(stripeAccountId);
			},
			async createLoginLink(stripeAccountId: string) {
				calls.push(`createLoginLink:${stripeAccountId}`);
				return { url: `https://connect.stripe.test/dashboard/${stripeAccountId}` };
			},
		};
		const app = createTestApp({ stripeConnectService: fakeStripeConnectService });
		const seeded = await json(await app.request('/v1/acceptance/seed', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-treeseed-service-id': 'web',
				'x-treeseed-service-secret': 'web-test-secret',
			},
			body: JSON.stringify({ namespace: 'commerce-phase-3' }),
		}));
		const team = seeded.payload.fixtures.team;
		const ownerToken = seeded.payload.actors.teamOwner.accessToken;
		const viewerToken = seeded.payload.actors.teamViewer.accessToken;
		const adminToken = seeded.payload.actors.marketSteward.accessToken;

		const emptyStatus = await json(await app.request(`/v1/commerce/vendors/${team.id}/stripe/status`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(emptyStatus.payload).toBeNull();

		const vendor = await json(await app.request(`/v1/commerce/vendors/${team.id}/request`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({
				displayName: 'Stripe Cooperative Vendor',
				slug: 'stripe-cooperative-vendor',
			}),
		}));

		const unapprovedOnboarding = await app.request(`/v1/commerce/vendors/${team.id}/stripe/onboarding`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({}),
		});
		expect(unapprovedOnboarding.status).toBe(409);
		expect(calls).not.toContain('createExpressAccount');

		const deniedManager = await app.request(`/v1/commerce/vendors/${team.id}/stripe/onboarding`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${viewerToken}`,
			},
			body: JSON.stringify({}),
		});
		expect(deniedManager.status).toBe(403);

		await app.request(`/v1/commerce/vendors/${vendor.payload.id}/approve`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${adminToken}`,
			},
			body: JSON.stringify({
				trustLevel: 'verified_seller',
				salesEnabled: true,
				reason: 'Approved for seller onboarding.',
			}),
		});

		const onboarding = await json(await app.request(`/v1/commerce/vendors/${team.id}/stripe/onboarding`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({}),
		}));
		expect(onboarding.payload.onboardingUrl).toMatch(/^https:\/\/connect\.stripe\.test\/onboarding\/acct_/u);
		expect(onboarding.payload.account).toMatchObject({
			vendorId: vendor.payload.id,
			teamId: team.id,
			environment: 'test',
			accountStatus: 'restricted',
			onboardingStatus: 'started',
			chargesEnabled: false,
			payoutsEnabled: false,
			detailsSubmitted: false,
			requirementsCurrentlyDue: ['business_profile.url'],
			requirementsPastDue: [],
		});
		expect(JSON.stringify(onboarding.payload)).not.toContain('sk_test');

		const persistedVendor = await json(await app.request(`/v1/commerce/vendors/${team.id}`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(persistedVendor.payload.stripeAccountId).toBe(onboarding.payload.account.stripeAccountId);

		const returned = await json(await app.request(`/v1/commerce/vendors/${team.id}/stripe/return`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({}),
		}));
		expect(returned.payload).toMatchObject({
			onboardingStatus: 'returned',
			accountStatus: 'restricted',
		});

		const stripeAccountId = onboarding.payload.account.stripeAccountId;
		stripeAccounts.set(stripeAccountId, {
			id: stripeAccountId,
			charges_enabled: true,
			payouts_enabled: true,
			details_submitted: true,
			requirements: {
				currently_due: [],
				eventually_due: [],
				past_due: [],
				disabled_reason: null,
			},
			capabilities: {
				card_payments: 'active',
				transfers: 'active',
			},
		});

		const refreshed = await json(await app.request(`/v1/commerce/vendors/${team.id}/stripe/status?refresh=1`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(refreshed.payload).toMatchObject({
			accountStatus: 'enabled',
			onboardingStatus: 'completed',
			chargesEnabled: true,
			payoutsEnabled: true,
			detailsSubmitted: true,
			capabilities: {
				card_payments: 'active',
				transfers: 'active',
			},
		});

		const loginLink = await json(await app.request(`/v1/commerce/vendors/${team.id}/stripe/login-link`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({}),
		}));
		expect(loginLink.payload.loginUrl).toBe(`https://connect.stripe.test/dashboard/${stripeAccountId}`);

		const events = await json(await app.request(`/v1/commerce/governance-events?teamId=${team.id}`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(events.payload).toEqual(expect.arrayContaining([
			expect.objectContaining({ action: 'commerce_vendor.stripe_account.created' }),
			expect.objectContaining({ action: 'commerce_vendor.stripe_onboarding.started' }),
			expect.objectContaining({ action: 'commerce_vendor.stripe_onboarding.returned' }),
			expect.objectContaining({ action: 'commerce_vendor.stripe_status.synced' }),
			expect.objectContaining({ action: 'commerce_vendor.stripe_login_link.created' }),
		]));
		expect(JSON.stringify(events.payload)).not.toContain(loginLink.payload.loginUrl);
	}, 15_000);

	it('syncs phase 4 commerce stripe product and price mirrors for approved vendor offers', async () => {
		const calls: Array<{ name: string; input: any }> = [];
		const stripeAccounts = new Map<string, any>();
		const stripeProducts = new Map<string, any>();
		const stripePrices = new Map<string, any>();
		const fakeStripeConnectService = {
			environment: 'test',
			async isConfigured() {
				return true;
			},
			async createExpressAccount({ vendor }: any) {
				const account = {
					id: `acct_${vendor.id}`,
					charges_enabled: true,
					payouts_enabled: true,
					details_submitted: true,
					requirements: { currently_due: [], eventually_due: [], past_due: [], disabled_reason: null },
					capabilities: { card_payments: 'active', transfers: 'active' },
				};
				stripeAccounts.set(account.id, account);
				return account;
			},
			async createOnboardingLink({ stripeAccountId }: any) {
				return { url: `https://connect.stripe.test/onboarding/${stripeAccountId}` };
			},
			async retrieveAccount(stripeAccountId: string) {
				return stripeAccounts.get(stripeAccountId);
			},
			async createLoginLink(stripeAccountId: string) {
				return { url: `https://connect.stripe.test/dashboard/${stripeAccountId}` };
			},
			async createProductMirror(input: any) {
				calls.push({ name: 'createProductMirror', input });
				const product = {
					id: `prod_${stripeProducts.size + 1}`,
					...input.params,
				};
				stripeProducts.set(product.id, product);
				return product;
			},
			async updateProductMirror(input: any) {
				calls.push({ name: 'updateProductMirror', input });
				const existing = stripeProducts.get(input.stripeProductId) ?? { id: input.stripeProductId };
				const product = { ...existing, ...input.params };
				stripeProducts.set(product.id, product);
				return product;
			},
			async retrieveProductMirror({ stripeProductId }: any) {
				return stripeProducts.get(stripeProductId);
			},
			async createPriceMirror(input: any) {
				calls.push({ name: 'createPriceMirror', input });
				const price = {
					id: `price_${stripePrices.size + 1}`,
					unit_amount: input.params.unit_amount,
					currency: input.params.currency,
					recurring: input.params.recurring ?? null,
					lookup_key: input.params.lookup_key,
					metadata: input.params.metadata,
				};
				stripePrices.set(price.id, price);
				return price;
			},
			async updatePriceMirror(input: any) {
				calls.push({ name: 'updatePriceMirror', input });
				const existing = stripePrices.get(input.stripePriceId) ?? { id: input.stripePriceId };
				const price = { ...existing, ...input.params };
				stripePrices.set(price.id, price);
				return price;
			},
			async retrievePriceMirror({ stripePriceId }: any) {
				return stripePrices.get(stripePriceId);
			},
		};
		const app = createTestApp({ stripeConnectService: fakeStripeConnectService });
		const seeded = await json(await app.request('/v1/acceptance/seed', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-treeseed-service-id': 'web',
				'x-treeseed-service-secret': 'web-test-secret',
			},
			body: JSON.stringify({ namespace: 'commerce-phase-4' }),
		}));
		const team = seeded.payload.fixtures.team;
		const ownerToken = seeded.payload.actors.teamOwner.accessToken;
		const adminToken = seeded.payload.actors.marketSteward.accessToken;

		const vendor = await json(await app.request(`/v1/commerce/vendors/${team.id}/request`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({ displayName: 'Phase 4 Vendor', slug: 'phase-4-vendor' }),
		}));
		await app.request(`/v1/commerce/vendors/${vendor.payload.id}/approve`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${adminToken}`,
			},
			body: JSON.stringify({ trustLevel: 'verified_seller', salesEnabled: true }),
		});
		await app.request(`/v1/commerce/vendors/${team.id}/stripe/onboarding`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({}),
		});
		await app.request(`/v1/commerce/vendors/${team.id}/stripe/status?refresh=1`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		});

		const product = await json(await app.request('/v1/commerce/products', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({
				sellerTeamId: team.id,
				kind: 'template',
				slug: 'phase-4-template',
				title: 'Phase 4 Template',
				summary: 'Template with Stripe mirrors.',
				visibility: 'public',
				ownershipModel: 'cooperative_owned',
				ownership: {
					model: 'cooperative_owned',
					canonicalOwnerType: 'cooperative',
					canonicalOwnerId: 'coop-phase-4',
					publicSummary: 'Cooperatively governed.',
				},
			}),
		}));
		await app.request(`/v1/commerce/products/${product.payload.id}/submit`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({}),
		});
		await app.request(`/v1/commerce/products/${product.payload.id}/approve`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${adminToken}`,
			},
			body: JSON.stringify({}),
		});
		const offer = await json(await app.request('/v1/commerce/offers', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({
				productId: product.payload.id,
				mode: 'subscription_updates',
				title: 'Phase 4 Updates',
				termsSummary: 'Subscribers receive cooperative updates.',
			}),
		}));
		const price = await json(await app.request(`/v1/commerce/offers/${offer.payload.id}/prices`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({
				amount: 4900,
				currency: 'usd',
				billingInterval: 'month',
				stripePriceId: 'price_client_supplied_should_be_ignored',
			}),
		}));
		expect(price.payload.stripePriceId).toBeNull();
		await app.request(`/v1/commerce/offers/${offer.payload.id}/submit`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({}),
		});
		const approvedOffer = await json(await app.request(`/v1/commerce/offers/${offer.payload.id}/approve`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${adminToken}`,
			},
			body: JSON.stringify({}),
		}));
		expect(approvedOffer.payload).toMatchObject({
			status: 'approved',
			stripeProductStatus: 'synced',
			stripeProductId: expect.stringMatching(/^prod_/u),
		});
		expect(calls).toContainEqual(expect.objectContaining({
			name: 'createProductMirror',
			input: expect.objectContaining({
				connectedAccountId: expect.stringMatching(/^acct_/u),
				params: expect.objectContaining({
					metadata: expect.objectContaining({
						treeseed_product_id: product.payload.id,
						treeseed_offer_id: offer.payload.id,
						treeseed_ownership_model: 'cooperative_owned',
						treeseed_object_authority: 'treeseed',
					}),
				}),
			}),
		}));

		const activated = await json(await app.request(`/v1/commerce/prices/${price.payload.id}/activate`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({}),
		}));
		expect(activated.payload).toMatchObject({
			status: 'active',
			stripeSyncStatus: 'synced',
			stripePriceId: expect.stringMatching(/^price_/u),
			stripeLookupKey: `treeseed_test_${price.payload.id}_v1`,
		});
		const priceCall = calls.find((call) => call.name === 'createPriceMirror');
		expect(priceCall).toMatchObject({
			input: {
				connectedAccountId: expect.stringMatching(/^acct_/u),
				params: expect.objectContaining({
					unit_amount: 4900,
					currency: 'usd',
					recurring: { interval: 'month' },
					metadata: expect.objectContaining({
						treeseed_price_id: price.payload.id,
						treeseed_price_version: '1',
						treeseed_ownership_model: 'cooperative_owned',
					}),
				}),
			},
		});

		stripePrices.set(activated.payload.stripePriceId, {
			id: activated.payload.stripePriceId,
			unit_amount: 9900,
			currency: 'usd',
			recurring: { interval: 'month' },
			lookup_key: activated.payload.stripeLookupKey,
			metadata: {},
		});
		const drifted = await json(await app.request(`/v1/commerce/prices/${price.payload.id}/stripe/reconcile`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({}),
		}));
		expect(drifted.payload.price).toMatchObject({
			stripeSyncStatus: 'drifted',
			stripeSyncError: expect.stringContaining('immutable terms'),
		});

		const status = await json(await app.request(`/v1/commerce/offers/${offer.payload.id}/stripe/status`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(status.payload.offer.stripeProductStatus).toBe('synced');
		expect(status.payload.prices).toContainEqual(expect.objectContaining({
			id: price.payload.id,
			stripeSyncStatus: 'drifted',
		}));
		const events = await json(await app.request(`/v1/commerce/governance-events?teamId=${team.id}`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(events.payload).toEqual(expect.arrayContaining([
			expect.objectContaining({ action: 'commerce_offer.stripe_product.synced' }),
			expect.objectContaining({ action: 'commerce_price.stripe_price.synced' }),
			expect.objectContaining({ action: 'commerce_price.stripe_price.drifted' }),
		]));
		expect(JSON.stringify({ status, events })).not.toContain('sk_test');
	}, 20_000);

	it('runs phase 5 commerce checkout plus phase 6 commerce vendor sales, commerce seller monitoring, and commerce refunds fulfillment', async () => {
		const stripeAccounts = new Map<string, any>();
		const stripeProducts = new Map<string, any>();
		const stripePrices = new Map<string, any>();
		const paymentIntents = new Map<string, any>();
		const refunds = new Map<string, any>();
		const fakeStripeConnectService = {
			environment: 'test',
			async isConfigured() {
				return true;
			},
			async createExpressAccount({ vendor }: any) {
				const account = {
					id: `acct_${vendor.id}`,
					charges_enabled: true,
					payouts_enabled: true,
					details_submitted: true,
					requirements: { currently_due: [], eventually_due: [], past_due: [], disabled_reason: null },
					capabilities: { card_payments: 'active', transfers: 'active' },
				};
				stripeAccounts.set(account.id, account);
				return account;
			},
			async createOnboardingLink({ stripeAccountId }: any) {
				return { url: `https://connect.stripe.test/onboarding/${stripeAccountId}` };
			},
			async retrieveAccount(stripeAccountId: string) {
				return stripeAccounts.get(stripeAccountId);
			},
			async createProductMirror(input: any) {
				const product = { id: `prod_${stripeProducts.size + 1}`, ...input.params };
				stripeProducts.set(product.id, product);
				return product;
			},
			async updateProductMirror(input: any) {
				const product = { ...(stripeProducts.get(input.stripeProductId) ?? { id: input.stripeProductId }), ...input.params };
				stripeProducts.set(product.id, product);
				return product;
			},
			async retrieveProductMirror({ stripeProductId }: any) {
				return stripeProducts.get(stripeProductId);
			},
			async createPriceMirror(input: any) {
				const price = {
					id: `price_${stripePrices.size + 1}`,
					unit_amount: input.params.unit_amount,
					currency: input.params.currency,
					recurring: input.params.recurring ?? null,
					lookup_key: input.params.lookup_key,
					metadata: input.params.metadata,
				};
				stripePrices.set(price.id, price);
				return price;
			},
			async updatePriceMirror(input: any) {
				const price = { ...(stripePrices.get(input.stripePriceId) ?? { id: input.stripePriceId }), ...input.params };
				stripePrices.set(price.id, price);
				return price;
			},
			async retrievePriceMirror({ stripePriceId }: any) {
				return stripePrices.get(stripePriceId);
			},
			async createPaymentIntent(input: any) {
				const paymentIntent = {
					id: `pi_${paymentIntents.size + 1}`,
					status: 'requires_payment_method',
					client_secret: `pi_secret_${paymentIntents.size + 1}`,
					amount: input.params.amount,
					currency: input.params.currency,
					metadata: input.params.metadata,
					connectedAccountId: input.connectedAccountId,
				};
				paymentIntents.set(paymentIntent.id, paymentIntent);
				return paymentIntent;
			},
			async retrievePaymentIntent({ paymentIntentId }: any) {
				return paymentIntents.get(paymentIntentId);
			},
			async createRefund(input: any) {
				const refund = {
					id: `re_${refunds.size + 1}`,
					status: 'succeeded',
					amount: input.params.amount,
					payment_intent: input.params.payment_intent,
					metadata: input.params.metadata,
					connectedAccountId: input.connectedAccountId,
					idempotencyKey: input.idempotencyKey,
				};
				refunds.set(refund.id, refund);
				return refund;
			},
			async retrieveRefund({ refundId }: any) {
				return refunds.get(refundId);
			},
			async constructWebhookEvent({ payload, signature, webhookSecret }: any) {
				if (signature !== 'valid_signature' || webhookSecret !== 'whsec_test') {
					const error = new Error('Invalid Stripe webhook signature.');
					(error as any).status = 400;
					throw error;
				}
				return JSON.parse(payload);
			},
		};
		const app = createTestApp({
			stripeConnectService: fakeStripeConnectService,
			config: {
				stripePublishableKey: 'pk_test_tree',
				stripeWebhookSecret: 'whsec_test',
			},
		});
		const seeded = await json(await app.request('/v1/acceptance/seed', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-treeseed-service-id': 'web',
				'x-treeseed-service-secret': 'web-test-secret',
			},
			body: JSON.stringify({ namespace: 'commerce-phase-5' }),
		}));
		const team = seeded.payload.fixtures.team;
		const ownerToken = seeded.payload.actors.teamOwner.accessToken;
		const adminToken = seeded.payload.actors.marketSteward.accessToken;

		const stripeConfig = await json(await app.request('/v1/commerce/stripe/config', {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(stripeConfig.payload).toEqual({ publishableKey: 'pk_test_tree', environment: 'test' });

		const vendor = await json(await app.request(`/v1/commerce/vendors/${team.id}/request`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ displayName: 'Phase 5 Vendor', slug: 'phase-5-vendor' }),
		}));
		await app.request(`/v1/commerce/vendors/${vendor.payload.id}/approve`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
			body: JSON.stringify({ trustLevel: 'verified_seller', salesEnabled: true }),
		});
		await app.request(`/v1/commerce/vendors/${team.id}/stripe/onboarding`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({}),
		});
		await app.request(`/v1/commerce/vendors/${team.id}/stripe/status?refresh=1`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		});

		async function approvedProduct(slug: string, title: string) {
			const product = await json(await app.request('/v1/commerce/products', {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
				body: JSON.stringify({
					sellerTeamId: team.id,
					kind: 'template',
					slug,
					title,
					summary: `${title} summary`,
					visibility: 'public',
					ownershipModel: 'cooperative_owned',
					ownership: {
						model: 'cooperative_owned',
						canonicalOwnerType: 'cooperative',
						canonicalOwnerId: `coop-${slug}`,
						publicSummary: 'Cooperatively governed checkout product.',
					},
				}),
			}));
			await app.request(`/v1/commerce/products/${product.payload.id}/submit`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
				body: JSON.stringify({}),
			});
			await app.request(`/v1/commerce/products/${product.payload.id}/approve`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
				body: JSON.stringify({}),
			});
			return product.payload;
		}

		const freeProduct = await approvedProduct('phase-5-free', 'Phase 5 Free');
		const paidProduct = await approvedProduct('phase-5-paid', 'Phase 5 Paid');
		const freeOffer = await json(await app.request('/v1/commerce/offers', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				productId: freeProduct.id,
				mode: 'free',
				title: 'Free cooperative offer',
				accessScope: { artifact: 'free' },
			}),
		}));
		await app.request(`/v1/commerce/offers/${freeOffer.payload.id}/submit`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({}),
		});
		await app.request(`/v1/commerce/offers/${freeOffer.payload.id}/approve`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
			body: JSON.stringify({}),
		});
		const paidOffer = await json(await app.request('/v1/commerce/offers', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				productId: paidProduct.id,
				mode: 'one_time',
				title: 'One-time cooperative offer',
				accessScope: { artifact: 'paid' },
			}),
		}));
		const paidPrice = await json(await app.request(`/v1/commerce/offers/${paidOffer.payload.id}/prices`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ amount: 2500, currency: 'usd', billingInterval: 'one_time' }),
		}));
		await app.request(`/v1/commerce/offers/${paidOffer.payload.id}/submit`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({}),
		});
		await app.request(`/v1/commerce/offers/${paidOffer.payload.id}/approve`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
			body: JSON.stringify({}),
		});
		const activePrice = await json(await app.request(`/v1/commerce/prices/${paidPrice.payload.id}/activate`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({}),
		}));
		expect(activePrice.payload).toMatchObject({ stripeSyncStatus: 'synced', stripePriceId: expect.stringMatching(/^price_/u) });

		const checkout = await json(await app.request('/v1/commerce/checkout', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				buyerTeamId: team.id,
				items: [
					{ offerId: freeOffer.payload.id, quantity: 1 },
					{ offerId: paidOffer.payload.id, priceId: activePrice.payload.id, quantity: 1, amount: 1, sellerTeamId: 'client-spoof' },
				],
			}),
		}));
		expect(checkout.payload.checkout).toMatchObject({
			status: 'partially_confirmed',
			groupCount: 2,
			completedGroupCount: 1,
		});
		expect(checkout.payload.paymentGroups).toEqual(expect.arrayContaining([
			expect.objectContaining({ groupKind: 'free', status: 'succeeded', clientSecret: null }),
			expect.objectContaining({ groupKind: 'one_time', status: 'requires_confirmation', clientSecret: expect.stringMatching(/^pi_secret_/u) }),
		]));
		expect(checkout.payload.entitlements).toContainEqual(expect.objectContaining({
			offerId: freeOffer.payload.id,
			status: 'active',
			ownershipSnapshot: expect.objectContaining({ ownershipModel: 'cooperative_owned' }),
		}));
		expect(JSON.stringify(checkout.payload)).not.toContain('sk_test');
		expect(JSON.stringify(checkout.payload)).not.toContain('applicationFee');
		const paidGroup = checkout.payload.paymentGroups.find((group: any) => group.groupKind === 'one_time');
		paymentIntents.set(paidGroup.stripePaymentIntentId, {
			...paymentIntents.get(paidGroup.stripePaymentIntentId),
			status: 'succeeded',
		});
		const webhookPayload = {
			id: 'evt_phase_5_payment_success',
			type: 'payment_intent.succeeded',
			account: paidGroup.connectedAccountId,
			data: {
				object: {
					id: paidGroup.stripePaymentIntentId,
					object: 'payment_intent',
					status: 'succeeded',
				},
			},
		};
		const webhook = await json(await app.request('/v1/commerce/webhooks/stripe', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'stripe-signature': 'valid_signature',
			},
			body: JSON.stringify(webhookPayload),
		}));
		expect(webhook.payload).toMatchObject({
			eventId: 'evt_phase_5_payment_success',
			status: 'processed',
		});
		const duplicateWebhook = await json(await app.request('/v1/commerce/webhooks/stripe', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'stripe-signature': 'valid_signature',
			},
			body: JSON.stringify(webhookPayload),
		}));
		expect(duplicateWebhook.payload.status).toBe('processed');

		const entitlements = await json(await app.request('/v1/commerce/entitlements?buyerTeamId=' + encodeURIComponent(team.id), {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(entitlements.payload).toEqual(expect.arrayContaining([
			expect.objectContaining({ offerId: freeOffer.payload.id, status: 'active' }),
			expect.objectContaining({ offerId: paidOffer.payload.id, status: 'active' }),
		]));
		expect(entitlements.payload.filter((entitlement: any) => entitlement.offerId === paidOffer.payload.id)).toHaveLength(1);

		const sellerSummary = await json(await app.request(`/v1/commerce/vendors/${team.id}/sales/summary`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(sellerSummary.payload).toMatchObject({
			vendorId: vendor.payload.id,
			sellerTeamId: team.id,
			paidOrderCount: 2,
			activeEntitlementCount: 2,
		});

		const sellerMonitor = await json(await app.request(`/v1/commerce/vendors/${team.id}/monitoring`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(sellerMonitor.payload).toMatchObject({
			vendorId: vendor.payload.id,
			sellerTeamId: team.id,
			stripeReady: true,
			pendingFulfillmentCount: expect.any(Number),
			failedRefundCount: 0,
			failedWebhookCount: expect.any(Number),
			recentGovernanceEvents: expect.any(Array),
		});
		expect(JSON.stringify(sellerMonitor.payload)).not.toContain('client_secret');
		const unrelatedMonitor = await app.request(`/v1/commerce/vendors/${team.id}/monitoring`, {
			headers: { authorization: `Bearer ${seeded.payload.actors.nonMember.accessToken}` },
		});
		expect(unrelatedMonitor.status).toBe(403);

		const sellerOrders = await json(await app.request(`/v1/commerce/vendors/${team.id}/sales/orders`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(sellerOrders.payload[0]).toMatchObject({
			buyerTeamId: team.id,
			buyerUserIdRedacted: expect.anything(),
		});
		expect(JSON.stringify(sellerOrders.payload)).not.toContain('email');

		const paidOrder = checkout.payload.orders.find((order: any) => order.stripePaymentIntentId === paidGroup.stripePaymentIntentId);
		const paidOrderDetail = await json(await app.request(`/v1/commerce/orders/${paidOrder.id}`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		const paidOrderItem = paidOrderDetail.payload.items.find((item: any) => item.offerId === paidOffer.payload.id);
		const fulfillment = await json(await app.request(`/v1/commerce/order-items/${paidOrderItem.id}/fulfillment/artifact`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ artifactRefs: [{ key: 'manual-artifact' }], message: 'Delivered from test.' }),
		}));
		expect(fulfillment.payload.event).toMatchObject({
			orderItemId: paidOrderItem.id,
			status: 'delivered',
			eventType: 'artifact_delivered',
		});
		const fulfillmentEvents = await json(await app.request(`/v1/commerce/vendors/${team.id}/sales/fulfillment-events`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(fulfillmentEvents.payload).toEqual(expect.arrayContaining([
			expect.objectContaining({ orderItemId: paidOrderItem.id, status: 'delivered' }),
		]));

		const refund = await json(await app.request(`/v1/commerce/orders/${paidOrder.id}/refunds`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ orderItemId: paidOrderItem.id, amount: 2500, reason: 'test refund', idempotencyKey: 'phase-6-refund-key' }),
		}));
		expect(refund.payload.refund).toMatchObject({
			orderId: paidOrder.id,
			orderItemId: paidOrderItem.id,
			status: 'succeeded',
			amount: 2500,
			stripeRefundId: expect.stringMatching(/^re_/u),
		});
		expect(refunds.get(refund.payload.refund.stripeRefundId)).toMatchObject({
			connectedAccountId: paidGroup.connectedAccountId,
			idempotencyKey: 'phase-6-refund-key',
		});
		const duplicateRefund = await json(await app.request(`/v1/commerce/orders/${paidOrder.id}/refunds`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ orderItemId: paidOrderItem.id, amount: 2500, idempotencyKey: 'phase-6-refund-key' }),
		}));
		expect(duplicateRefund.payload.id ?? duplicateRefund.payload.refund?.id).toBe(refund.payload.refund.id);
		const salesRefunds = await json(await app.request(`/v1/commerce/vendors/${team.id}/sales/refunds`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(salesRefunds.payload).toContainEqual(expect.objectContaining({ id: refund.payload.refund.id, status: 'succeeded' }));

		const revoked = await json(await app.request(`/v1/commerce/entitlements/${paidOrderItem.entitlementId}/revoke`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ reason: 'test revocation' }),
		}));
		expect(revoked.payload).toMatchObject({ id: paidOrderItem.entitlementId, status: 'revoked' });

		const invalidWebhook = await app.request('/v1/commerce/webhooks/stripe', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'stripe-signature': 'invalid_signature',
			},
			body: JSON.stringify({ id: 'evt_invalid', type: 'unknown', data: { object: {} } }),
		});
		expect(invalidWebhook.status).toBe(400);
	}, 25_000);

	it('runs phase 8 commerce scoped services request quote contract checkout and fulfillment', async () => {
		const stripeAccounts = new Map<string, any>();
		const stripeProducts = new Map<string, any>();
		const paymentIntents = new Map<string, any>();
		const fakeStripeConnectService = {
			environment: 'test',
			async isConfigured() {
				return true;
			},
			async createExpressAccount({ vendor }: any) {
				const account = {
					id: `acct_${vendor.id}`,
					charges_enabled: true,
					payouts_enabled: true,
					details_submitted: true,
					requirements: { currently_due: [], eventually_due: [], past_due: [], disabled_reason: null },
					capabilities: { card_payments: 'active', transfers: 'active' },
				};
				stripeAccounts.set(account.id, account);
				return account;
			},
			async createOnboardingLink({ stripeAccountId }: any) {
				return { url: `https://connect.stripe.test/onboarding/${stripeAccountId}` };
			},
			async retrieveAccount(stripeAccountId: string) {
				return stripeAccounts.get(stripeAccountId);
			},
			async createProductMirror(input: any) {
				const product = { id: `prod_${stripeProducts.size + 1}`, ...input.params };
				stripeProducts.set(product.id, product);
				return product;
			},
			async updateProductMirror(input: any) {
				const product = { ...(stripeProducts.get(input.stripeProductId) ?? { id: input.stripeProductId }), ...input.params };
				stripeProducts.set(product.id, product);
				return product;
			},
			async retrieveProductMirror({ stripeProductId }: any) {
				return stripeProducts.get(stripeProductId);
			},
			async createPaymentIntent(input: any) {
				const paymentIntent = {
					id: `pi_service_${paymentIntents.size + 1}`,
					status: 'requires_payment_method',
					client_secret: `pi_service_secret_${paymentIntents.size + 1}`,
					amount: input.params.amount,
					currency: input.params.currency,
					metadata: input.params.metadata,
					connectedAccountId: input.connectedAccountId,
				};
				paymentIntents.set(paymentIntent.id, paymentIntent);
				return paymentIntent;
			},
			async retrievePaymentIntent({ paymentIntentId }: any) {
				return paymentIntents.get(paymentIntentId);
			},
			async constructWebhookEvent({ payload, signature, webhookSecret }: any) {
				if (signature !== 'valid_signature' || webhookSecret !== 'whsec_test') {
					const error = new Error('Invalid Stripe webhook signature.');
					(error as any).status = 400;
					throw error;
				}
				return JSON.parse(payload);
			},
		};
		const app = createTestApp({
			stripeConnectService: fakeStripeConnectService,
			config: {
				stripePublishableKey: 'pk_test_tree',
				stripeWebhookSecret: 'whsec_test',
			},
		});
		const seeded = await json(await app.request('/v1/acceptance/seed', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-treeseed-service-id': 'web',
				'x-treeseed-service-secret': 'web-test-secret',
			},
			body: JSON.stringify({ namespace: 'commerce-phase-8' }),
		}));
		const team = seeded.payload.fixtures.team;
		const ownerToken = seeded.payload.actors.teamOwner.accessToken;
		const adminToken = seeded.payload.actors.marketSteward.accessToken;

		const vendor = await json(await app.request(`/v1/commerce/vendors/${team.id}/request`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ displayName: 'Scoped Service Vendor', slug: 'scoped-service-vendor' }),
		}));
		await app.request(`/v1/commerce/vendors/${vendor.payload.id}/approve`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
			body: JSON.stringify({
				trustLevel: 'trusted_service_vendor',
				salesEnabled: true,
				serviceSalesEnabled: true,
			}),
		});
		await app.request(`/v1/commerce/vendors/${team.id}/stripe/onboarding`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({}),
		});
		await app.request(`/v1/commerce/vendors/${team.id}/stripe/status?refresh=1`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		});

		const product = await json(await app.request('/v1/commerce/products', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				sellerTeamId: team.id,
				kind: 'scoped_service',
				slug: 'cooperative-service',
				title: 'Cooperative Service',
				summary: 'Scoped service with governed quotes.',
				visibility: 'public',
				ownershipModel: 'cooperative_owned',
				ownership: {
					model: 'cooperative_owned',
					canonicalOwnerType: 'cooperative',
					canonicalOwnerId: 'coop-service-phase-8',
					publicSummary: 'Service governed by cooperative stewards.',
				},
			}),
		}));
		await app.request(`/v1/commerce/products/${product.payload.id}/stewards`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				role: 'governance_steward',
				assigneeType: 'team',
				assigneeId: team.id,
				displayName: 'Service Governance Steward',
			}),
		});
		await app.request(`/v1/commerce/products/${product.payload.id}/submit`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({}),
		});
		await app.request(`/v1/commerce/products/${product.payload.id}/approve`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
			body: JSON.stringify({}),
		});
		const offer = await json(await app.request('/v1/commerce/offers', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				productId: product.payload.id,
				mode: 'scoped_contract',
				title: 'Scoped service contract',
				termsSummary: 'Quote-driven scoped service.',
				accessScope: { service: 'governed_scope' },
			}),
		}));
		await app.request(`/v1/commerce/offers/${offer.payload.id}/submit`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({}),
		});
		await app.request(`/v1/commerce/offers/${offer.payload.id}/approve`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
			body: JSON.stringify({}),
		});

		const invalidProduct = await json(await app.request('/v1/commerce/products', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				sellerTeamId: team.id,
				kind: 'template',
				slug: 'not-a-service',
				title: 'Not a Service',
				summary: 'Template product.',
				visibility: 'public',
			}),
		}));
		const invalidOffer = await json(await app.request('/v1/commerce/offers', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				productId: invalidProduct.payload.id,
				mode: 'scoped_contract',
				title: 'Invalid service offer',
			}),
		}));
		const invalidRequest = await app.request('/v1/commerce/services/requests', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ offerId: invalidOffer.payload.id, requestedScope: 'Should fail.' }),
		});
		expect(invalidRequest.status).toBe(409);

		const serviceRequest = await json(await app.request('/v1/commerce/services/requests', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				buyerTeamId: team.id,
				offerId: offer.payload.id,
				requestedScope: 'Scope a migration with cooperative governance review.',
				accessNeeds: { repository: 'read', secrets: 'explicit-review-required' },
				relatedProjectId: 'project-reference-only',
				amount: 1,
				stripePriceId: 'price_client_spoof',
			}),
		}));
		expect(serviceRequest.payload).toMatchObject({
			status: 'requested',
			vendorId: vendor.payload.id,
			sellerTeamId: team.id,
			productId: product.payload.id,
			offerId: offer.payload.id,
			ownershipSnapshot: expect.objectContaining({
				ownershipModel: 'cooperative_owned',
				stewards: expect.arrayContaining([
					expect.objectContaining({ role: 'governance_steward' }),
				]),
			}),
		});
		expect(serviceRequest.payload).not.toHaveProperty('stripePriceId');

		await app.request(`/v1/commerce/services/requests/${serviceRequest.payload.id}/scoping`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ reason: 'Begin seller scoping.' }),
		});
		const scopedRequest = await json(await app.request(`/v1/commerce/services/requests/${serviceRequest.payload.id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				approvedScope: 'Approved migration scope.',
				buyerVisibleSummary: 'Governed migration support.',
				vendorPrivateNotes: 'Seller-only operational note.',
			}),
		}));
		expect(scopedRequest.payload).toMatchObject({
			status: 'scoping',
			approvedScope: 'Approved migration scope.',
			vendorPrivateNotes: 'Seller-only operational note.',
		});

		const quote = await json(await app.request(`/v1/commerce/services/requests/${serviceRequest.payload.id}/quotes`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				title: 'Scoped migration quote',
				scopeSummary: 'Migration support with explicit access review.',
				deliverables: [{ name: 'Migration plan' }],
				assumptions: [{ name: 'Buyer grants reviewed repository access' }],
				accessRequirements: { repository: 'read' },
				governanceRequirements: { review: 'seller_steward' },
				amount: 12500,
				currency: 'usd',
			}),
		}));
		expect(quote.payload).toMatchObject({
			status: 'draft',
			quoteVersion: 1,
			amount: 12500,
			currency: 'usd',
		});
		const secondQuote = await json(await app.request(`/v1/commerce/services/requests/${serviceRequest.payload.id}/quotes`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				title: 'Scoped migration quote revision',
				scopeSummary: 'Revised migration support.',
				amount: 13000,
				currency: 'usd',
			}),
		}));
		expect(secondQuote.payload.quoteVersion).toBe(2);
		const invalidQuote = await app.request(`/v1/commerce/services/requests/${serviceRequest.payload.id}/quotes`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				title: 'Invalid quote',
				scopeSummary: 'Invalid.',
				amount: 0,
				currency: 'US',
			}),
		});
		expect(invalidQuote.status).toBe(400);
		await app.request(`/v1/commerce/services/quotes/${secondQuote.payload.id}/submit`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({}),
		});
		const rejected = await json(await app.request(`/v1/commerce/services/quotes/${secondQuote.payload.id}/reject`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ reason: 'Buyer rejected revision.' }),
		}));
		expect(rejected.payload.status).toBe('rejected');
		const finalQuote = await json(await app.request(`/v1/commerce/services/requests/${serviceRequest.payload.id}/quotes`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				title: 'Accepted scoped migration quote',
				scopeSummary: 'Accepted migration support with explicit access review.',
				deliverables: [{ name: 'Migration plan' }],
				assumptions: [{ name: 'Buyer grants reviewed repository access' }],
				accessRequirements: { repository: 'read' },
				governanceRequirements: { review: 'seller_steward' },
				amount: 12500,
				currency: 'usd',
			}),
		}));
		expect(finalQuote.payload.quoteVersion).toBe(3);

		await app.request(`/v1/commerce/services/quotes/${finalQuote.payload.id}/submit`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({}),
		});
		await app.request(`/v1/commerce/services/quotes/${finalQuote.payload.id}/buyer-approve`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({}),
		});
		const accepted = await json(await app.request(`/v1/commerce/services/quotes/${finalQuote.payload.id}/vendor-approve`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({}),
		}));
		expect(accepted.payload.quote).toMatchObject({
			status: 'accepted',
			acceptedAt: expect.any(String),
		});
		expect(accepted.payload.contract).toMatchObject({
			status: 'pending_checkout',
			amount: 12500,
			currency: 'usd',
		});

		const bypass = await app.request('/v1/commerce/checkout', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ buyerTeamId: team.id, items: [{ offerId: offer.payload.id, quantity: 1 }] }),
		});
		expect(bypass.status).toBe(409);

		const checkout = await json(await app.request(`/v1/commerce/services/contracts/${accepted.payload.contract.id}/checkout`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ amount: 1 }),
		}));
		expect(checkout.payload.checkout.status).toBe('requires_confirmation');
		expect(checkout.payload.paymentGroups).toEqual([
			expect.objectContaining({
				groupKind: 'one_time',
				totalAmount: 12500,
				clientSecret: expect.stringMatching(/^pi_service_secret_/u),
			}),
		]);
		const paymentGroup = checkout.payload.paymentGroups[0];
		const paymentIntent = paymentIntents.get(paymentGroup.stripePaymentIntentId);
		expect(paymentIntent).toMatchObject({
			amount: 12500,
			currency: 'usd',
			connectedAccountId: expect.stringMatching(/^acct_/u),
			metadata: expect.objectContaining({
				treeseed_service_request_id: serviceRequest.payload.id,
				treeseed_service_quote_id: finalQuote.payload.id,
				treeseed_service_contract_id: accepted.payload.contract.id,
				treeseed_product_id: product.payload.id,
			}),
		});
		expect(JSON.stringify(checkout.payload)).not.toContain('sk_test');

		paymentIntents.set(paymentGroup.stripePaymentIntentId, {
			...paymentIntent,
			status: 'succeeded',
		});
		const webhook = await json(await app.request('/v1/commerce/webhooks/stripe', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'stripe-signature': 'valid_signature',
			},
			body: JSON.stringify({
				id: 'evt_phase_8_payment_success',
				type: 'payment_intent.succeeded',
				account: paymentGroup.connectedAccountId,
				data: {
					object: {
						id: paymentGroup.stripePaymentIntentId,
						object: 'payment_intent',
						status: 'succeeded',
						metadata: paymentIntent.metadata,
					},
				},
			}),
		}));
		expect(webhook.payload.status).toBe('processed');
		const activatedContract = await json(await app.request(`/v1/commerce/services/contracts/${accepted.payload.contract.id}`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(activatedContract.payload).toMatchObject({
			status: 'active',
			orderId: checkout.payload.orders[0].id,
			paymentGroupId: paymentGroup.id,
			entitlementId: expect.any(String),
		});
		const activeRequest = await json(await app.request(`/v1/commerce/services/requests/${serviceRequest.payload.id}`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(activeRequest.payload.request).toMatchObject({
			status: 'active',
			contractId: accepted.payload.contract.id,
			entitlementId: activatedContract.payload.entitlementId,
		});

		const linked = await json(await app.request(`/v1/commerce/services/contracts/${accepted.payload.contract.id}/link-work`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ relatedProjectId: 'project-link-only', relatedWorkdayId: 'workday-link-only' }),
		}));
		expect(linked.payload).toMatchObject({
			relatedProjectId: 'project-link-only',
			relatedWorkdayId: 'workday-link-only',
		});
		const fulfilled = await json(await app.request(`/v1/commerce/services/contracts/${accepted.payload.contract.id}/fulfill`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				summary: 'Scoped service delivered.',
				artifactRefs: [{ key: 'service-delivery-note' }],
				deliveryRefs: [{ href: '/services/delivery/reference' }],
			}),
		}));
		expect(fulfilled.payload.contract).toMatchObject({ status: 'fulfilled', fulfillmentSummary: 'Scoped service delivered.' });
		const fulfilledRequest = await json(await app.request(`/v1/commerce/services/requests/${serviceRequest.payload.id}`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(fulfilledRequest.payload.request.status).toBe('fulfilled');
		expect(fulfilled.payload.event).toMatchObject({
			status: 'delivered',
			eventType: 'artifact_delivered',
			entitlementId: activatedContract.payload.entitlementId,
		});

		const events = await json(await app.request(`/v1/commerce/services/events?requestId=${serviceRequest.payload.id}`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(events.payload).toEqual(expect.arrayContaining([
			expect.objectContaining({ eventType: 'requested' }),
			expect.objectContaining({ eventType: 'quote_created' }),
			expect.objectContaining({ eventType: 'quote_buyer_approved' }),
			expect.objectContaining({ eventType: 'quote_vendor_approved' }),
			expect.objectContaining({ eventType: 'checkout_created' }),
			expect.objectContaining({ eventType: 'contract_activated' }),
			expect.objectContaining({ eventType: 'work_linked' }),
			expect.objectContaining({ eventType: 'fulfilled' }),
		]));
		const governance = await json(await app.request(`/v1/commerce/governance-events?teamId=${team.id}`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(governance.payload).toEqual(expect.arrayContaining([
			expect.objectContaining({ action: 'commerce_service.requested' }),
			expect.objectContaining({ action: 'commerce_service.contract_activated' }),
			expect.objectContaining({ action: 'commerce_service.fulfilled' }),
		]));
		const serialized = JSON.stringify({ checkout, activeRequest, fulfilled, events, governance });
		expect(serialized).not.toContain('sk_test');
		expect(serialized).not.toContain('card');
		expect(serialized).not.toContain('applicationFee');
		expect(serialized).not.toContain('revenueSplit');
		expect(serialized).not.toContain('capacityCredit');

		const legacyPaid = await app.request('/v1/commerce/offers', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				productId: product.payload.id,
				mode: 'paid',
				title: 'Legacy paid scoped service',
			}),
		});
		expect(legacyPaid.status).toBe(400);
	}, 25_000);

	it('manages commerce capacity marketplace listings and inquiries without execution or billing side effects', async () => {
		const app = createTestApp();
		const seeded = await json(await app.request('/v1/acceptance/seed', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-treeseed-service-id': 'web',
				'x-treeseed-service-secret': 'web-test-secret',
			},
			body: JSON.stringify({ namespace: 'commerce-phase-9' }),
		}));
		const team = seeded.payload.fixtures.team;
		const ownerToken = seeded.payload.actors.teamOwner.accessToken;
		const adminToken = seeded.payload.actors.marketSteward.accessToken;
		const viewerToken = seeded.payload.actors.teamViewer.accessToken;
		const nonMemberToken = seeded.payload.actors.nonMember.accessToken;

		const vendor = await json(await app.request(`/v1/commerce/vendors/${team.id}/request`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ displayName: 'Capacity Cooperative', slug: 'capacity-cooperative' }),
		}));
		await app.request(`/v1/commerce/vendors/${vendor.payload.id}/approve`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
			body: JSON.stringify({
				trustLevel: 'trusted_capacity_vendor',
				capacityListingsEnabled: true,
				reason: 'Capacity trust review passed.',
			}),
		});

		const blockedVendor = await json(await app.request(`/v1/commerce/vendors/${team.id}/request`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ displayName: 'Duplicate Capacity Request', slug: 'duplicate-capacity-request' }),
		}));
		const approvedVendor = await json(await app.request(`/v1/commerce/vendors/${vendor.payload.id}/approve`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
			body: JSON.stringify({
				trustLevel: 'trusted_capacity_vendor',
				capacityListingsEnabled: true,
			}),
		}));
		expect(blockedVendor.payload.id).toBe(vendor.payload.id);
		expect(approvedVendor.payload).toMatchObject({
			status: 'approved',
			trustLevel: 'trusted_capacity_vendor',
			capacityListingsEnabled: true,
		});

		const providerResponse = await app.request(`/v1/teams/${team.id}/capacity-providers`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ name: 'Disclosure Provider', launchMode: 'self_hosted' }),
		});
		expect(providerResponse.status).toBe(201);
		const provider = (await json(providerResponse)).provider;
		const laneResponse = await app.request(`/v1/teams/${team.id}/capacity-providers/${provider.id}/lanes`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				name: 'Review lane',
				businessModel: 'token_metered',
				unit: 'token_usd',
				scarcityLevel: 'low',
				modelClass: 'small',
			}),
		});
		expect(laneResponse.status).toBe(201);
		const lane = (await json(laneResponse)).payload;

		const product = await json(await app.request('/v1/commerce/products', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				sellerTeamId: team.id,
				kind: 'capacity_listing',
				slug: 'capacity-foundation',
				title: 'Capacity Foundation',
				summary: 'Trust-gated capacity discovery.',
				visibility: 'public',
				ownershipModel: 'cooperative_owned',
				ownership: {
					model: 'cooperative_owned',
					canonicalOwnerType: 'cooperative',
					canonicalOwnerId: 'capacity-coop',
					publicSummary: 'Capacity listing governed by cooperative stewards.',
				},
			}),
		}));
		await app.request(`/v1/commerce/products/${product.payload.id}/stewards`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				role: 'governance_steward',
				assigneeType: 'team',
				assigneeId: team.id,
				displayName: 'Capacity Governance Steward',
			}),
		});

		const blockedCommercialOffer = await app.request('/v1/commerce/offers', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				productId: product.payload.id,
				mode: 'one_time',
				title: 'Blocked capacity checkout',
			}),
		});
		expect(blockedCommercialOffer.status).toBe(409);
		const legacyPaid = await app.request('/v1/commerce/offers', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				productId: product.payload.id,
				mode: 'paid',
				title: 'Legacy paid capacity',
			}),
		});
		expect(legacyPaid.status).toBe(400);
		const contactOffer = await json(await app.request('/v1/commerce/offers', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				productId: product.payload.id,
				mode: 'contact',
				title: 'Capacity inquiry',
				termsSummary: 'Discovery and seller review only.',
			}),
		}));
		expect(contactOffer.payload.mode).toBe('contact');

		const listing = await json(await app.request(`/v1/commerce/products/${product.payload.id}/capacity-listing`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				capacityProviderId: provider.id,
				capacityProviderLaneId: lane.id,
				accessLevel: 'public_summary',
				runtimeIsolationLevel: 'tenant_isolated',
				humanInvolvementLevel: 'operator_assisted',
				aiInvolvementLevel: 'agentic',
				dataAccessLevel: 'project_scoped',
				secretAccessLevel: 'delegated_scoped',
				supportedServiceTypes: ['review', 'migration'],
				supportedRegions: ['us'],
				runtimeRequirements: { lane: 'review' },
				dataHandlingSummary: 'Project-scoped data only after explicit review.',
				buyerVisibleRiskSummary: 'Seller review required before any private data or secrets.',
				governanceRequirements: { review: 'market_admin_or_steward' },
				supportPolicy: 'Seller-assisted review.',
				availabilitySummary: 'Weekday review windows.',
				metadata: { privateNote: 'seller-only' },
				grantId: 'client-spoof',
				stripePriceId: 'price_spoof',
			}),
		}));
		expect(listing.payload).toMatchObject({
			status: 'draft',
			productId: product.payload.id,
			vendorId: vendor.payload.id,
			capacityProviderId: provider.id,
			capacityProviderLaneId: lane.id,
			ownershipSnapshot: expect.objectContaining({
				ownershipModel: 'cooperative_owned',
				stewards: expect.arrayContaining([
					expect.objectContaining({ role: 'governance_steward' }),
				]),
			}),
		});
		expect(listing.payload).not.toHaveProperty('grantId');
		expect(listing.payload).not.toHaveProperty('stripePriceId');

		const publicDraft = await app.request(`/v1/commerce/capacity-listings/${listing.payload.id}`);
		expect(publicDraft.status).toBe(404);

		await app.request(`/v1/commerce/products/${product.payload.id}/submit`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({}),
		});
		await app.request(`/v1/commerce/products/${product.payload.id}/approve`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
			body: JSON.stringify({}),
		});
		await app.request(`/v1/commerce/capacity-listings/${listing.payload.id}/submit`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({}),
		});
		const approvedListing = await json(await app.request(`/v1/commerce/capacity-listings/${listing.payload.id}/approve`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
			body: JSON.stringify({ reason: 'Approved public capacity disclosure.' }),
		}));
		expect(approvedListing.payload.status).toBe('approved');

		const publicListing = await json(await app.request(`/v1/commerce/capacity-listings/${listing.payload.id}`));
		expect(publicListing.payload).toMatchObject({
			status: 'approved',
			accessLevel: 'public_summary',
			runtimeIsolationLevel: 'tenant_isolated',
			aiInvolvementLevel: 'agentic',
			humanInvolvementLevel: 'operator_assisted',
			dataAccessLevel: 'project_scoped',
			secretAccessLevel: 'delegated_scoped',
		});
		expect(publicListing.payload.capacityProviderId).toBeNull();
		expect(publicListing.payload.metadata).toEqual({});
		expect(publicListing.payload.governanceRequirements).toEqual({});
		const publicList = await json(await app.request('/v1/commerce/capacity-listings'));
		expect(publicList.payload).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: listing.payload.id, status: 'approved' }),
		]));

		const inquiry = await json(await app.request(`/v1/commerce/capacity-listings/${listing.payload.id}/inquiries`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({
				buyerTeamId: team.id,
				requestedServiceType: 'migration',
				requestedScope: 'Evaluate capacity for a governed migration.',
				dataAccessRequested: { repository: 'read after review' },
				secretAccessRequested: { secrets: 'buyer managed' },
				relatedProjectId: 'project-disclosure-only',
				relatedWorkdayId: 'workday-disclosure-only',
				sellerTeamId: 'client-spoof',
				priceId: 'price-spoof',
				stripePaymentIntentId: 'pi_spoof',
				capacityGrantId: 'grant-spoof',
				capacityReservationId: 'reservation-spoof',
				executionCredential: 'secret-spoof',
			}),
		}));
		expect(inquiry.payload).toMatchObject({
			status: 'requested',
			listingId: listing.payload.id,
			productId: product.payload.id,
			vendorId: vendor.payload.id,
			sellerTeamId: team.id,
			buyerTeamId: team.id,
		});
		expect(inquiry.payload).not.toHaveProperty('priceId');
		expect(inquiry.payload).not.toHaveProperty('stripePaymentIntentId');
		expect(inquiry.payload).not.toHaveProperty('capacityGrantId');

		const readerList = await json(await app.request(`/v1/commerce/capacity-listing-inquiries?sellerTeamId=${encodeURIComponent(team.id)}`, {
			headers: { authorization: `Bearer ${viewerToken}` },
		}));
		expect(readerList.payload).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: inquiry.payload.id }),
		]));
		const unrelatedRead = await app.request(`/v1/commerce/capacity-listing-inquiries/${inquiry.payload.id}`, {
			headers: { authorization: `Bearer ${nonMemberToken}` },
		});
		expect(unrelatedRead.status).toBe(403);

		const reviewing = await json(await app.request(`/v1/commerce/capacity-listing-inquiries/${inquiry.payload.id}/review`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ reason: 'Seller started review.' }),
		}));
		expect(reviewing.payload.status).toBe('reviewing');
		const approvedInquiry = await json(await app.request(`/v1/commerce/capacity-listing-inquiries/${inquiry.payload.id}/approve-for-scoping`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({ reason: 'Approved for scoping discussion.' }),
		}));
		expect(approvedInquiry.payload.status).toBe('approved_for_scoping');

		const canceledAfterApproval = await app.request(`/v1/commerce/capacity-listing-inquiries/${inquiry.payload.id}/cancel`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
			body: JSON.stringify({}),
		});
		expect(canceledAfterApproval.status).toBe(409);

		const serviceRequests = await json(await app.request('/v1/commerce/services/requests', {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		const checkouts = await json(await app.request('/v1/commerce/orders', {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		const entitlements = await json(await app.request('/v1/commerce/entitlements', {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		const grants = await json(await app.request(`/v1/teams/${team.id}/capacity-grants`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(serviceRequests.payload).toEqual([]);
		expect(checkouts.payload).toEqual([]);
		expect(entitlements.payload).toEqual([]);
		expect(grants.payload).toEqual([]);

		const governance = await json(await app.request(`/v1/commerce/governance-events?teamId=${team.id}`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(governance.payload).toEqual(expect.arrayContaining([
			expect.objectContaining({ action: 'commerce_capacity_listing.created' }),
			expect.objectContaining({ action: 'commerce_capacity_listing.provider_linked' }),
			expect.objectContaining({ action: 'commerce_capacity_listing.submitted' }),
			expect.objectContaining({ action: 'commerce_capacity_listing.approved' }),
			expect.objectContaining({ action: 'commerce_capacity_inquiry.created' }),
			expect.objectContaining({ action: 'commerce_capacity_inquiry.reviewing' }),
			expect.objectContaining({ action: 'commerce_capacity_inquiry.approved_for_scoping' }),
		]));
		const serialized = JSON.stringify({ approvedListing, publicListing, inquiry, approvedInquiry, governance });
		expect(serialized).not.toContain('sk_test');
		expect(serialized).not.toContain('client_secret');
		expect(serialized).not.toContain('card');
		expect(serialized).not.toContain('payout');
		expect(serialized).not.toContain('applicationFee');
		expect(serialized).not.toContain('commission');
		expect(serialized).not.toContain('revenueSplit');
		expect(serialized).not.toContain('providerToken');
		expect(serialized).not.toContain('capacityCredit');
		expect(serialized).not.toContain('grantToken');
		expect(serialized).not.toContain('executionCredential');
	}, 25_000);

	it('keeps Stripe Connect onboarding disabled when the market has no Stripe configuration', async () => {
		const app = createTestApp();
		const seeded = await json(await app.request('/v1/acceptance/seed', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-treeseed-service-id': 'web',
				'x-treeseed-service-secret': 'web-test-secret',
			},
			body: JSON.stringify({ namespace: 'commerce-phase-3-unconfigured' }),
		}));
		const team = seeded.payload.fixtures.team;
		const ownerToken = seeded.payload.actors.teamOwner.accessToken;
		const adminToken = seeded.payload.actors.marketSteward.accessToken;

		const vendor = await json(await app.request(`/v1/commerce/vendors/${team.id}/request`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({ displayName: 'Unconfigured Stripe Vendor' }),
		}));
		await app.request(`/v1/commerce/vendors/${vendor.payload.id}/approve`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${adminToken}`,
			},
			body: JSON.stringify({ trustLevel: 'verified_seller', salesEnabled: true }),
		});

		const status = await json(await app.request(`/v1/commerce/vendors/${team.id}/stripe/status`, {
			headers: { authorization: `Bearer ${ownerToken}` },
		}));
		expect(status.payload).toBeNull();

		const response = await app.request(`/v1/commerce/vendors/${team.id}/stripe/onboarding`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${ownerToken}`,
			},
			body: JSON.stringify({}),
		});
		expect(response.status).toBe(409);
		const payload = await json(response);
		expect(payload.error).toContain('Stripe Connect is not configured');
	}, 15_000);

	it('exposes market-owned v1 auth, market registry, access, and artifact download contracts', async () => {
		const app = createTestApp({
			config: {
				baseUrl: 'https://market.example.com',
				siteUrl: 'https://app.market.example.com',
			},
		});
		const started = await json(await app.request('/v1/auth/device/start', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ clientName: 'treeseed-cli', scopes: ['auth:me', 'market'] }),
		}));
		expect(started.verificationUri).toBe('https://app.market.example.com/auth/device/approve');
		expect(started.verificationUriComplete).toBe(`https://app.market.example.com/auth/device/approve?user_code=${encodeURIComponent(started.userCode)}`);
		await app.request('/v1/auth/device/approve', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				userCode: started.userCode,
				principalId: 'user-market-v1',
				displayName: 'Market V1 User',
				scopes: ['auth:me', 'market'],
			}),
		});
		const tokenPayload = await json(await app.request('/v1/auth/device/poll', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ deviceCode: started.deviceCode }),
		}));
		expect(tokenPayload.principal.id).toBe('user-market-v1');

		const team = await json(await app.request('/v1/teams', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${tokenPayload.accessToken}`,
			},
			body: JSON.stringify({
				slug: 'market-v1-team',
				name: 'Market V1 Team',
				metadata: {
					marketProfiles: [{
						id: 'enterprise-v1',
						label: 'Enterprise V1',
						baseUrl: 'https://enterprise.example.com',
						kind: 'specialized',
					}],
				},
			}),
		}));
		const project = await json(await app.request(`/v1/teams/${team.payload.id}/projects`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${tokenPayload.accessToken}`,
			},
			body: JSON.stringify({ id: 'market-v1-project', slug: 'market-v1-project', name: 'Market V1 Project' }),
		}));

		const me = await json(await app.request('/v1/me', {
			headers: { authorization: `Bearer ${tokenPayload.accessToken}` },
		}));
		expect(me.payload.principal.id).toBe('user-market-v1');
		expect(me.payload.teams[0].id).toBe(team.payload.id);

		const markets = await json(await app.request('/v1/me/markets', {
			headers: { authorization: `Bearer ${tokenPayload.accessToken}` },
		}));
		expect(markets.payload).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: 'central', kind: 'central', alwaysAvailable: true }),
			expect.objectContaining({ id: 'enterprise-v1', kind: 'specialized', teamId: team.payload.id }),
		]));

		const access = await json(await app.request(`/v1/projects/${project.payload.project.id}/access`, {
			headers: { authorization: `Bearer ${tokenPayload.accessToken}` },
		}));
		expect(access.payload.team.summary.canAdminStaging).toBe(true);
		expect(access.payload.team.summary.canAdminProduction).toBe(true);
		expect(access.payload.environments).toEqual(expect.arrayContaining([
			expect.objectContaining({ environment: 'staging', role: 'admin' }),
			expect.objectContaining({ environment: 'prod', role: 'admin' }),
		]));

		const catalogItem = await json(await app.request(`/v1/teams/${team.payload.id}/catalog-items`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${tokenPayload.accessToken}`,
			},
			body: JSON.stringify({
				kind: 'template',
				slug: 'downloadable-starter',
				title: 'Downloadable Starter',
				visibility: 'public',
				listingEnabled: true,
				offerMode: 'free',
			}),
		}));
		await app.request(`/v1/catalog/${catalogItem.payload.id}/artifacts`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${tokenPayload.accessToken}`,
			},
			body: JSON.stringify({
				kind: 'template_artifact',
				version: '1.0.0',
				contentKey: 'teams/market-v1/artifacts/downloadable-starter.tar',
				metadata: {
					contentType: 'application/vnd.treeseed.template+tar',
					sha256: 'abc123',
					downloadUrl: 'https://cdn.example.com/downloadable-starter.tar',
				},
			}),
		});
		const download = await json(await app.request(`/v1/catalog/${catalogItem.payload.id}/artifacts/1.0.0/download`));
		expect(download.payload).toMatchObject({
			itemId: catalogItem.payload.id,
			slug: 'downloadable-starter',
			version: '1.0.0',
			contentType: 'application/vnd.treeseed.template+tar',
			sha256: 'abc123',
			downloadUrl: 'https://cdn.example.com/downloadable-starter.tar',
		});
	}, 20_000);

	it('serves Market UI projections from backend v1 routes', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const token = await authorizeApp(app, { principalId: 'ui-projection-user', displayName: 'UI Projection User' });
		const headers = { authorization: `Bearer ${token}` };
		const { team, project } = await createTeamAndProject(app, token, {
			id: 'ui-projection-project',
			slug: 'ui-projection-project',
			name: 'UI Projection Project',
		});
		const approval = await store.createApprovalRequest({
			id: 'ui-approval-1',
			teamId: team.id,
			projectId: project.id,
			workDayId: 'ui-workday-1',
			kind: 'publish_report',
			severity: 'high',
			requestedByType: 'platform',
			requestedById: 'operations-runner',
			title: 'Publish projection report',
			summary: 'Review the generated projection report.',
			options: [{ id: 'approve', label: 'Approve', state: 'approved' }],
		});
		if (!approval) throw new Error('Expected UI projection approval fixture to be created.');
		await store.createProjectWorkdaySummary(project.id, {
			id: 'ui-workday-summary-1',
			environment: 'staging',
			workDayId: 'ui-workday-1',
			state: 'active',
			summary: { objective: 'Verify backend UI projections' },
		});

		const governance = await json(await app.request('/v1/ui/governance', { headers }));
		expect(governance).toMatchObject({
			ok: true,
			payload: {
				pendingApprovals: expect.arrayContaining([
					expect.objectContaining({ approvalId: approval.id, href: `/app/work/decisions/${approval.id}` }),
				]),
			},
		});

		const approvalDetail = await json(await app.request(`/v1/ui/governance/${approval.id}`, { headers }));
		expect(approvalDetail).toMatchObject({
			ok: true,
			payload: {
				approval: expect.objectContaining({ approvalId: approval.id, title: 'Publish projection report' }),
				decisionOptions: expect.arrayContaining([expect.objectContaining({ id: 'approve' })]),
			},
		});

		const decided = await json(await app.request(`/v1/ui/governance/${approval.id}/decision`, {
			method: 'POST',
			headers: { ...headers, 'content-type': 'application/json' },
			body: JSON.stringify({ optionId: 'approve', note: 'Looks ready.' }),
		}));
		expect(decided).toMatchObject({
			ok: true,
			payload: expect.objectContaining({ id: approval.id, state: 'approved' }),
		});

		const infrastructure = await json(await app.request('/v1/ui/infrastructure', { headers }));
		expect(infrastructure).toMatchObject({ ok: true, payload: expect.any(Object) });

		const knowledge = await json(await app.request('/v1/ui/knowledge', { headers }));
		expect(knowledge).toMatchObject({ ok: true, payload: expect.objectContaining({ artifacts: expect.any(Array) }) });

		const workday = await json(await app.request('/v1/ui/workdays/ui-workday-1', { headers }));
		expect(workday).toMatchObject({
			ok: true,
			payload: {
				workday: expect.objectContaining({
					id: 'ui-workday-1',
					objective: 'Verify backend UI projections',
				}),
			},
		});

		const missingArtifact = await app.request('/v1/ui/knowledge/missing-artifact', { headers });
		expect(missingArtifact.status).toBe(404);
		expect(await json(missingArtifact)).toMatchObject({ ok: false, error: 'Unknown knowledge artifact.' });

		const anonymous = await app.request('/v1/ui/governance');
		expect(anonymous.status).toBe(401);
		expect(await json(anonymous)).toMatchObject({ ok: false });
	}, 30000);

	it('uses the configured production web approval URL for the central API', async () => {
		const app = createTestApp({
			config: {
				baseUrl: 'https://api.treeseed.ai',
				siteUrl: 'https://treeseed.ai',
			},
		});
		const started = await json(await app.request('/v1/auth/device/start', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ clientName: 'treeseed-cli', scopes: ['auth:me', 'market'] }),
		}));

		expect(started.verificationUri).toBe('https://treeseed.ai/auth/device/approve');
		expect(started.verificationUriComplete).toBe(`https://treeseed.ai/auth/device/approve?user_code=${encodeURIComponent(started.userCode)}`);
	});

	it('redirects legacy v1 browser approval links to the web approval page', async () => {
		const app = createTestApp({
			config: {
				baseUrl: 'https://api.treeseed.ai',
				siteUrl: 'https://treeseed.ai',
			},
		});

		const response = await app.request('/v1/auth/device/approve?user_code=ABCD-EFGH');

		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toBe('https://treeseed.ai/auth/device/approve?user_code=ABCD-EFGH');
	});

	it('signs editorial preview links for team-scoped overlays', async () => {
		const app = createTestApp({
			config: {
				baseUrl: 'https://market.example.com',
			},
		});
		const token = await authorizeApp(app);
		const { team } = await createTeamAndProject(app, token, {
			id: 'preview-project',
			slug: 'preview-project',
			name: 'Preview Project',
		});

		const response = await json(await app.request(`/v1/teams/${team.id}/content-previews`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				previewId: 'staging-abc123',
				expiresAt: '2030-01-01T00:00:00.000Z',
			}),
		}));

		expect(response.payload).toMatchObject({
			teamId: team.id,
			previewId: 'staging-abc123',
		});
		expect(response.payload.token).toContain('.');
		expect(response.payload.previewUrl).toContain('?preview=');
	});

	it('executes the managed project launch pipeline and persists launch topology', async () => {
		await withEnv({
			TREESEED_CLOUDFLARE_API_TOKEN: 'managed-token',
			TREESEED_CLOUDFLARE_ACCOUNT_ID: 'managed-account',
		}, async () => {
		executeKnowledgeHubProviderLaunchMock.mockResolvedValue({
			workingRoot: '/tmp/hub-provider-launch-success',
			repository: {
				slug: 'treeseed-ai/launch-project',
				owner: 'treeseed-ai',
				name: 'launch-project',
				url: 'https://github.com/treeseed-ai/launch-project',
				defaultBranch: 'main',
				stagingBranch: 'staging',
				visibility: 'private',
			},
			workflows: {
				repository: 'treeseed-ai/launch-project',
				workflows: [{ workflowPath: '.github/workflows/verify.yml', changed: true, workingDirectory: '.' }],
				secrets: { existing: [], created: ['TREESEED_API_WEB_SERVICE_SECRET'] },
				variables: { existing: [], created: ['TREESEED_API_BASE_URL'] },
			},
			cloudflare: {
				staging: {
					accountId: 'cf-account-1',
					workerName: 'launch-project-staging',
					siteUrl: 'https://launch-project-staging.pages.dev',
					pages: { projectName: 'launch-project-staging', url: 'https://launch-project-staging.pages.dev' },
					content: { bucketName: 'launch-project-staging-content' },
					siteDataDb: { databaseName: 'launch-project-staging-db' },
					queue: { name: 'launch-project-staging-queue' },
				},
				prod: {
					accountId: 'cf-account-1',
					workerName: 'launch-project',
					siteUrl: 'https://launch-project.pages.dev',
					pages: { projectName: 'launch-project', url: 'https://launch-project.pages.dev' },
					content: { bucketName: 'launch-project-content' },
					siteDataDb: { databaseName: 'launch-project-db' },
					queue: { name: 'launch-project-queue' },
				},
				verification: { ok: true },
			},
			railway: {
				services: [{
					key: 'api',
					scope: 'prod',
					projectName: 'launch-project',
					serviceName: 'launch-project-api',
					publicBaseUrl: 'https://launch-project-api.up.railway.app',
				}],
				deployments: [],
				schedules: [],
				verification: { ok: true },
			},
			projectApiBaseUrl: 'https://launch-project-api.up.railway.app',
			projectSiteUrl: 'https://launch-project.pages.dev',
			projectMetadata: {
				objectiveCount: 1,
				questionCount: 1,
				noteCount: 1,
				proposalCount: 1,
				decisionCount: 1,
				workstreams: [{
					id: 'launch-project:initial-launch',
					title: 'Initial launch',
				}],
			},
			defaultWorkstream: {
				id: 'launch-project:initial-launch',
				title: 'Initial launch',
				state: 'saved_remote',
			},
			phases: [
				{ phase: 'repo_provision', status: 'completed', detail: 'Created repository.', timestamp: '2026-04-16T00:00:00.000Z' },
				{ phase: 'content_bootstrap', status: 'completed', detail: 'Scaffolded starter template.', timestamp: '2026-04-16T00:00:01.000Z' },
				{ phase: 'host_binding_config', status: 'completed', detail: 'Applied host binding config.', timestamp: '2026-04-16T00:00:02.000Z' },
				{ phase: 'workflow_bootstrap', status: 'completed', detail: 'Installed workflows.', timestamp: '2026-04-16T00:00:03.000Z' },
				{ phase: 'hosting_registration', status: 'completed', detail: 'Provisioned Cloudflare.', timestamp: '2026-04-16T00:00:04.000Z' },
				{ phase: 'runtime_connection', status: 'completed', detail: 'Connected Railway runtime.', timestamp: '2026-04-16T00:00:05.000Z' },
			],
			templatePackage: {
				outputRoot: '/tmp/hub-provider-launch-success/template',
				payloadRoot: '/tmp/hub-provider-launch-success/template/payload',
				manifestPath: '/tmp/hub-provider-launch-success/template/manifest.json',
				files: ['package.json'],
				manifest: {
					schemaVersion: 1,
					kind: 'template',
					id: 'launch-project-template',
					title: 'Launch Project template',
					summary: 'Template package',
					version: '0.1.0',
					generatedAt: '2026-04-16T00:00:05.000Z',
					projectSlug: 'launch-project',
					sourceProjectRoot: '/tmp/hub-provider-launch-success',
					payloadRoot: 'payload',
					files: ['package.json'],
					compatibility: { minCliVersion: '0.1.0', minCoreVersion: '0.1.0', minSdkVersion: '0.1.0' },
					sourceSelection: { includedPaths: ['package.json'] },
					market: { publisherId: 'team-one', publisherName: 'Team One', publishMetadata: {} },
				},
			},
			knowledgePackPackage: {
				outputRoot: '/tmp/hub-provider-launch-success/knowledge-pack',
				payloadRoot: '/tmp/hub-provider-launch-success/knowledge-pack/payload',
				manifestPath: '/tmp/hub-provider-launch-success/knowledge-pack/manifest.json',
				files: ['src/content/objectives/launch.mdx'],
				manifest: {
					schemaVersion: 1,
					kind: 'knowledge_pack',
					id: 'launch-project-pack',
					title: 'Launch Project knowledge pack',
					summary: 'Knowledge pack',
					version: '0.1.0',
					generatedAt: '2026-04-16T00:00:05.000Z',
					projectSlug: 'launch-project',
					sourceProjectRoot: '/tmp/hub-provider-launch-success',
					payloadRoot: 'payload',
					files: ['src/content/objectives/launch.mdx'],
					compatibility: { minCliVersion: '0.1.0', minCoreVersion: '0.1.0', minSdkVersion: '0.1.0' },
					sourceSelection: { includedPaths: ['src/content/objectives'] },
					market: { publisherId: 'team-one', publisherName: 'Team One', publishMetadata: {} },
				},
			},
		} as unknown as Awaited<ReturnType<typeof treeseedCore.executeKnowledgeHubProviderLaunch>>);

		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);

		const launched = await app.request(`/v1/teams/${team.id}/projects/launch`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				slug: 'launch-project',
				name: 'Launch Project',
				coreObjective: '# Core Objective\n\nKeep launch work aligned around reliable project deployment.',
				sourceKind: 'template',
				sourceRef: 'research',
				hostingMode: 'managed',
			}),
		});

		expect(launched.status).toBe(202);
		const payload = await json(launched);
		expect(payload.ok).toBe(true);
		expect(payload.projectId).toBe(payload.payload.project.project.id);
		expect(payload.launchId).toBe(payload.payload.launch.id);
		expect(payload.operationId).toBe(payload.payload.launchJob.id);
		expect(payload.payload.deployments.some((deployment: { id: string }) => deployment.id === payload.deploymentId)).toBe(true);
		expect(payload.deploymentHref).toBe(`/app/projects/deployment/${payload.deploymentId}`);
		expect(payload.payload.project.project.slug).toBe('launch-project');
		expect(payload.payload.project.project.description).toBe('Core Objective Keep launch work aligned around reliable project deployment.');
		expect(payload.payload.project.project.metadata.coreObjective).toBe('# Core Objective\n\nKeep launch work aligned around reliable project deployment.');
		expect(payload.payload.project.project.metadata.templateLineage).toEqual([
			expect.objectContaining({
				kind: 'template',
				ref: 'research',
				source: 'project_launch',
			}),
		]);
		expect(payload.payload.project.latestLaunch.state).toBe('running');
		expect(payload.payload.launchJob.status).toBe('running');
		expect(payload.payload.launchJob.selectedTarget).toBe('api');
		expect(payload.payload.launchJob.input.credentialSessions).toBeUndefined();
		expect(payload.payload.deployments).toEqual(expect.arrayContaining([
			expect.objectContaining({ environment: 'staging', action: 'launch_project', status: 'running', platformOperationId: payload.operationId }),
			expect.objectContaining({ environment: 'prod', action: 'launch_project', status: 'running', platformOperationId: payload.operationId }),
		]));
		expect(payload.payload.launchJob.input.launchIntent.hub.coreObjective).toBe('# Core Objective\n\nKeep launch work aligned around reliable project deployment.');
		expect(payload.payload.launchJob.input.launchIntent.execution.providerLaunchInput.coreObjective).toBe('# Core Objective\n\nKeep launch work aligned around reliable project deployment.');
		expect(payload.payload.launchJob.input.launchIntent.execution.providerLaunchInput.hostBindingPlans.configWrites).toEqual(expect.arrayContaining([
			expect.objectContaining({
				target: 'treeseed.site.yaml',
				path: 'hosting.hostBindings.sourceRepository.provider',
				requirementKey: 'sourceRepository',
			}),
		]));
		expect(payload.payload.launchJob.input.launchIntent.execution.providerLaunchInput.hostBindings.publicWeb.provider).toBe('cloudflare');
		expect(executeKnowledgeHubProviderLaunchMock).not.toHaveBeenCalled();

		const deploymentDetail = await json(await app.request(`/v1/project-deployments/${payload.deploymentId}`, {
			headers: {
				authorization: `Bearer ${token}`,
			},
		}));
		expect(deploymentDetail.payload.deployment).toMatchObject({
			id: payload.deploymentId,
			projectId: payload.projectId,
			status: 'running',
			platformOperationId: payload.operationId,
		});
		expect(deploymentDetail.payload.events.some((event: { kind: string }) => event.kind === 'launch.bootstrap_started')).toBe(true);

		const details = await json(await app.request(`/v1/projects/${payload.payload.project.project.id}`, {
			headers: {
				authorization: `Bearer ${token}`,
			},
		}));
		expect(details.payload.repositories).toEqual(expect.arrayContaining([
			expect.objectContaining({ role: 'software', name: 'launch-project-site', status: 'queued' }),
			expect.objectContaining({ role: 'content', name: 'launch-project-content', status: 'queued' }),
		]));
		expect(details.payload.project.metadata.hostBindings).toMatchObject({
			sourceRepository: expect.objectContaining({
				requirementKey: 'sourceRepository',
				type: 'repository',
				provider: 'github',
			}),
			publicWeb: expect.objectContaining({
				requirementKey: 'publicWeb',
				type: 'web',
				provider: 'cloudflare',
			}),
		});
		expect(details.payload.hosting.metadata.hostBindings.publicWeb.provider).toBe('cloudflare');
		expect(payload.payload.launchJob.input.hostBindings.publicWeb.provider).toBe('cloudflare');
		expect(payload.payload.launchJob.input.launchIntent.hosting.hostBindings.publicWeb.provider).toBe('cloudflare');
		expect(details.payload.contentSource.productionSource).toBe('r2_published_artifacts');
		expect(details.payload.latestLaunch.state).toBe('running');
		const deploymentState = await json(await app.request(`/v1/projects/${payload.projectId}/deployment-state`, {
			headers: {
				authorization: `Bearer ${token}`,
			},
		}));
		expect(deploymentState.launch).toMatchObject({
			id: payload.launchId,
			jobId: payload.operationId,
			status: 'queued',
			active: true,
			deployHref: `/app/projects/deployment/${payload.deploymentId}`,
		});
		await store.retryJob(payload.operationId, { status: 'failed', eventType: 'failed' });
		await store.updateHubLaunch(payload.launchId, {
			state: 'failed',
			currentPhase: 'workflow_installing',
			error: {
				summary: 'Workflow installation failed.',
				inspectCommand: 'gh run view 123 --repo owner/repo --log-failed',
			},
		});
		await store.appendHubLaunchEvent(payload.launchId, {
			phase: 'workflow_installing',
			status: 'failed',
			title: 'Workflow installation failed',
			summary: 'Workflow installation failed.',
		});
		const failedState = await json(await app.request(`/v1/projects/${payload.projectId}/deployment-state`, {
			headers: {
				authorization: `Bearer ${token}`,
			},
		}));
		expect(failedState.launch).toMatchObject({
			status: 'failed',
			active: false,
			error: {
				summary: 'Workflow installation failed.',
				inspectCommand: 'gh run view 123 --repo owner/repo --log-failed',
			},
		});
		expect(failedState.launch.actions.map((action: { action: string }) => action.action)).toEqual(['retry_launch', 'resume_launch']);
		expect(failedState.nextAction).toMatchObject({ code: 'launch_recovery', action: 'retry_launch' });
		const resumed = await app.request(`/v1/jobs/${payload.operationId}/resume`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
			},
		});
		expect(resumed.status).toBe(202);
		const resumedState = await json(await app.request(`/v1/projects/${payload.projectId}/deployment-state`, {
			headers: {
				authorization: `Bearer ${token}`,
			},
		}));
		expect(resumedState.launch.status).not.toBe('failed');
		expect(['credential_bootstrap', 'hosting_readiness_audit', 'provider_bootstrap', 'launch_completed']).toContain(resumedState.launch.currentPhase);
		if (resumedState.launch.status === 'completed') {
			expect(resumedState.launch.active).toBe(false);
		} else {
			expect(resumedState.launch.active).toBe(true);
		}

		expect(await waitForCondition(async () => {
			const inbox = await json(await app.request(`/v1/teams/${team.id}/inbox`, {
				headers: {
					authorization: `Bearer ${token}`,
				},
			}));
			return inbox.payload.some((entry: { kind: string }) => entry.kind === 'launch_failure');
		}, 8000)).toBe(true);
		});
	}, 30000);

	it('keeps managed project launch bootstrap owned by the API instead of the runner', async () => {
		await withEnv({
			TREESEED_CLOUDFLARE_API_TOKEN: 'managed-token',
			TREESEED_CLOUDFLARE_ACCOUNT_ID: 'managed-account',
		}, async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({
			db,
			store,
			config: {
				platformRunnerSecret: 'platform-runner-secret',
			},
		});
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);

		const launched = await json(await app.request(`/v1/teams/${team.id}/projects/launch`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({
				slug: 'runner-launch-project',
				name: 'Runner Launch Project',
				coreObjective: '# Core Objective\n\nVerify managed launch jobs are picked up.',
				sourceKind: 'template',
				sourceRef: 'research',
				hostingMode: 'managed',
			}),
		}));
		expect(launched.payload.launchJob.selectedTarget).toBe('api');
		expect(launched.payload.launchJob.status).toBe('running');
		expect(launched.payload.launchJob.input.credentialSessions).toBeUndefined();
		expect(await store.pullManagedLaunchJobs({ runnerId: 'treeseed-ops-launch-runner-01', limit: 5 })).toEqual([]);
		const job = await json(await app.request(`/v1/jobs/${launched.operationId}`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(job.payload.status).toBe('running');
		const state = await json(await app.request(`/v1/projects/${launched.projectId}/deployment-state`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(state.launch).toMatchObject({
			status: 'queued',
			active: true,
			currentPhase: 'credential_bootstrap',
		});
		});
	}, 60000);

	it('exchanges GitHub OIDC for managed operation jobs without exposing provider secrets', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);

		const launched = await json(await app.request(`/v1/teams/${team.id}/projects/launch`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				slug: 'ci-managed-project',
				name: 'CI Managed Project',
				sourceKind: 'blank',
				hostingMode: 'managed',
			}),
		}));
		const projectId = launched.payload.project.project.id as string;
		const details = await json(await app.request(`/v1/projects/${projectId}`, {
			headers: {
				authorization: `Bearer ${token}`,
			},
		}));
		const softwareRepository = details.payload.repositories.find((repository: { role: string }) => repository.role === 'software');
		const repository = `${softwareRepository.owner}/${softwareRepository.name}`.toLowerCase();
		const now = Math.floor(Date.now() / 1000);
		const oidcToken = unsignedTestJwt({
			iss: 'https://token.actions.githubusercontent.com',
			aud: `treeseed:${projectId}`,
			exp: now + 300,
			nbf: now - 10,
			repository,
			ref: 'refs/heads/staging',
			ref_name: 'staging',
			sha: '1234567890abcdef1234567890abcdef12345678',
			workflow: 'Treeseed Web Deploy',
			workflow_ref: `${repository}/.github/workflows/deploy-web.yml@refs/heads/staging`,
			run_id: '1001',
			run_attempt: '1',
			actor: 'octocat',
			event_name: 'push',
		});

		const exchanged = await app.request(`/v1/projects/${projectId}/ci/oidc/exchange`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				oidcToken,
				actionKind: 'deploy_web',
				environment: 'staging',
				sha: '1234567890abcdef1234567890abcdef12345678',
			}),
		});
		expect(exchanged.status).toBe(202);
		const payload = await json(exchanged);
		expect(payload.payload.job).toMatchObject({
			projectId,
			namespace: 'workflow',
			operation: 'deploy_runtime',
			requestedByType: 'ci_oidc',
			requestedById: repository,
		});
		expect(payload.payload.operationToken).toContain('.');
		expect(JSON.stringify(payload)).not.toContain('TREESEED_CLOUDFLARE_API_TOKEN');
		expect(JSON.stringify(payload)).not.toContain('TREESEED_RAILWAY_API_TOKEN');
		expect(JSON.stringify(payload)).not.toContain('TREESEED_SMTP_PASSWORD');

		const status = await app.request(`/v1/projects/${projectId}/ci/jobs/${payload.payload.job.id}`, {
			headers: {
				authorization: `Bearer ${payload.payload.operationToken}`,
			},
		});
		expect(status.status).toBe(200);
		const statusPayload = await json(status);
		expect(statusPayload.payload.job.id).toBe(payload.payload.job.id);
		expect(statusPayload.payload.job.input.managedHostExecution).toMatchObject({
			mode: 'treeseed_managed',
			credentialExposure: 'none',
		});

		const mismatchedToken = unsignedTestJwt({
			iss: 'https://token.actions.githubusercontent.com',
			aud: `treeseed:${projectId}`,
			exp: now + 300,
			repository: 'other-owner/other-repo',
			ref: 'refs/heads/staging',
			workflow_ref: 'other-owner/other-repo/.github/workflows/deploy-web.yml@refs/heads/staging',
		});
		const rejected = await app.request(`/v1/projects/${projectId}/ci/oidc/exchange`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				oidcToken: mismatchedToken,
				actionKind: 'deploy_web',
				environment: 'staging',
			}),
		});
		expect(rejected.status).toBe(403);
	}, 60000);

	it('queues launch failures for worker recovery instead of failing the request', async () => {
		runTreeseedHostingAuditMock.mockResolvedValueOnce({
			ok: false,
			environment: 'staging',
			requestedEnvironment: 'current',
			repairMode: false,
			repaired: false,
			target: { kind: 'persistent', scope: 'staging', label: 'staging' },
			hostKinds: ['repository', 'web'],
			checkedAt: '2026-01-01T00:00:00.000Z',
			checks: [],
			missingConfig: ['TREESEED_CLOUDFLARE_ACCOUNT_ID'],
			resources: {},
			warnings: [],
			blockers: [{ code: 'missing_config', message: 'Cloudflare account is not configured.' }],
			nextActions: ['Configure Cloudflare before launching.'],
		} as any);

		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);

		const launched = await app.request(`/v1/teams/${team.id}/projects/launch`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				slug: 'failed-launch',
				name: 'Failed Launch',
				sourceKind: 'blank',
				hostingMode: 'managed',
			}),
		});

		expect(launched.status).toBe(202);
		const payload = await json(launched);
		expect(payload.ok).toBe(true);
		expect(payload.payload.launchJob.status).toBe('running');
		expect(payload.payload.project.project.metadata.launchPhase).toBe('queued');
		expect(await waitForCondition(async () => {
			const job = await store.findJobById(payload.operationId);
			return job?.status === 'failed';
		}, 8000)).toBe(true);

		const inbox = await json(await app.request(`/v1/teams/${team.id}/inbox`, {
			headers: {
				authorization: `Bearer ${token}`,
			},
		}));
		expect(inbox.payload.some((entry: { kind: string; title: string }) => entry.kind === 'launch_failure' && entry.title.includes('Failed Launch'))).toBe(true);
	}, 60000);

	it('manages capacity providers, lanes, grants, and project plans', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const { team, project } = await createTeamAndProject(app, token, {
			slug: 'capacity-project',
			name: 'Capacity Project',
		});

		const providerResponse = await app.request(`/v1/teams/${team.id}/capacity-providers`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				name: 'OpenRouter Pool',
				launchMode: 'self_hosted',
			}),
		});
		expect(providerResponse.status).toBe(201);
		const createdPayload = await json(providerResponse);
		const provider = createdPayload.provider;
		expect(provider).toMatchObject({ creditBudgetMode: 'derived', dailyCreditBudget: 0, monthlyCreditBudget: 0 });
		expect(createdPayload.selfHosting.env).toMatchObject({
			TREESEED_MANAGEMENT_API_URL: 'http://localhost:4321',
			TREESEED_MARKET_URL: 'http://localhost:4321',
			TREESEED_CAPACITY_PROVIDER_ID: provider.id,
			TREESEED_CAPACITY_PROVIDER_TEAM_ID: team.id,
		});
		expect(createdPayload.selfHosting.redactedEnv.TREESEED_CAPACITY_PROVIDER_API_KEY).toContain('<redacted>');

		const laneResponse = await app.request(`/v1/teams/${team.id}/capacity-providers/${provider.id}/lanes`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				name: 'Cheap summaries',
				businessModel: 'token_metered',
				unit: 'token_usd',
				scarcityLevel: 'low',
				modelClass: 'small',
			}),
		});
		expect(laneResponse.status).toBe(201);
		const lane = (await json(laneResponse)).payload;

		const grantResponse = await app.request(`/v1/teams/${team.id}/capacity-grants`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				capacityProviderId: provider.id,
				laneId: lane.id,
				grantScope: 'project',
				projectId: project.id,
				environment: 'staging',
				dailyCreditLimit: 120,
				dailyUsdLimit: 2,
			}),
		});
		expect(grantResponse.status).toBe(201);

		const plan = await json(await app.request(`/v1/projects/${project.id}/capacity-plan?environment=staging`, {
			headers: {
				authorization: `Bearer ${token}`,
			},
		}));
		expect(plan.payload.providers[0]).toMatchObject({ id: provider.id, provider: '@treeseed/agent' });
		expect(plan.payload.lanes[0]).toMatchObject({ id: lane.id, businessModel: 'token_metered' });
		expect(plan.payload.providers[0].metadata.pressure).toMatchObject({
			activeReservations: 0,
			congestionRatio: 0,
			activeAttentionLoad: 0,
			activeContextTokens: 0,
			cooperative: expect.objectContaining({
				spilloverEligible: false,
			}),
		});
		expect(plan.payload.lanes[0].metadata.pressure).toMatchObject({
			activeReservations: 0,
			congestionRatio: 0,
			activeAttentionLoad: 0,
			activeContextTokens: 0,
			cooperative: expect.any(Object),
		});
		expect(plan.payload.remaining.dailyCredits).toBe(120);
	});

	it('persists Phase 1 agent capacity coordination records without replacing task claim flow', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const token = await authorizeApp(app);
		const { team, project } = await createTeamAndProject(app, token, {
			slug: 'agent-capacity-a',
			name: 'Agent Capacity A',
		});
		const secondProject = (await json(await app.request(`/v1/teams/${team.id}/projects`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ slug: 'agent-capacity-b', name: 'Agent Capacity B' }),
		}))).payload.project;
		const headers = {
			'content-type': 'application/json',
			authorization: `Bearer ${token}`,
		};

		const createdProvider = await json(await app.request(`/v1/teams/${team.id}/capacity-providers`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				name: 'Local Generic Capacity',
				launchMode: 'self_hosted',
			}),
		}));
		const provider = createdProvider.provider;
		const lane = (await json(await app.request(`/v1/teams/${team.id}/capacity-providers/${provider.id}/lanes`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				id: `${provider.id}:codex-seat`,
				name: 'Codex Seat',
				businessModel: 'subscription_quota',
				unit: 'wall_minute',
				scarcityLevel: 'high',
			}),
		}))).payload;
		const executionProvider = (await json(await app.request(`/v1/teams/${team.id}/capacity-providers/${provider.id}/execution-providers`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				id: 'openai-like-codex-seat',
				name: 'OpenAI-like Codex Seat',
				kind: 'codex_subscription',
				nativeUnit: 'wall_minute',
				quotaVisibility: 'opaque',
				maxConcurrentWorkers: 1,
			}),
		}))).payload;
		const grant = (await json(await app.request(`/v1/teams/${team.id}/capacity-grants`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				capacityProviderId: provider.id,
				laneId: lane.id,
					grantScope: 'project',
					projectId: project.id,
					environment: 'local',
					dailyCreditLimit: 20,
				}),
			}))).payload;
			const actingGrant = (await json(await app.request(`/v1/teams/${team.id}/capacity-grants`, {
				method: 'POST',
				headers,
				body: JSON.stringify({
					capacityProviderId: provider.id,
					laneId: lane.id,
					grantScope: 'project',
					projectId: secondProject.id,
					environment: 'local',
					dailyCreditLimit: 20,
				}),
			}))).payload;

		const allocationSet = (await json(await app.request(`/v1/teams/${team.id}/capacity/allocation-sets`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				version: 'phase-1-fixture',
				policy: { source: 'phase_1_test', capacity: 'generic', agents: 'project_focused' },
				slices: [
					{ projectId: project.id, capacityProviderId: provider.id, laneId: lane.id, percent: 60 },
					{ projectId: secondProject.id, capacityProviderId: provider.id, laneId: lane.id, percent: 40 },
				],
			}),
		}))).payload;
		expect(allocationSet).toMatchObject({ status: 'draft', slices: expect.arrayContaining([expect.objectContaining({ projectId: project.id })]) });
		const activated = (await json(await app.request(`/v1/teams/${team.id}/capacity/allocation-sets/${allocationSet.id}/activate`, {
			method: 'POST',
			headers,
		}))).payload;
		expect(activated.status).toBe('active');

		const planningClass = (await json(await app.request(`/v1/projects/${project.id}/agent-classes`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				slug: 'planner',
				name: 'Planning Agent',
				allowedModes: ['planning'],
				requiredCapabilities: ['repo_read'],
				handlerRefs: { planning: '@project/agents/planner' },
			}),
		}))).payload;
		const actingClass = (await json(await app.request(`/v1/projects/${secondProject.id}/agent-classes`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				slug: 'implementer',
				name: 'Implementation Agent',
				allowedModes: ['acting'],
				requiredCapabilities: ['repo_write'],
				handlerRefs: { acting: '@project/agents/implementer' },
			}),
		}))).payload;
		expect(planningClass).toMatchObject({ projectId: project.id, slug: 'planner', allowedModes: ['planning'] });
		expect(actingClass).toMatchObject({ projectId: secondProject.id, slug: 'implementer', allowedModes: ['acting'] });

		const registration = await json(await app.request('/v1/provider/register', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${createdProvider.apiKey.plaintext}`,
			},
			body: JSON.stringify({
				runtime: { package: '@treeseed/agent', version: 'test', roles: ['api', 'manager', 'runner'] },
				capabilities: ['repo_read', 'repo_write'],
				budgets: {},
				health: { ok: true },
			}),
		}));
		const providerHeaders = {
			'content-type': 'application/json',
			authorization: `Bearer ${registration.sessionToken}`,
		};
		const availabilitySession = (await json(await app.request('/v1/provider/sessions', {
			method: 'POST',
			headers: providerHeaders,
			body: JSON.stringify({
					environment: 'local',
					executionProviders: [executionProvider],
					capabilities: ['repo_read', 'repo_write'],
					grants: [grant],
					runnerPressure: { activeWorkers: 0, queuedAssignments: 0 },
				}),
		}))).payload;
		expect(availabilitySession).toMatchObject({
			capacityProviderId: provider.id,
			status: 'open',
			executionProviders: [expect.objectContaining({ id: executionProvider.id })],
		});

		const reservation = await store.createCapacityReservation({
			capacityProviderId: provider.id,
			executionProviderId: executionProvider.id,
			laneId: lane.id,
			teamId: team.id,
			projectId: project.id,
			state: 'reserved',
			reservedCredits: 5,
			nativeUnit: 'wall_minute',
			reservedNativeAmount: 30,
			allocationSetId: allocationSet.id,
			projectAgentClassId: planningClass.id,
			mode: 'planning',
		});

		const planningAssignment = (await json(await app.request(`/v1/teams/${team.id}/capacity/assignments`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				projectId: project.id,
				capacityProviderId: provider.id,
				providerSessionId: availabilitySession.id,
				executionProviderId: executionProvider.id,
				allocationSetId: allocationSet.id,
				projectAgentClassId: planningClass.id,
				reservationId: reservation.id,
				mode: 'planning',
				capacityEnvelope: { teamId: team.id, projectId: project.id, mode: 'planning', reservedCredits: 5 },
				decisionInput: { kind: 'plan', prompt: 'Create an implementation plan.' },
			}),
		}))).payload;
		expect(planningAssignment).toMatchObject({ mode: 'planning', projectAgentClassId: planningClass.id, reservationId: reservation.id });

		const providerAssignment = (await json(await app.request(`/v1/provider/assignments/${planningAssignment.id}`, {
			headers: providerHeaders,
		}))).payload;
		expect(providerAssignment).toMatchObject({ id: planningAssignment.id, capacityProviderId: provider.id, status: 'pending', leaseState: 'unleased' });

		const checkIn = (await json(await app.request('/v1/provider/check-in', {
			method: 'POST',
			headers: providerHeaders,
			body: JSON.stringify({
					environment: 'local',
					executionProviders: [executionProvider],
					capabilities: ['repo_read', 'repo_write'],
					grants: [grant, actingGrant],
					nativeLimits: { wallMinutes: { daily: 240 } },
				runnerPressure: { activeRunners: 0, maxConcurrentRunners: 1 },
				constraints: { outboundOnly: true },
			}),
		}))).payload;
		expect(checkIn).toMatchObject({ capacityProviderId: provider.id, status: 'open' });

		const leased = await json(await app.request('/v1/provider/assignments/next', {
			method: 'POST',
			headers: providerHeaders,
			body: JSON.stringify({ sessionId: checkIn.id, runnerId: 'runner-phase-2', leaseSeconds: 60 }),
		}));
		expect(leased).toMatchObject({
			ok: true,
			payload: {
				id: planningAssignment.id,
				status: 'leased',
				leaseState: 'leased',
				runnerId: 'runner-phase-2',
			},
			leaseToken: expect.any(String),
		});

		const badRenew = await app.request(`/v1/provider/assignments/${planningAssignment.id}/renew`, {
			method: 'POST',
			headers: providerHeaders,
			body: JSON.stringify({ runnerId: 'runner-phase-2', leaseToken: 'wrong-token', leaseSeconds: 60 }),
		});
		expect(badRenew.status).toBe(409);
		const renewed = await json(await app.request(`/v1/provider/assignments/${planningAssignment.id}/renew`, {
			method: 'POST',
			headers: providerHeaders,
			body: JSON.stringify({ runnerId: 'runner-phase-2', leaseToken: leased.leaseToken, leaseSeconds: 60 }),
		}));
		expect(renewed.payload).toMatchObject({ id: planningAssignment.id, status: 'leased', leaseToken: leased.leaseToken });

		const returned = await json(await app.request(`/v1/provider/assignments/${planningAssignment.id}/return`, {
			method: 'POST',
			headers: providerHeaders,
			body: JSON.stringify({ runnerId: 'runner-phase-2', leaseToken: leased.leaseToken, reason: 'provider pressure changed' }),
		}));
		expect(returned.payload).toMatchObject({
			id: planningAssignment.id,
			status: 'returned',
			leaseState: 'released',
			lifecycleReason: 'provider pressure changed',
			attemptCount: 1,
		});

		const released = await json(await app.request('/v1/provider/assignments/next', {
			method: 'POST',
			headers: providerHeaders,
			body: JSON.stringify({ sessionId: checkIn.id, runnerId: 'runner-phase-2b', leaseSeconds: 60 }),
		}));
		expect(released.payload).toMatchObject({
			id: planningAssignment.id,
			status: 'leased',
			leaseState: 'leased',
			runnerId: 'runner-phase-2b',
		});

		const usage = await store.createTaskUsageActual({
			projectId: project.id,
			taskSignature: 'agent.planning.phase1',
			executionProfileId: 'standard-code-model',
			capacityProviderId: provider.id,
			executionProviderId: executionProvider.id,
			laneId: lane.id,
			businessModel: 'subscription_quota',
			wallMinutes: 3,
			actualCredits: 1,
			actualCreditsOverride: true,
			assignmentId: planningAssignment.id,
			mode: 'planning',
			nativeUsage: { nativeUnit: 'wall_minute', amount: 3, source: 'phase_1_test' },
		});
		const modeRun = (await json(await app.request(`/v1/provider/assignments/${planningAssignment.id}/mode-runs`, {
			method: 'POST',
			headers: providerHeaders,
			body: JSON.stringify({
				status: 'succeeded',
				selectedInput: { prompt: 'Create an implementation plan.' },
				outputs: { summary: 'Plan created.' },
				usageActualId: usage.id,
				usageActual: { taskUsageActualId: usage.id, actualCredits: usage.actualCredits },
				traceRefs: { agentRunTraceId: 'trace-phase-1' },
			}),
		}))).payload;
		expect(modeRun).toMatchObject({
			providerAssignmentId: planningAssignment.id,
			mode: 'planning',
			status: 'succeeded',
			usageActual: { taskUsageActualId: usage.id, actualCredits: 1 },
		});

		const completed = await json(await app.request(`/v1/provider/assignments/${planningAssignment.id}/complete`, {
			method: 'POST',
			headers: providerHeaders,
			body: JSON.stringify({
				runnerId: 'runner-phase-2b',
				leaseToken: released.leaseToken,
				modeRunId: modeRun.id,
				usageActualId: usage.id,
				output: { summary: 'Plan created.' },
			}),
		}));
		expect(completed.payload).toMatchObject({
			id: planningAssignment.id,
			status: 'completed',
			leaseState: 'released',
			lifecycleOutput: { summary: 'Plan created.' },
		});

		const actingAssignment = (await json(await app.request(`/v1/teams/${team.id}/capacity/assignments`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				projectId: secondProject.id,
				capacityProviderId: provider.id,
				providerSessionId: availabilitySession.id,
				executionProviderId: executionProvider.id,
				allocationSetId: allocationSet.id,
				projectAgentClassId: actingClass.id,
				mode: 'acting',
				capacityEnvelope: {
					teamId: team.id,
					projectId: secondProject.id,
					mode: 'acting',
					metadata: { capacityPlanId: 'manual-phase-1-plan', capacityPlanStatus: 'accepted' },
				},
				decisionInput: {
					kind: 'act',
					task: 'Apply a focused change.',
					metadata: { capacityPlanId: 'manual-phase-1-plan', capacityPlanStatus: 'accepted' },
				},
				metadata: { capacityPlanId: 'manual-phase-1-plan', capacityPlanStatus: 'accepted' },
			}),
		}))).payload;
		expect(actingAssignment).toMatchObject({ mode: 'acting', projectAgentClassId: actingClass.id });

		const actingCheckIn = (await json(await app.request('/v1/provider/check-in', {
			method: 'POST',
			headers: providerHeaders,
			body: JSON.stringify({
				environment: 'local',
				executionProviders: [executionProvider],
				capabilities: ['repo_read', 'repo_write'],
				grants: [grant, actingGrant],
				nativeLimits: { wallMinutes: { daily: 240 } },
				runnerPressure: { activeRunners: 0, maxConcurrentRunners: 1 },
				constraints: { outboundOnly: true },
			}),
		}))).payload;
		expect(actingCheckIn).toMatchObject({ capacityProviderId: provider.id, status: 'open' });

		const leasedActing = await json(await app.request('/v1/provider/assignments/next', {
			method: 'POST',
			headers: providerHeaders,
			body: JSON.stringify({ sessionId: actingCheckIn.id, runnerId: 'runner-phase-2c', leaseSeconds: 60 }),
		}));
		expect(leasedActing.payload).toMatchObject({ id: actingAssignment.id, status: 'leased', leaseState: 'leased' });
		const retryableFailure = await json(await app.request(`/v1/provider/assignments/${actingAssignment.id}/fail`, {
			method: 'POST',
			headers: providerHeaders,
			body: JSON.stringify({
				runnerId: 'runner-phase-2c',
				leaseToken: leasedActing.leaseToken,
				code: 'provider_pressure',
				message: 'Runner pressure changed.',
				retryable: true,
			}),
		}));
		expect(retryableFailure.payload).toMatchObject({
			id: actingAssignment.id,
			status: 'returned',
			leaseState: 'released',
			lifecycleCode: 'provider_pressure',
		});

			const [sessions, assignments, modeRuns, removedClaimResponse] = await Promise.all([
				json(await app.request(`/v1/teams/${team.id}/capacity/provider-sessions`, { headers })),
				json(await app.request(`/v1/teams/${team.id}/capacity/assignments`, { headers })),
				json(await app.request(`/v1/projects/${project.id}/agent-mode-runs`, { headers })),
				app.request(['/v1/provider', 'tasks', 'claim'].join('/'), {
					method: 'POST',
					headers: providerHeaders,
					body: JSON.stringify({ limit: 1 }),
				}),
			]);
			expect(sessions.payload.map((entry: { id: string }) => entry.id)).toContain(availabilitySession.id);
			expect(assignments.payload.map((entry: { id: string }) => entry.id)).toEqual(expect.arrayContaining([planningAssignment.id, actingAssignment.id]));
			expect(modeRuns.payload.map((entry: { id: string }) => entry.id)).toContain(modeRun.id);
			expect(removedClaimResponse.status).toBe(404);

		const workday = (await json(await app.request('/v1/workdays', {
			method: 'POST',
			headers,
			body: JSON.stringify({
				id: 'architecture-gap-workday',
				projectId: secondProject.id,
				availableCredits: 12,
				modeSplits: { planning: 0.4, acting: 0.6 },
				caps: { hardDailyCredits: 12 },
				reserves: { emergencyCredits: 2 },
			}),
		}))).payload;
		expect(workday).toMatchObject({ id: 'architecture-gap-workday', status: 'draft', projectId: secondProject.id });
		const startedWorkday = (await json(await app.request(`/v1/workdays/${workday.id}/start`, {
			method: 'POST',
			headers,
		}))).payload;
		expect(startedWorkday.status).toBe('active');

		const decisionInput = (await json(await app.request('/v1/decisions/decision-architecture-gap/execution-inputs', {
			method: 'POST',
			headers,
			body: JSON.stringify({
				projectId: secondProject.id,
				projectAgentClassId: actingClass.id,
				mode: 'acting',
				status: 'accepted',
				input: {
					agentId: 'implementer',
					projectAgentClassId: actingClass.id,
					mode: 'acting',
					capacity: {
						teamId: team.id,
						projectId: secondProject.id,
						workDayId: workday.id,
						mode: 'acting',
						projectAgentClassId: actingClass.id,
					},
					input: { objective: 'Execute approved decision.' },
				},
			}),
		}))).payload;
		expect(decisionInput).toMatchObject({ status: 'accepted', decisionId: 'decision-architecture-gap' });
		const planningStatus = await json(await app.request('/v1/decisions/decision-architecture-gap/planning-status', { headers }));
		expect(planningStatus.payload).toMatchObject({ executionReadiness: 'ready', planningInputsStatus: 'complete' });

		const draftCapacityPlan = (await json(await app.request('/v1/decisions/decision-architecture-gap/capacity-plans', {
			method: 'POST',
			headers,
			body: JSON.stringify({
				projectId: secondProject.id,
				workDayId: workday.id,
				allocationSetId: allocationSet.id,
				metadata: { priorityRationale: 'Accepted decision is ready for acting.' },
			}),
		}))).payload;
		expect(draftCapacityPlan).toMatchObject({
			status: 'draft',
			decisionId: 'decision-architecture-gap',
			workUnits: [expect.objectContaining({ decisionExecutionInputId: decisionInput.id, mode: 'acting' })],
		});
		const acceptedCapacityPlan = (await json(await app.request(`/v1/capacity-plans/${draftCapacityPlan.id}/accept`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ reason: 'acceptance proof' }),
		}))).payload;
		expect(acceptedCapacityPlan).toMatchObject({ id: draftCapacityPlan.id, status: 'accepted' });

			const synthesisCheckIn = (await json(await app.request('/v1/provider/check-in', {
				method: 'POST',
				headers: providerHeaders,
				body: JSON.stringify({
					environment: 'local',
					executionProviders: [executionProvider],
					capabilities: ['repo_read', 'repo_write'],
					grants: [grant, actingGrant],
				}),
			}))).payload;
			const synthesized = await json(await app.request('/v1/provider/assignments/next', {
				method: 'POST',
				headers: providerHeaders,
				body: JSON.stringify({ sessionId: synthesisCheckIn.id, runnerId: 'runner-synthesis', leaseSeconds: 60 }),
			}));
		expect(synthesized.payload).toMatchObject({
			status: 'leased',
			mode: 'acting',
			synthesizedFrom: 'capacity_plan',
			decisionId: 'decision-architecture-gap',
			projectAgentClassId: actingClass.id,
		});
		const explanation = await json(await app.request(`/v1/teams/${team.id}/capacity/assignments/${synthesized.payload.id}/explanation`, { headers }));
		expect(explanation.payload).toMatchObject({
			source: 'capacity_plan',
			eligible: true,
			reasons: expect.arrayContaining(['accepted capacity plan work unit and ready decision status']),
		});
		const workdaySummary = await json(await app.request(`/v1/workdays/${workday.id}/summary`, { headers }));
		expect(workdaySummary.payload.settlement).toMatchObject({
			projectId: secondProject.id,
			providerConfidence: expect.any(String),
		});
	});

	it('requires static capacity mode to be explicit compatibility state', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const { team } = await createTeamAndProject(app, token, {
			slug: 'explicit-static-capacity',
			name: 'Explicit Static Capacity',
		});
		const headers = {
			'content-type': 'application/json',
			authorization: `Bearer ${token}`,
		};

		const created = await json(await app.request(`/v1/teams/${team.id}/capacity-providers`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				name: 'Static Compatibility Provider',
				launchMode: 'self_hosted',
				creditBudgetMode: 'static',
			}),
		}));
		expect(created.provider).toMatchObject({ creditBudgetMode: 'static' });

		const patched = await json(await app.request(`/v1/teams/${team.id}/capacity-providers/${created.provider.id}`, {
			method: 'PATCH',
			headers,
			body: JSON.stringify({
				name: 'Hybrid Compatibility Provider',
				creditBudgetMode: 'hybrid',
			}),
		}));
		expect(patched.provider).toMatchObject({
			name: 'Hybrid Compatibility Provider',
			creditBudgetMode: 'hybrid',
		});
	});

	it('stores native execution provider capacity through backend API routes', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const token = await authorizeApp(app);
		const { team, project } = await createTeamAndProject(app, token, {
			slug: 'native-capacity-project',
			name: 'Native Capacity Project',
		});
		const headers = {
			'content-type': 'application/json',
			authorization: `Bearer ${token}`,
		};
		const createdProvider = await json(await app.request(`/v1/teams/${team.id}/capacity-providers`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				name: 'Native Capacity Provider',
				launchMode: 'self_hosted',
			}),
		}));
		const provider = createdProvider.provider;
		const registration = await json(await app.request('/v1/provider/register', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${createdProvider.apiKey.plaintext}`,
			},
			body: JSON.stringify({
				runtime: { package: '@treeseed/agent', version: 'test', entrypoint: 'test', roles: ['api', 'manager', 'runner'] },
				capabilities: [],
				budgets: {},
				health: { dataDirWritable: true },
			}),
		}));
		expect(registration.sessionToken).toMatch(/^tsp_/);
		await store.upsertCapacityProvider(team.id, {
			...provider,
			status: 'active',
			maxConcurrentWorkers: 4,
		});

		const codex = await json(await app.request(`/v1/teams/${team.id}/capacity-providers/${provider.id}/execution-providers`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				id: 'codex-seat',
				name: 'Codex Pro Seat',
				kind: 'codex_subscription',
				nativeUnit: 'wall_minute',
				quotaVisibility: 'opaque',
				maxConcurrentWorkers: 1,
				resetCadence: 'daily',
				nativeLimits: [{
					scope: 'daily',
					nativeUnit: 'wall_minute',
					limitAmount: 240,
					reserveBufferPercent: 25,
					confidence: 'estimated',
					source: 'configured',
				}],
			}),
		}));
		expect(codex.payload).toMatchObject({
			id: 'codex-seat',
			kind: 'codex_subscription',
			nativeUnit: 'wall_minute',
			quotaVisibility: 'opaque',
			nativeLimits: [expect.objectContaining({
				scope: 'daily',
				limitAmount: 240,
				reserveBufferPercent: 25,
			})],
		});

		const openRouter = await json(await app.request(`/v1/teams/${team.id}/capacity-providers/${provider.id}/execution-providers`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				id: 'openrouter-budget',
				name: 'OpenRouter Budget',
				kind: 'token_metered_api',
				nativeUnit: 'usd',
				quotaVisibility: 'exact',
				maxConcurrentWorkers: 2,
				nativeLimits: [{
					scope: 'daily',
					nativeUnit: 'usd',
					limitAmount: 3,
					reserveBufferPercent: 10,
					confidence: 'exact',
					source: 'configured',
				}],
			}),
		}));
		expect(openRouter.payload).toMatchObject({
			id: 'openrouter-budget',
			nativeUnit: 'usd',
			nativeLimits: [expect.objectContaining({ limitAmount: 3 })],
		});

		const extraLimit = await json(await app.request(`/v1/teams/${team.id}/capacity-providers/${provider.id}/execution-providers/codex-seat/native-limits`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				scope: 'monthly',
				nativeUnit: 'wall_minute',
				limitAmount: 5280,
				reserveBufferPercent: 25,
			}),
		}));
		expect(extraLimit.payload).toMatchObject({ scope: 'monthly', limitAmount: 5280 });

		const listed = await json(await app.request(`/v1/teams/${team.id}/capacity-providers/${provider.id}/execution-providers`, { headers }));
		expect(listed.payload.map((entry: any) => entry.id)).toEqual(expect.arrayContaining(['codex-seat', 'openrouter-budget']));
		expect(listed.payload.find((entry: any) => entry.id === 'codex-seat').nativeLimits).toEqual(expect.arrayContaining([
			expect.objectContaining({ scope: 'daily' }),
			expect.objectContaining({ scope: 'monthly' }),
		]));

		const providerDetail = await json(await app.request(`/v1/teams/${team.id}/capacity-providers/${provider.id}`, { headers }));
		expect(providerDetail.provider).toMatchObject({
			id: provider.id,
			creditBudgetMode: 'derived',
			dailyCreditBudget: 0,
			monthlyCreditBudget: 0,
		});

		const lane = (await json(await app.request(`/v1/teams/${team.id}/capacity-providers/${provider.id}/lanes`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				id: 'native-derived-lane',
				name: 'Native derived lane',
			}),
		}))).payload;
		const portfolioGrant = await json(await app.request(`/v1/teams/${team.id}/capacity-grants`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				capacityProviderId: provider.id,
				laneId: lane.id,
				grantScope: 'project',
				projectId: project.id,
				environment: 'staging',
				portfolioAllocationPercent: 50,
				reservePoolPercent: 10,
				maxDailyProjectCredits: 100,
				emergencyOverride: true,
			}),
		}));
		expect(portfolioGrant.payload).toMatchObject({
			portfolioAllocationPercent: 50,
			reservePoolPercent: 10,
			maxDailyProjectCredits: 100,
			emergencyOverride: true,
			metadata: expect.objectContaining({
				portfolioAllocationPercent: 50,
				reservePoolPercent: 10,
				maxDailyProjectCredits: 100,
				emergencyOverride: true,
			}),
		});

		const codexUsage = await json(await app.request('/v1/provider/usage', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${registration.sessionToken}`,
			},
			body: JSON.stringify({
				projectId: project.id,
				taskId: 'codex-task-1',
				taskSignature: 'docs.dynamic-capacity.phase-2',
				executionProviderId: codex.payload.id,
				nativeUsage: {
					nativeUnit: 'wall_minute',
					wallMinutes: 18,
					filesChanged: 2,
					testRuns: 1,
					source: 'provider_report',
				},
			}),
		}));
		expect(codexUsage.usage).toMatchObject({
			actualCredits: 9,
			creditFormulaVersion: 'treeseed.actual-credits.v1',
			actualCreditSource: 'central_calculator',
			executionProviderId: codex.payload.id,
			nativeUsage: expect.objectContaining({
				nativeUnit: 'wall_minute',
				wallMinutes: 18,
				filesChanged: 2,
				testRuns: 1,
			}),
		});

		const openRouterUsage = await json(await app.request('/v1/provider/usage', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${registration.sessionToken}`,
			},
			body: JSON.stringify({
				projectId: project.id,
				taskId: 'openrouter-task-1',
				taskSignature: 'docs.dynamic-capacity.phase-2',
				executionProviderId: openRouter.payload.id,
				nativeUsage: {
					nativeUnit: 'usd',
					usd: 0.09,
					inputTokens: 12000,
					outputTokens: 4000,
					source: 'provider_report',
				},
			}),
		}));
		expect(openRouterUsage.usage).toMatchObject({
			actualCredits: 5,
			actualCreditSource: 'central_calculator',
			executionProviderId: openRouter.payload.id,
			nativeUsage: expect.objectContaining({
				nativeUnit: 'usd',
				usd: 0.09,
				inputTokens: 12000,
				outputTokens: 4000,
			}),
		});
		const openRouterProfile = await store.getCreditConversionProfile(
			'docs.dynamic-capacity.phase-2',
			'standard-code-model',
			'token_metered_api',
			'usd',
		);
		expect(openRouterProfile).toMatchObject({
			taskSignature: 'docs.dynamic-capacity.phase-2',
			executionProviderKind: 'token_metered_api',
			nativeUnit: 'usd',
			sampleCount: 1,
			completedSampleCount: 1,
			confidence: 'low',
		});

		for (let index = 0; index < 20; index += 1) {
			const response = await app.request('/v1/provider/usage', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${registration.sessionToken}`,
				},
				body: JSON.stringify({
					projectId: project.id,
					taskId: `codex-learning-task-${index}`,
					taskSignature: 'docs.dynamic-capacity.phase-3',
					executionProviderId: codex.payload.id,
					nativeUsage: {
						nativeUnit: 'wall_minute',
						wallMinutes: 10,
						source: 'provider_report',
					},
				}),
			});
			expect(response.status).toBe(200);
		}
		const learnedProfile = await store.getCreditConversionProfile(
			'docs.dynamic-capacity.phase-3',
			'standard-code-model',
			'codex_subscription',
			'wall_minute',
		);
		expect(learnedProfile).toMatchObject({
			completedSampleCount: 20,
			nativeUnitsPerCreditP50: 5,
			nativeUnitsPerCreditP90: 5,
			confidence: 'high',
		});
		const profileCalculatedUsage = await json(await app.request('/v1/provider/usage', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${registration.sessionToken}`,
			},
			body: JSON.stringify({
				projectId: project.id,
				taskId: 'codex-profile-calculated-task',
				taskSignature: 'docs.dynamic-capacity.phase-3',
				executionProviderId: codex.payload.id,
				nativeUsage: {
					nativeUnit: 'wall_minute',
					wallMinutes: 20,
					filesChanged: 10,
					source: 'provider_report',
				},
			}),
		}));
		expect(profileCalculatedUsage.usage).toMatchObject({
			actualCredits: 4,
			actualCreditSource: 'conversion_profile',
			metadata: expect.objectContaining({
				actualCreditCalculation: expect.objectContaining({
					conversionConfidence: 'high',
				}),
			}),
		});
		await app.request('/v1/provider/usage', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${registration.sessionToken}`,
			},
			body: JSON.stringify({
				projectId: project.id,
				taskId: 'codex-interrupted-task',
				taskSignature: 'docs.dynamic-capacity.phase-3',
				executionProviderId: codex.payload.id,
				nativeUsage: {
					nativeUnit: 'wall_minute',
					wallMinutes: 120,
					interrupted: true,
					partial: true,
					source: 'provider_report',
				},
			}),
		});
		const afterInterrupted = await store.getCreditConversionProfile(
			'docs.dynamic-capacity.phase-3',
			'standard-code-model',
			'codex_subscription',
			'wall_minute',
		);
		expect(afterInterrupted).toMatchObject({
			nativeUnitsPerCreditP90: 5,
			confidence: 'high',
			interruptedSampleCount: 1,
			metadata: expect.objectContaining({
				partialCredits: 24,
				partialNativeAmount: 120,
			}),
		});

		await store.createCapacityReservation({
			id: 'native-derived-reservation',
			capacityProviderId: provider.id,
			executionProviderId: codex.payload.id,
			laneId: lane.id,
			teamId: team.id,
			projectId: project.id,
			state: 'reserved',
			reservedCredits: 3,
			nativeUnit: 'wall_minute',
			reservedNativeAmount: 15,
		});
		const derivedProviderDetail = await json(await app.request(`/v1/teams/${team.id}/capacity-providers/${provider.id}`, { headers }));
		expect(derivedProviderDetail.provider.derivedCapacity).toMatchObject({
			entries: expect.arrayContaining([
				expect.objectContaining({
					executionProviderId: codex.payload.id,
					nativeUnit: 'wall_minute',
					configuredNativeLimit: 240,
					activeReservedNativeAmount: 15,
					reserveBufferNativeAmount: 60,
					availableNativeAmount: 165,
					derivedAvailableCredits: 33,
					confidence: 'high',
				}),
			]),
		});
		const projectCapacity = await json(await app.request(`/v1/projects/${project.id}/capacity?environment=staging`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(projectCapacity.payload.derivedCapacity).toMatchObject({
			providers: expect.arrayContaining([
				expect.objectContaining({ capacityProviderId: provider.id }),
			]),
		});
		const teamCapacity = await json(await app.request(`/v1/teams/${team.id}/capacity`, { headers }));
		expect(teamCapacity.payload.summary.derivedCapacity.entries).toEqual(expect.arrayContaining([
			expect.objectContaining({
				executionProviderId: codex.payload.id,
				derivedAvailableCredits: 33,
			}),
		]));

		const capacityPlan = await json(await app.request(`/v1/projects/${project.id}/capacity-plan?environment=staging`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(capacityPlan.payload.derivedCapacity.entries).toEqual(expect.arrayContaining([
			expect.objectContaining({
				executionProviderId: codex.payload.id,
				derivedAvailableCredits: 33,
			}),
		]));

			await store.createCapacityReservation({
			id: 'native-derived-exhaustion',
			capacityProviderId: provider.id,
			executionProviderId: codex.payload.id,
			laneId: lane.id,
			teamId: team.id,
			projectId: project.id,
			state: 'reserved',
			reservedCredits: 40,
			nativeUnit: 'wall_minute',
			reservedNativeAmount: 200,
		});
			const exhaustedCapacityPlan = await json(await app.request(`/v1/projects/${project.id}/capacity-plan?environment=staging`, {
				headers: { authorization: `Bearer ${token}` },
			}));
			expect(exhaustedCapacityPlan.payload.derivedCapacity.entries).toEqual(expect.arrayContaining([
				expect.objectContaining({
					executionProviderId: codex.payload.id,
					derivedAvailableCredits: 0,
				}),
			]));
	}, 60000);

	it('stores native capacity reported by capacity provider registration and heartbeat', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const { team } = await createTeamAndProject(app, token, {
			slug: 'reported-native-capacity-project',
			name: 'Reported Native Capacity Project',
		});
		const createdProvider = await json(await app.request(`/v1/teams/${team.id}/capacity-providers`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				name: 'Reporting Provider',
				launchMode: 'self_hosted',
			}),
		}));
		const provider = createdProvider.provider;
		const providerKey = createdProvider.apiKey.plaintext;
		const nativeCapacity = {
			executionProviders: [{
				id: 'reported-codex-seat',
				name: 'Reported Codex Seat',
				kind: 'codex_subscription',
				nativeUnit: 'wall_minute',
				quotaVisibility: 'opaque',
				maxConcurrentWorkers: 1,
				nativeLimits: [{
					scope: 'daily',
					nativeUnit: 'wall_minute',
					limitAmount: 180,
					reserveBufferPercent: 20,
				}],
			}],
		};

		const registrationResponse = await app.request('/v1/provider/register', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${providerKey}`,
			},
			body: JSON.stringify({
				marketId: 'test',
				runtime: { package: '@treeseed/agent', version: 'test', entrypoint: 'dist/provider/entrypoint.js', roles: ['api', 'manager', 'runner'] },
				capabilities: [],
				budgets: { nativeCapacity },
				health: { dataDirWritable: true },
			}),
		});
		expect(registrationResponse.status).toBe(200);
		const registration = await json(registrationResponse);
		expect(registration.sessionToken).toMatch(/^tsp_/);

		const heartbeat = await app.request('/v1/provider/heartbeat', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${registration.sessionToken}`,
			},
			body: JSON.stringify({
				marketId: 'test',
				providerId: provider.id,
				budgets: {
					nativeCapacity: {
						executionProviders: [{
							...nativeCapacity.executionProviders[0],
							observation: {
								health: 'ready',
								activeWorkers: 1,
								queuedTasks: 2,
								nativeRemaining: { wallMinutes: 90 },
								confidence: 'estimated',
							},
						}],
					},
				},
				health: { codexReady: true },
				status: 'online',
			}),
		});
		expect(heartbeat.status).toBe(200);

		const listed = await json(await app.request(`/v1/teams/${team.id}/capacity-providers/${provider.id}/execution-providers`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(listed.payload).toHaveLength(1);
		expect(listed.payload[0]).toMatchObject({
			id: 'reported-codex-seat',
			nativeLimits: [expect.objectContaining({ limitAmount: 180, reserveBufferPercent: 20 })],
			latestObservation: expect.objectContaining({
				health: 'ready',
				activeWorkers: 1,
				queuedTasks: 2,
				nativeRemaining: { wallMinutes: 90 },
			}),
		});
	});

		it('rejects removed host-backed capacity provider launches and omits runtime host collections', async () => {
			const app = createTestApp();
			const token = await authorizeApp(app);
			const { team, project } = await createTeamAndProject(app, token, {
				slug: 'host-backed-capacity-project',
				name: 'Host-backed Capacity Project',
			});

			const rejected = await app.request(`/v1/teams/${team.id}/capacity/providers/host-backed`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					name: 'Rejected Capacity',
					processingHostId: 'removed-runtime-host',
				}),
			});
			expect(rejected.status).toBe(404);

			const capacity = await json(await app.request(`/v1/teams/${team.id}/capacity`, {
				headers: { authorization: `Bearer ${token}` },
			}));
			expect(capacity.payload).not.toHaveProperty('processingHosts');
			expect(capacity.payload).not.toHaveProperty('activeProcessingHosts');
			expect(capacity.payload.projects.map((entry: { id: string }) => entry.id)).toContain(project.id);
		});

	it('creates, rotates, and scopes capacity provider API keys without exposing hashes', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const token = await authorizeApp(app);
		const { team } = await createTeamAndProject(app, token, {
			slug: 'capacity-keys-project',
			name: 'Capacity Keys Project',
		});

		const providerResponse = await app.request(`/v1/teams/${team.id}/capacity-providers`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				name: 'Local Runner',
				launchMode: 'self_hosted',
			}),
		});
		expect(providerResponse.status).toBe(201);
		const createdProvider = await json(providerResponse);
		const provider = createdProvider.provider;
		const firstKey = createdProvider.apiKey.plaintext;
		expect(firstKey).toMatch(/^tsp_/);
		expect(createdProvider.apiKey.prefix).toBe(firstKey.slice(0, 16));
		expect(JSON.stringify(createdProvider.apiKey)).not.toContain('keyHash');
		expect(JSON.stringify(createdProvider.selfHosting.redactedEnv)).not.toContain(firstKey);
		expect(JSON.stringify(createdProvider.selfHosting.commands)).not.toContain(firstKey);

		const selfHostingResponse = await app.request(`/v1/teams/${team.id}/capacity-providers/${provider.id}/self-hosting`, {
			headers: {
				authorization: `Bearer ${token}`,
			},
		});
		expect(selfHostingResponse.status).toBe(200);
		const selfHosting = await json(selfHostingResponse);
		expect(selfHosting.selfHosting.env.TREESEED_CAPACITY_PROVIDER_API_KEY).toMatch(/REDACTED|rotate-to-reveal/i);
		expect(JSON.stringify(selfHosting.selfHosting)).not.toContain(firstKey);
		expect(JSON.stringify(selfHosting.selfHosting)).not.toContain('env_file');

		const rejectedCreate = await app.request(`/v1/teams/${team.id}/capacity-providers/${provider.id}/api-keys`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({}),
		});
		expect(rejectedCreate.status).toBe(410);

		const listed = await json(await app.request(`/v1/teams/${team.id}/capacity-providers/${provider.id}/api-keys`, {
			headers: {
				authorization: `Bearer ${token}`,
			},
		}));
		expect(listed.payload).toHaveLength(1);
		expect(listed.payload[0]).toMatchObject({
			status: 'active',
			keyPrefix: createdProvider.apiKey.prefix,
		});
		expect(listed.payload[0]).not.toHaveProperty('plaintextKey');
		expect(listed.payload[0]).not.toHaveProperty('keyHash');

		const insufficient = await app.request('/v1/provider/reports', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${firstKey}`,
			},
			body: JSON.stringify({ workDayId: 'missing', kind: 'test', body: {} }),
		});
		expect(insufficient.status).toBe(403);

		const registrationResponse = await app.request('/v1/provider/register', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${firstKey}`,
			},
			body: JSON.stringify({
				runtime: { package: '@treeseed/agent', version: 'test', entrypoint: 'test', roles: ['api', 'manager', 'runner'] },
				capabilities: [],
				budgets: {},
				health: { dataDirWritable: true },
			}),
		});
		expect(registrationResponse.status).toBe(200);
		const registration = await json(registrationResponse);
		expect(registration.sessionToken).toMatch(/^tsp_/);
		expect(registration.sessionToken).not.toBe(firstKey);

		const missingReport = await app.request('/v1/provider/reports', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${registration.sessionToken}`,
			},
			body: JSON.stringify({ workDayId: 'missing', kind: 'test', body: {} }),
		});
		expect(missingReport.status).toBe(404);

		const rotateResponse = await app.request(`/v1/teams/${team.id}/capacity-providers/${provider.id}/keys/rotate`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({}),
		});
		expect(rotateResponse.status).toBe(200);
		const rotated = await json(rotateResponse);
		expect(rotated.apiKey.plaintext).toMatch(/^tsp_/);
		expect(rotated.apiKey.plaintext).not.toBe(firstKey);
		expect(rotated.requiresRestart).toBe(true);

		const oldHeartbeat = await app.request('/v1/provider/heartbeat', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${firstKey}`,
			},
			body: JSON.stringify({ marketId: 'local' }),
		});
		expect(oldHeartbeat.status).toBe(401);

		const newHeartbeat = await app.request('/v1/provider/heartbeat', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${rotated.apiKey.plaintext}`,
			},
			body: JSON.stringify({ marketId: 'local' }),
		});
		expect(newHeartbeat.status).toBe(200);
	});

	it('handles capacity provider deployment intents without exposing provider secrets', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const token = await authorizeApp(app);
		const { team } = await createTeamAndProject(app, token, {
			slug: 'capacity-deploy-project',
			name: 'Capacity Deploy Project',
		});

		const selfHosted = await json(await app.request(`/v1/teams/${team.id}/capacity-providers`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				name: 'Self-host Runner',
				launchMode: 'self_hosted',
			}),
		}));
		const selfHostIntent = await app.request(`/v1/teams/${team.id}/capacity-providers/${selfHosted.provider.id}/deployments`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ launchMode: 'self_hosted' }),
		});
		expect(selfHostIntent.status).toBe(200);
		const selfHostPayload = await json(selfHostIntent);
		expect(selfHostPayload.deployment).toBeNull();
		expect(selfHostPayload.selfHosting.commands.join('\n')).toContain('capacity-provider:build');
		expect(await store.listCapacityProviderDeployments(team.id, selfHosted.provider.id)).toHaveLength(0);
		expect(JSON.stringify(selfHostPayload)).not.toContain(selfHosted.apiKey.plaintext);

		const managed = await json(await app.request(`/v1/teams/${team.id}/capacity-providers`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				name: 'Managed Runner',
				launchMode: 'managed_market_host',
			}),
		}));
		const managedDeploy = await app.request(`/v1/teams/${team.id}/capacity-providers/${managed.provider.id}/deployments`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ launchMode: 'managed_market_host' }),
		});
		expect(managedDeploy.status).toBe(201);
		const managedPayload = await json(managedDeploy);
		expect(managedPayload.deployment.status).toBe('deployed');
		expect(Object.keys(managedPayload.deployment.serviceRefs)).toEqual(['api', 'manager', 'runner']);
		expect(managedPayload.deployment.envRefs.TREESEED_CAPACITY_PROVIDER_API_KEY).toBe('<host-secret>');
		expect(JSON.stringify(managedPayload)).not.toContain(managed.apiKey.plaintext);

		const rejectedPlaintext = await app.request(`/v1/teams/${team.id}/capacity-providers/${managed.provider.id}/deployments`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				launchMode: 'managed_market_host',
				TREESEED_RAILWAY_API_TOKEN: 'plain-railway-token',
			}),
		});
		expect(rejectedPlaintext.status).toBe(400);
	});

	it('creates repository credential sessions from real secretbox envelopes in the API runtime', async () => {
		await withEnv({
			NODE_ENV: undefined,
			TREESEED_LOCAL_DEV_MODE: undefined,
			TREESEED_CREDENTIAL_SESSION_SECRET: undefined,
			TREESEED_ENVIRONMENT: 'local',
		}, async () => {
			const app = createTestApp({ config: { environment: 'local' } });
			const token = await authorizeApp(app);
			const team = await createTeam(app, token);
			const passphrase = 'api runtime passphrase';
			const encryptedPayload = await encryptHostConfig({
				TREESEED_GITHUB_TOKEN: 'ghp_runtime_test',
				organizationOrOwner: 'example-org',
				owner: 'example-org',
			}, passphrase, { opsLimit: 2, memLimit: 8192 });

			const host = await json(await app.request(`/v1/teams/${team.id}/repository-hosts`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					name: 'Runtime GitHub Host',
					organizationOrOwner: 'example-org',
					ownership: 'team_owned',
					encryptedPayload,
				}),
			}));
			expect(host.ok).toBe(true);

			const session = await json(await app.request(`/v1/teams/${team.id}/provider-credential-sessions`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					hostKind: 'repository_host',
					hostId: host.payload.id,
					passphrase,
					purpose: 'launch_project',
				}),
			}));
			expect(session.ok).toBe(true);
			expect(session.payload.hostKind).toBe('repository_host');
			expect(JSON.stringify(session)).not.toContain('ghp_runtime_test');
		});
	});

	it('deploys connected Railway capacity providers with one-use credential sessions', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const token = await authorizeApp(app);
		const { team } = await createTeamAndProject(app, token, {
			slug: 'connected-capacity-deploy-project',
			name: 'Connected Capacity Deploy Project',
		});
		const passphrase = 'provider-host-passphrase';

		const host = await json(await app.request(`/v1/teams/${team.id}/hosts`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				name: 'Capacity Provider Railway',
				provider: 'railway',
				ownership: 'team_owned',
				accountLabel: 'Provider Workspace',
				encryptedPayload: encryptedTestHostEnvelope({
					TREESEED_RAILWAY_API_TOKEN: 'railway-secret-token',
					TREESEED_RAILWAY_WORKSPACE: 'provider-workspace',
				}, passphrase),
				metadata: {
					hostType: 'capacity_provider',
				},
			}),
		}));
		const session = await json(await app.request(`/v1/teams/${team.id}/provider-credential-sessions`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				hostKind: 'capacity_provider_host',
				hostId: host.payload.id,
				passphrase,
				purpose: 'deploy_capacity_provider',
				expiresInSeconds: 600,
			}),
		}));
		expect(session.payload.id).toBeTruthy();

		const provider = await json(await app.request(`/v1/teams/${team.id}/capacity-providers`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				name: 'Connected Runner',
				launchMode: 'connected_host',
			}),
		}));
		const missingSession = await app.request(`/v1/teams/${team.id}/capacity-providers/${provider.provider.id}/deployments`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ launchMode: 'connected_host' }),
		});
		expect(missingSession.status).toBe(400);

		const deployed = await app.request(`/v1/teams/${team.id}/capacity-providers/${provider.provider.id}/deployments`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				launchMode: 'connected_host',
				hostId: host.payload.id,
				credentialSessions: {
					capacityProviderHost: session.payload.id,
				},
			}),
		});
		expect(deployed.status).toBe(201);
		const payload = await json(deployed);
		expect(payload.deployment.status).toBe('deployed');
			expect(payload.deployment.serviceRefs.api.serviceId).toContain('railway:provider-workspace');
			expect(JSON.stringify(payload)).not.toContain('railway-secret-token');
			expect(JSON.stringify(payload)).not.toContain(provider.apiKey.plaintext);
			const consumed = await store.getProviderCredentialSession(team.id, session.payload.id);
			if (!consumed) {
				throw new Error('Expected capacity provider host credential session to be consumed.');
			}
			expect(consumed.status).toBe('consumed');

		const reused = await app.request(`/v1/teams/${team.id}/capacity-providers/${provider.provider.id}/deployments`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				launchMode: 'connected_host',
				hostId: host.payload.id,
				credentialSessions: {
					capacityProviderHost: session.payload.id,
				},
			}),
		});
		expect(reused.status).toBe(400);
	});

	it('uses canonical project repositories in provider portfolios and stores provider-generated workday/report state', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const token = await authorizeApp(app);
		const { team, project } = await createTeamAndProject(app, token, {
			slug: 'portfolio-project',
			name: 'Portfolio Project',
			metadata: {
				repository: {
					provider: 'github',
					owner: 'metadata-owner',
					name: 'metadata-repo',
					cloneUrl: 'git@github.com:metadata-owner/metadata-repo.git',
					defaultBranch: 'metadata',
				},
			},
		});
		await store.upsertHubRepository(project.id, {
			teamId: team.id,
			role: 'primary',
			provider: 'github',
			owner: 'canonical-owner',
			name: 'canonical-repo',
			url: 'https://github.com/canonical-owner/canonical-repo.git',
			defaultBranch: 'main',
			currentBranch: 'main',
			status: 'active',
			submodulePath: 'packages/canonical',
			metadata: { webUrl: 'https://github.com/canonical-owner/canonical-repo' },
		});
		const createdProvider = await json(await app.request(`/v1/teams/${team.id}/capacity-providers`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				name: 'Portfolio Runner',
				launchMode: 'self_hosted',
			}),
		}));
		const providerKey = createdProvider.apiKey.plaintext;
		const registration = await json(await app.request('/v1/provider/register', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${providerKey}`,
			},
			body: JSON.stringify({
				runtime: { package: '@treeseed/agent', version: 'test', entrypoint: 'test', roles: ['api', 'manager', 'runner'] },
				capabilities: [],
				budgets: {},
				health: { dataDirWritable: true },
			}),
		}));
		expect(registration.sessionToken).toMatch(/^tsp_/);
		const portfolioResponse = await app.request('/v1/provider/portfolio', {
			headers: { authorization: `Bearer ${registration.sessionToken}` },
		});
		expect(portfolioResponse.status).toBe(200);
		const portfolioPayload = await json(portfolioResponse);
		expect(portfolioPayload.projects[0].repository).toMatchObject({
			provider: 'github',
			role: 'primary',
			owner: 'canonical-owner',
			name: 'canonical-repo',
			defaultBranch: 'main',
			cloneUrl: 'https://github.com/canonical-owner/canonical-repo.git',
			submodulePath: 'packages/canonical',
			webUrl: 'https://github.com/canonical-owner/canonical-repo',
		});

		const workdayResponse = await app.request('/v1/provider/workdays', {
			method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${registration.sessionToken}`,
				},
			body: JSON.stringify({
				projectId: project.id,
				environment: 'local',
				idempotencyKey: 'provider-workday-local',
				summary: {
					capacityBudget: 10,
					agentCount: 1,
				},
			}),
		});
		expect(workdayResponse.status).toBe(200);
		const workdayPayload = await json(workdayResponse);
		expect(workdayPayload.workDay.summary.provider).toMatchObject({
			id: createdProvider.provider.id,
		});

		const reportResponse = await app.request('/v1/provider/reports', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${registration.sessionToken}`,
			},
			body: JSON.stringify({
				workDayId: workdayPayload.workDay.id,
				kind: 'provider_portfolio_processing',
				body: {
					status: 'ok',
					summary: 'Provider portfolio processing completed.',
				},
			}),
		});
		expect(reportResponse.status).toBe(200);
		const provider = await store.getCapacityProvider(team.id, createdProvider.provider.id);
		expect(provider?.metadata).toMatchObject({
			latestProviderWorkday: {
				projectId: project.id,
				workDayId: workdayPayload.workDay.id,
				environment: 'local',
			},
			latestProviderReport: {
				workDayId: workdayPayload.workDay.id,
				kind: 'provider_portfolio_processing',
				summary: 'Provider portfolio processing completed.',
			},
		});
	});

	it('rejects expired and insufficient-scope provider API keys distinctly', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const token = await authorizeApp(app);
		const { team } = await createTeamAndProject(app, token, {
			slug: 'capacity-auth-project',
			name: 'Capacity Auth Project',
		});

		const createdProvider = await json(await app.request(`/v1/teams/${team.id}/capacity-providers`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				name: 'Scoped Runner',
				launchMode: 'self_hosted',
			}),
		}));

		const limited = await store.createCapacityProviderApiKey(team.id, createdProvider.provider.id, {
			name: 'Heartbeat only',
			scopes: ['provider:heartbeat'],
		});
		const insufficient = await app.request('/v1/provider/reports', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${limited!.plaintextKey}`,
			},
			body: JSON.stringify({ workDayId: 'missing', kind: 'test', body: {} }),
		});
		expect(insufficient.status).toBe(403);

		const expired = await store.createCapacityProviderApiKey(team.id, createdProvider.provider.id, {
			name: 'Expired',
			expiresAt: '2000-01-01T00:00:00.000Z',
		});
		const expiredHeartbeat = await app.request('/v1/provider/heartbeat', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${expired!.plaintextKey}`,
			},
			body: JSON.stringify({ marketId: 'local' }),
		});
		expect(expiredHeartbeat.status).toBe(401);
	});

	it('launches managed capacity, reserves budgeted agent work, settles actuals, and rejects revoked provider keys', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const { team, project } = await createTeamAndProject(app, token, {
			slug: 'capacity-spine-project',
			name: 'Capacity Spine Project',
		});

		const launchResponse = await app.request(`/v1/teams/${team.id}/capacity/providers/managed`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({}),
		});
		expect(launchResponse.status).toBe(201);
		const launch = (await json(launchResponse)).payload;
		expect(launch.provider.status).toBe('active');
		expect(launch.plaintextKey).toMatch(/^tsp_/);
		expect(launch.lanes.map((lane: { id: string }) => lane.id).join(' ')).toContain('proposal-drafting');

			const heartbeat = await app.request('/v1/provider/heartbeat', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${launch.plaintextKey}`,
			},
			body: JSON.stringify({
				queueDepth: 1,
				activeWorkers: 1,
				maxWorkers: 2,
				capabilities: ['agent_execution'],
				environments: ['staging'],
			}),
		});
		expect(heartbeat.status).toBe(200);

			const rotateResponse = await app.request(`/v1/teams/${team.id}/capacity-providers/${launch.provider.id}/keys/rotate`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({}),
		});
		expect(rotateResponse.status).toBe(200);
		const oldHeartbeat = await app.request('/v1/provider/heartbeat', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${launch.plaintextKey}`,
			},
			body: JSON.stringify({ queueDepth: 0 }),
		});
		expect(oldHeartbeat.status).toBe(401);
	});

	it('plans and applies staging seeds with audit records, then reports unchanged', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);

		const unauthenticated = await app.request('/v1/seeds/treeseed/plan', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ environments: ['staging'] }),
		});
		expect(unauthenticated.status).toBe(401);

		const teamResponse = await app.request('/v1/teams', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ slug: 'treeseed', name: 'TreeSeed' }),
		});
		expect(teamResponse.status).toBe(200);
		const team = (await json(teamResponse)).payload;

		const planResponse = await app.request('/v1/seeds/treeseed/plan', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ environments: ['staging'] }),
		});
		expect(planResponse.status).toBe(200);
		const plan = await json(planResponse);
		expect(plan.ok).toBe(true);
		expect(plan.summary).toMatchObject({ create: 20, update: 1, unchanged: 0, skip: 20 });
		expect(plan.run).toMatchObject({ state: 'completed', mode: 'plan', seedName: 'treeseed' });

		const firstApplyResponse = await app.request('/v1/seeds/treeseed/apply', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ environments: ['staging'] }),
		});
		expect(firstApplyResponse.status).toBe(200);
		const firstApply = await json(firstApplyResponse);
		expect(firstApply.ok).toBe(true);
		expect(firstApply.summary).toMatchObject({ create: 20, update: 1, unchanged: 0, skip: 20 });
		expect(firstApply.run).toMatchObject({ state: 'completed', mode: 'apply', seedName: 'treeseed' });
		expect(firstApply.result.actionCount).toBe(21);
		expect(firstApply.result.capacityProviderKeys.created).toHaveLength(0);

		const runs = await json(await app.request('/v1/seeds/runs', {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(JSON.stringify(runs)).not.toContain('tsp_');
		expect(runs.payload).toEqual(expect.arrayContaining([
			expect.objectContaining({
				seedName: 'treeseed',
				mode: 'apply',
				state: 'completed',
			}),
		]));

		const secondApplyResponse = await app.request('/v1/seeds/treeseed/apply', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ environments: ['staging'] }),
		});
		expect(secondApplyResponse.status).toBe(200);
		const secondApply = await json(secondApplyResponse);
		expect(secondApply.summary).toMatchObject({ create: 0, update: 0, unchanged: 21, skip: 20 });
		expect(secondApply.result.actionCount).toBe(0);
		expect(secondApply.result.capacityProviderKeys.created).toHaveLength(0);
		expect(secondApply.result.capacityProviderKeys.existing).toHaveLength(0);

		const exportResponse = await app.request(`/v1/teams/${team.id}/seeds/export`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ name: 'treeseed', environments: ['staging'], includeArtifacts: true }),
		});
		expect(exportResponse.status).toBe(200);
		const exported = await json(exportResponse);
		expect(exported.ok).toBe(true);
		expect(exported.yaml).toContain('repositoryHosts:');
		expect(exported.yaml).toContain('products:');
		expect(exported.yaml).toContain('catalogArtifacts:');
		expect(exported.yaml).not.toMatch(/encryptedPayload|BEGIN PRIVATE KEY|ghp_/u);
	});

	it('gates production seed apply on matching approved requests', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const teamResponse = await app.request('/v1/teams', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ slug: 'treeseed', name: 'TreeSeed' }),
		});
		const team = (await json(teamResponse)).payload;
		await app.request('/v1/seeds/treeseed/apply', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ environments: ['staging'] }),
		});

		const blockedResponse = await app.request('/v1/seeds/treeseed/apply', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ environments: ['prod'] }),
		});
		expect(blockedResponse.status).toBe(409);
		const blocked = await json(blockedResponse);
		expect(blocked.ok).toBe(false);
		expect(blocked.result.blocked).toBe(true);
		expect(blocked.result.approvalRequest).toMatchObject({
			kind: 'seed_production_apply',
			state: 'pending',
		});

		const teamApprovals = await json(await app.request(`/v1/teams/${team.id}/approval-requests?kind=seed_production_apply`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(teamApprovals.payload).toEqual(expect.arrayContaining([
			expect.objectContaining({
				id: blocked.result.approvalRequest.id,
				kind: 'seed_production_apply',
				state: 'pending',
			}),
		]));

		const inbox = await json(await app.request(`/v1/teams/${team.id}/inbox`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(inbox.payload).toEqual(expect.arrayContaining([
			expect.objectContaining({
				href: `/app/work/decisions#approval-${blocked.result.approvalRequest.id}`,
				metadata: expect.objectContaining({
					approvalId: blocked.result.approvalRequest.id,
					approvalKind: 'seed_production_apply',
				}),
			}),
		]));

		const staleResponse = await app.request('/v1/seeds/treeseed/apply', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ environments: ['prod'], approvalRequestId: blocked.result.approvalRequest.id }),
		});
		expect(staleResponse.status).toBe(409);

		const decided = await app.request(`/v1/approval-requests/${blocked.result.approvalRequest.id}/decide`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ state: 'approved' }),
		});
		expect(decided.status).toBe(200);

		const appliedResponse = await app.request('/v1/seeds/treeseed/apply', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ environments: ['prod'], approvalRequestId: blocked.result.approvalRequest.id }),
		});
		expect(appliedResponse.status).toBe(200);
		const applied = await json(appliedResponse);
		expect(applied.ok).toBe(true);
		expect(applied.summary.create).toBeGreaterThan(0);
		expect(applied.run).toMatchObject({ state: 'completed', mode: 'apply' });
	});
});

describe('TreeDX market integration', () => {
	it('provisions one active team TreeDX binding and exposes mirrors and shares', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);

		const first = await json(await app.request(`/v1/teams/${team.id}/treedx/provision`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ baseUrl: 'https://treedx.team.example' }),
		}));
		expect(first.payload.instance).toMatchObject({
			teamId: team.id,
			provider: 'railway',
			status: 'active',
			baseUrl: 'https://treedx.team.example',
		});

		const second = await json(await app.request(`/v1/teams/${team.id}/treedx`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ baseUrl: 'https://treedx.next.example', status: 'active', provider: 'railway' }),
		}));
		expect(second.payload.instance.id).toBe(first.payload.instance.id);
		expect(second.payload.instance.baseUrl).toBe('https://treedx.next.example');

		const mirror = await json(await app.request(`/v1/teams/${team.id}/treedx/mirrors`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ name: 'Customer mirror', targetKind: 'treedx', targetUrl: 'https://customer.example' }),
		}));
		expect(mirror.payload).toMatchObject({ name: 'Customer mirror', targetUrl: 'https://customer.example' });

		const share = await json(await app.request(`/v1/teams/${team.id}/treedx/shares`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ scope: 'public_federation', publicRead: true }),
		}));
		expect(share.payload).toMatchObject({ scope: 'public_federation', publicRead: true, status: 'active' });

		const status = await json(await app.request(`/v1/teams/${team.id}/treedx`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(status.payload.mirrors).toEqual(expect.arrayContaining([
			expect.objectContaining({ name: 'TreeSeed public registry mirror', targetKind: 'treedx' }),
			expect.objectContaining({ name: 'Customer mirror', targetUrl: 'https://customer.example' }),
		]));
		expect(status.payload.shares).toHaveLength(1);
	});

	it('queues public federation provisioning instead of treating it as a metadata-only attachment', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);

		const response = await app.request(`/v1/teams/${team.id}/treedx/provision`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ publicRead: true, imageRef: 'treeseed/treedx:0.1.0' }),
		});
		expect(response.status).toBe(202);
		const payload = await json(response);
		expect(payload.payload.instance).toMatchObject({
			teamId: team.id,
			kind: 'managed_public_federation',
			provider: 'railway',
			publicRead: true,
			status: 'pending',
			volumeMountPath: '/data',
		});
		expect(payload.payload.operation).toMatchObject({
			namespace: 'treedx',
			operation: 'provision',
			status: 'queued',
			input: expect.objectContaining({ publicRead: true, volumeMountPath: '/data' }),
		});
		expect(payload.payload.deployments[0]).toMatchObject({
			provider: 'railway',
			status: 'queued',
			volumeMountPath: '/data',
		});
	});

	it('lets trusted deploy services bootstrap the default public TreeDX federation team', async () => {
		const app = createTestApp({
			config: {
				webServiceId: 'web',
				webServiceSecret: 'web-test-secret',
			},
		});
		const response = await app.request('/v1/internal/treedx/public-federation/provision', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-treeseed-service-id': 'web',
				'x-treeseed-service-secret': 'web-test-secret',
			},
			body: JSON.stringify({ imageRef: 'treeseed/treedx:0.1.0', idempotencyKey: 'test-public-treedx-bootstrap' }),
		});
		expect(response.status).toBe(202);
		const payload = await json(response);
		expect(payload.payload.team).toMatchObject({
			id: 'team-treeseed-public',
			slug: 'treeseed-public',
		});
		expect(payload.payload.instance).toMatchObject({
			teamId: 'team-treeseed-public',
			kind: 'managed_public_federation',
			provider: 'railway',
			publicRead: true,
			status: 'pending',
			volumeMountPath: '/data',
		});
		expect(payload.payload.operation).toMatchObject({
			namespace: 'treedx',
			operation: 'provision',
			status: 'queued',
		});

		const status = await json(await app.request('/v1/internal/treedx/public-federation/status?teamSlug=treeseed-public', {
			headers: {
				'x-treeseed-service-id': 'web',
				'x-treeseed-service-secret': 'web-test-secret',
			},
		}));
		expect(status.payload.team).toMatchObject({ id: 'team-treeseed-public' });
		expect(status.payload.deployments[0]).toMatchObject({ status: 'queued', provider: 'railway' });
	});

	it('runs TreeDX provisioning through Railway project, service, volume, variable, domain, and deploy adapters', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({
			db,
			store,
			config: {
				platformRunnerSecret: 'platform-runner-secret',
			},
		});
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);
		const queued = await json(await app.request(`/v1/teams/${team.id}/treedx/provision`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ publicRead: true, imageRef: 'treeseed/treedx:0.1.0' }),
		}));
		const calls: string[] = [];
		const railwaySecretValues: string[] = [];
		const fakeRailway = {
			ensureProject: vi.fn(async ({ projectName }: any) => {
				calls.push(`project:${projectName}`);
				return { workspace: { id: 'workspace-1' }, project: { id: 'railway-project-1', name: projectName }, created: true };
			}),
			ensureEnvironment: vi.fn(async ({ environmentName }: any) => {
				calls.push(`environment:${environmentName}`);
				return { environment: { id: 'railway-environment-1', name: environmentName }, created: false };
			}),
			ensureService: vi.fn(async ({ serviceName, imageRef }: any) => {
				calls.push(`service:${serviceName}:${imageRef}`);
				return { service: { id: 'railway-service-1', name: serviceName }, created: true };
			}),
			listVariables: vi.fn(async () => ({})),
			upsertVariables: vi.fn(async ({ variables }: any) => {
				calls.push(`variables:${Object.keys(variables).sort().join(',')}`);
				if (typeof variables.SECRET_KEY_BASE === 'string') {
					railwaySecretValues.push(variables.SECRET_KEY_BASE);
				}
				return { variables, changed: true };
			}),
			ensureServiceInstanceConfiguration: vi.fn(async () => {
				calls.push('instance-config');
				return { instance: { id: 'service-instance-1' }, updated: true };
			}),
			ensureServiceVolume: vi.fn(async () => {
				calls.push('volume:/data');
				return { volume: { id: 'volume-1', name: 'public-treedx-node-01-volume' }, instance: { id: 'volume-instance-1' }, created: true, updated: false };
			}),
			ensureGeneratedServiceDomain: vi.fn(async () => {
				calls.push('domain');
				return { domain: { id: 'domain-1', domain: 'treedx-public-staging.up.railway.app' }, created: true };
			}),
			deployServiceInstance: vi.fn(async () => {
				calls.push('deploy');
				return { deploymentId: 'railway-deployment-1' };
			}),
		};

		await withEnv({ TREESEED_PUBLIC_TREEDX_RAILWAY_PROJECT_NAME: 'treeseed-api' }, async () => {
			await withHttpMarketApp(app, async (baseUrl) => {
				const client = new PlatformRunnerClient({
					marketUrl: baseUrl,
					marketId: 'local',
					runnerSecret: 'platform-runner-secret',
				});
				const result = await runOnceWithClient({
					runnerId: 'treeseed-ops-treedx-runner-01',
					environment: 'staging',
					dataDir: packageRoot,
				}, client, 'test', {
					deploymentStore: store,
					operationKey: 'treedx:provision',
					config: { environment: 'staging' },
					railway: fakeRailway,
				});
				expect(result).toMatchObject({
					ok: true,
					claimed: true,
					output: {
						ok: true,
						baseUrl: 'https://treedx-public-staging.up.railway.app',
					},
				});
			});
		});

		expect(calls).toEqual(expect.arrayContaining([
			'project:treeseed-api',
			'environment:staging',
			'service:public-treedx-node-01:treeseed/treedx:0.1.0',
			'variables:PHX_HOST,PHX_SERVER,PORT,SECRET_KEY_BASE,TREEDX_DATA_DIR,TREEDX_FEDERATION_MODE,TREESEED_TREEDX_SCOPE',
			'volume:/data',
			'domain',
			'deploy',
		]));
		const status = await store.getTeamTreeDx(team.id);
		expect(status.instance).toMatchObject({
			id: queued.payload.instance.id,
			kind: 'managed_public_federation',
			provider: 'railway',
			status: 'active',
			publicRead: true,
			baseUrl: 'https://treedx-public-staging.up.railway.app',
			railwayProjectId: 'railway-project-1',
			railwayServiceId: 'railway-service-1',
			railwayEnvironmentId: 'railway-environment-1',
			volumeMountPath: '/data',
		});
		expect(railwaySecretValues).toHaveLength(1);
		expect(JSON.stringify(status)).not.toContain(railwaySecretValues[0]);

		const idempotent = await store.provisionTeamTreeDx(team.id, { publicRead: true, imageRef: 'treeseed/treedx:0.1.0' });
		expect(idempotent?.instance).toMatchObject({
			id: queued.payload.instance.id,
			status: 'active',
			baseUrl: 'https://treedx-public-staging.up.railway.app',
			railwayProjectId: 'railway-project-1',
			railwayServiceId: 'railway-service-1',
		});
	});

	it('persists canonical repository topology project architecture and exposes it in provider portfolio', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const token = await authorizeApp(app);
		const { team, project } = await createTeamAndProject(app, token, {
			slug: 'hub-one',
			name: 'Hub One',
			metadata: {},
		});

		await store.upsertHubRepository(project.id, {
			teamId: team.id,
			role: 'software',
			provider: 'github',
			owner: 'acme',
			name: 'hub-one-site',
			url: 'https://github.com/acme/hub-one-site',
			defaultBranch: 'staging',
			status: 'active',
		});
		await store.upsertHubRepository(project.id, {
			teamId: team.id,
			role: 'content',
			provider: 'github',
			owner: 'acme',
			name: 'hub-one-content',
			url: 'https://github.com/acme/hub-one-content',
			defaultBranch: 'main',
			status: 'active',
		});
		await store.upsertHubWorkspaceLink(project.id, {
			teamId: team.id,
			parentOwner: 'acme',
			parentName: 'software',
			parentUrl: 'https://github.com/acme/software',
			parentBranch: 'main',
			softwareSubmodulePath: 'docs',
		});
		await store.upsertTeamTreeDx(team.id, {
			baseUrl: 'https://treedx.team.example',
			status: 'active',
		});

		const binding = await json(await app.request(`/v1/projects/${project.id}/treedx-library`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ libraryId: 'acme/hub-one', repositoryId: 'repo_hub_one' }),
		}));
		expect(binding.payload.contentRepositoryUrl).toBe('https://github.com/acme/hub-one-content');

		const architecturePayload = {
			topology: 'single_repository_site',
			rootPath: '.',
			sitePath: 'docs',
			contentPath: 'docs/src/content',
			contentRuntimeSource: 'treedx_snapshot',
			localContentMaterialization: 'none',
			contentPublishTarget: {
				kind: 'cloudflare_r2',
				prefix: 'hub-one',
			},
		};
		const updated = await json(await app.request(`/v1/projects/${project.id}/repository-topology`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify(architecturePayload),
		}));
		expect(updated.payload).toMatchObject(architecturePayload);

		const architecture = await json(await app.request(`/v1/projects/${project.id}/repository-topology`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(architecture.payload).toMatchObject(architecturePayload);

		const rejectedLegacy = await app.request(`/v1/projects/${project.id}/repository-topology`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ topology: 'split_software_content', sitePath: 'docs' }),
		});
		expect(rejectedLegacy.status).toBe(400);
		expect(await json(rejectedLegacy)).toMatchObject({ code: 'legacy_project_topology_rejected' });

		const rejectedSecret = await app.request(`/v1/projects/${project.id}/repository-topology`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ ...architecturePayload, token: 'ghp_should-not-persist' }),
		});
		expect(rejectedSecret.status).toBe(400);
		expect(await json(rejectedSecret)).toMatchObject({ code: 'project_architecture_secret_material_rejected' });

		const manifest = await store.buildCapacityProviderPortfolio({ teamId: team.id });
		if (!manifest) throw new Error('Expected capacity provider portfolio manifest for TreeDX project topology test.');
		expect(manifest.projects[0].repository.name).toBe('hub-one-site');
		expect(manifest.projects[0].architecture).toMatchObject(architecturePayload);
		const details = await store.getProjectDetails(project.id);
		expect(details?.architecture).toMatchObject(architecturePayload);
		expect(details?.contentSource?.metadata?.projectArchitecture).toMatchObject(architecturePayload);
	});

	it('imports existing GitHub repositories as canonical project architecture without token values', async () => {
		const db = createTestPostgresDatabase();
		const store = createTestStore(db);
		const app = createTestApp({ db, store });
		const token = await authorizeApp(app);
		const team = await createTeam(app, token);
		await store.upsertTeamTreeDx(team.id, {
			baseUrl: 'https://treedx.team.example',
			status: 'active',
		});
		const plan = treeseedCore.planTreeseedRepositoryImport({
			team: team.slug,
			repository: 'treeseed-ai/sdk',
			env: { TREESEED_GITHUB_TOKEN_TREESEED_AI_SDK: 'ghp_should-never-persist' },
			observation: {
				defaultBranch: 'main',
				files: ['package.json', 'treeseed.package.yaml', 'docs/index.md', 'docs/src/content/intro.md'],
				directories: ['docs', 'docs/src', 'docs/src/content'],
			},
		});

		const imported = await json(await app.request(`/v1/teams/${team.slug}/projects/import`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ plan }),
		}));

		expect(imported.ok).toBe(true);
		expect(imported.payload.project.slug).toBe('sdk');
		expect(imported.payload.architecture).toMatchObject({
			topology: 'single_repository_site',
			sitePath: 'docs',
			contentPath: 'docs/src/content',
			contentRuntimeSource: 'r2_published_manifest',
		});
		expect(imported.payload.hubRepository).toMatchObject({
			role: 'software',
			provider: 'github',
			owner: 'treeseed-ai',
			name: 'sdk',
			defaultBranch: 'main',
		});
		expect(imported.payload.hubRepository.metadata.credentialRef).toBe('env:TREESEED_GITHUB_TOKEN_TREESEED_AI_SDK');
		expect(imported.payload.contentSource.metadata.projectArchitecture.sitePath).toBe('docs');
		expect(imported.payload.treeDxLibrary.contentPath).toBe('docs/src/content');
		expect(JSON.stringify(imported)).not.toContain('ghp_should-never-persist');

		const legacy = await app.request(`/v1/teams/${team.id}/projects/import`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ plan: { ...plan, repositoryTopology: 'split_software_content' } }),
		});
		expect(legacy.status).toBe(400);
		expect(await json(legacy)).toMatchObject({ code: 'legacy_project_topology_rejected' });

		const secret = await app.request(`/v1/teams/${team.id}/projects/import`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ plan: { ...plan, token: 'ghp_should-reject' } }),
		});
		expect(secret.status).toBe(400);
		expect(await json(secret)).toMatchObject({ code: 'project_import_secret_material_rejected' });
	});

	it('does not proxy normal TreeDX project calls with static admin tokens or implicit local secrets', async () => {
		await withEnv({
			TREESEED_TREEDX_JWT_HS256_SECRET: undefined,
			TREEDX_JWT_HS256_SECRET: undefined,
			TREESEED_TREEDX_ADMIN_TOKEN: 'static-admin-token',
			TREESEED_TREEDX_TOKEN: 'static-general-token',
			TREEDX_TOKEN: 'static-legacy-token',
		}, async () => {
			const db = createTestPostgresDatabase();
			const store = createTestStore(db);
			const app = createTestApp({ db, store });
			const token = await authorizeApp(app);
			const { team, project } = await createTeamAndProject(app, token, {
				slug: 'dx-static-token-block',
				name: 'DX Static Token Block',
			});
			await store.upsertTeamTreeDx(team.id, {
				baseUrl: 'http://127.0.0.1:4011',
				status: 'active',
			});
			await store.upsertProjectTreeDxLibrary(project.id, {
				libraryId: 'team-one/dx-static-token-block',
				repositoryId: 'repo_dx_static_token_block',
			});
			const fetchSpy = vi.spyOn(globalThis, 'fetch');
			const response = await app.request(`/v1/dx/projects/${project.id}/repos/repo_dx_static_token_block/files/read`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
				body: JSON.stringify({ paths: ['books/intro.mdx'] }),
			});
			expect(response.status).toBe(503);
			expect(await json(response)).toMatchObject({
				ok: false,
				error: 'TreeDX proxy token is not configured for this project.',
			});
			expect(fetchSpy).not.toHaveBeenCalled();
			fetchSpy.mockRestore();
		});
	});

	it('mints scoped TreeSeed-issued TreeDX tokens for normal project proxy calls', async () => {
		await withEnv({
			TREESEED_TREEDX_JWT_HS256_SECRET: 'test-treedx-signing-secret',
			TREEDX_JWT_HS256_SECRET: undefined,
			TREESEED_TREEDX_ADMIN_TOKEN: 'static-admin-token',
			TREESEED_TREEDX_TOKEN: undefined,
			TREEDX_TOKEN: undefined,
		}, async () => {
			const db = createTestPostgresDatabase();
			const store = createTestStore(db);
			const app = createTestApp({ db, store });
			const token = await authorizeApp(app);
			const { team, project } = await createTeamAndProject(app, token, {
				slug: 'dx-scoped-token',
				name: 'DX Scoped Token',
			});
			await store.upsertTeamTreeDx(team.id, {
				baseUrl: 'http://127.0.0.1:4012',
				status: 'active',
			});
			await store.upsertProjectTreeDxLibrary(project.id, {
				libraryId: 'team-one/dx-scoped-token',
				repositoryId: 'repo_dx_scoped_token',
			});
			const authorizations: string[] = [];
			const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init = {}) => {
				const authorization = init.headers instanceof Headers
					? init.headers.get('authorization')
					: (init.headers as Record<string, string> | undefined)?.authorization;
				if (authorization) authorizations.push(authorization);
				return new Response(JSON.stringify({ ok: true, files: [{ path: 'books/intro.mdx', content: '# Intro' }] }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			});
			const response = await app.request(`/v1/dx/projects/${project.id}/repos/repo_dx_scoped_token/files/read`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
				body: JSON.stringify({ paths: ['books/intro.mdx'] }),
			});
			expect(response.status).toBe(200);
			expect(authorizations).toHaveLength(1);
			expect(authorizations[0]).not.toBe('Bearer static-admin-token');
			const jwt = authorizations[0].replace(/^Bearer\s+/u, '');
			const [, payloadSegment] = jwt.split('.');
			const payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
			expect(payload).toMatchObject({
				aud: 'treedx-local',
				iss: 'https://api.treeseed.local/treedx',
				sub: 'treeseed-api',
				treedx_repo_ids: ['repo_dx_scoped_token'],
				treedx_capabilities: ['files:read'],
				treedx_paths: ['books/intro.mdx'],
				treeseed_project_id: project.id,
			});
			expect(payload.treedx_repo_ids).not.toContain('*');
			expect(payload.treedx_capabilities).not.toContain('policy:write');
			fetchSpy.mockRestore();
		});
	});

	it('requires assignment-scoped TreeDX proxy handles for provider callers and records audit rows', async () => {
		await withEnv({
			TREESEED_TREEDX_JWT_HS256_SECRET: 'test-treedx-provider-signing-secret',
			TREEDX_JWT_HS256_SECRET: undefined,
			TREESEED_TREEDX_ADMIN_TOKEN: undefined,
			TREESEED_TREEDX_TOKEN: undefined,
			TREEDX_TOKEN: undefined,
		}, async () => {
			const db = createTestPostgresDatabase();
			const store = createTestStore(db);
			const app = createTestApp({ db, store });
			const token = await authorizeApp(app);
			const { team, project } = await createTeamAndProject(app, token, {
				slug: 'dx-provider-assignment',
				name: 'DX Provider Assignment',
			});
			const headers = {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			};
			await store.upsertTeamTreeDx(team.id, {
				baseUrl: 'http://127.0.0.1:4013',
				status: 'active',
			});
			await store.upsertProjectTreeDxLibrary(project.id, {
				libraryId: 'team-one/dx-provider-assignment',
				repositoryId: 'repo_dx_provider_assignment',
			});
			const createdProvider = await json(await app.request(`/v1/teams/${team.id}/capacity-providers`, {
				method: 'POST',
				headers,
				body: JSON.stringify({ name: 'Provider TreeDX Runtime', launchMode: 'self_hosted' }),
			}));
			const provider = createdProvider.provider;
			const agentClass = (await json(await app.request(`/v1/projects/${project.id}/agent-classes`, {
				method: 'POST',
				headers,
				body: JSON.stringify({
					slug: 'planner',
					name: 'Planner',
					allowedModes: ['planning'],
					requiredCapabilities: ['repo_read'],
					handlerRefs: { planning: '@project/agents/planner' },
				}),
			}))).payload;
			const registration = await json(await app.request('/v1/provider/register', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${createdProvider.apiKey.plaintext}`,
				},
				body: JSON.stringify({
					runtime: { package: '@treeseed/agent', version: 'test', roles: ['manager', 'runner'] },
					capabilities: ['repo_read'],
					budgets: {},
					health: { ok: true },
				}),
			}));
				const providerHeaders = {
					'content-type': 'application/json',
					authorization: `Bearer ${registration.sessionToken}`,
				};
				const grant = (await json(await app.request(`/v1/teams/${team.id}/capacity-grants`, {
					method: 'POST',
					headers,
					body: JSON.stringify({
						capacityProviderId: provider.id,
						grantScope: 'project',
						projectId: project.id,
						environment: 'local',
						dailyCreditLimit: 10,
					}),
				}))).payload;
				const session = (await json(await app.request('/v1/provider/check-in', {
					method: 'POST',
					headers: providerHeaders,
					body: JSON.stringify({
						environment: 'local',
						capabilities: ['repo_read'],
						grants: [grant],
						runnerPressure: { activeRunners: 0, maxConcurrentRunners: 1 },
					}),
				}))).payload;
				const assignmentId = 'assignment_dx_provider_scoped';
				const handleId = 'tdx_handle_assignment_dx_provider_scoped';
			const assignment = (await json(await app.request(`/v1/teams/${team.id}/capacity/assignments`, {
				method: 'POST',
				headers,
				body: JSON.stringify({
					id: assignmentId,
					projectId: project.id,
					capacityProviderId: provider.id,
					projectAgentClassId: agentClass.id,
					mode: 'planning',
					agentId: 'planner',
					capacityEnvelope: { teamId: team.id, projectId: project.id, mode: 'planning', capacityProviderId: provider.id },
					decisionInput: { teamId: team.id, projectId: project.id, mode: 'planning', input: { objective: 'read context' } },
					treedxProxyHandle: {
						id: handleId,
						teamId: team.id,
						projectId: project.id,
						assignmentId,
						repositoryId: 'repo_dx_provider_assignment',
						scopes: ['project:read', 'files:read'],
						allowedOperations: ['files:read'],
						allowedPaths: ['books/**'],
						expiresAt: new Date(Date.now() + 60_000).toISOString(),
					},
				}),
			}))).payload;
			expect(assignment.treedxProxyHandle).toMatchObject({ id: handleId, assignmentId });
			expect(assignment.capabilityHandles).toMatchObject({
				workspaceAccessMode: 'context_only',
				treeDx: [expect.objectContaining({
					kind: 'treedx_workspace',
					proxyHandleId: handleId,
					repositoryId: 'repo_dx_provider_assignment',
					allowedOperations: ['files:read'],
				})],
				repository: [expect.objectContaining({
					kind: 'repository_access',
					provider: 'treedx_proxy',
					credentialMode: 'brokered',
				})],
			});
			expect(JSON.stringify(assignment.capabilityHandles)).not.toContain('token');
				const leased = await json(await app.request('/v1/provider/assignments/next', {
					method: 'POST',
					headers: providerHeaders,
					body: JSON.stringify({ sessionId: session.id, runnerId: 'runner-dx-provider', leaseSeconds: 60 }),
				}));
			expect(leased.payload).toMatchObject({ id: assignmentId, leaseState: 'leased' });
			expect(leased.payload.capabilityHandles).toMatchObject({
				treeDx: [expect.objectContaining({ proxyHandleId: handleId })],
			});
			const providerWorkflowDenied = await app.request(`/v1/provider/assignments/${assignmentId}/workflow-operations/missing-op/dispatch`, {
				method: 'POST',
				headers: providerHeaders,
				body: JSON.stringify({ leaseToken: leased.leaseToken, workflowFile: '.github/workflows/unsafe.yml' }),
			});
			expect(providerWorkflowDenied.status).toBe(403);

			const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
				ok: true,
				files: [{ path: 'books/intro.mdx', content: '# Intro' }],
			}), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			}));
			const missingHandle = await app.request(`/v1/dx/projects/${project.id}/repos/repo_dx_provider_assignment/files/read`, {
				method: 'POST',
				headers: providerHeaders,
				body: JSON.stringify({ paths: ['books/intro.mdx'] }),
			});
			expect(missingHandle.status).toBe(403);
			expect(fetchSpy).not.toHaveBeenCalled();

			const wrongPath = await app.request(`/v1/dx/projects/${project.id}/repos/repo_dx_provider_assignment/files/read`, {
				method: 'POST',
				headers: {
					...providerHeaders,
					'x-treeseed-assignment-id': assignmentId,
					'x-treeseed-treedx-proxy-handle-id': handleId,
				},
				body: JSON.stringify({ paths: ['src/private.ts'] }),
			});
			expect(wrongPath.status).toBe(403);
			expect(fetchSpy).not.toHaveBeenCalled();

			const proxied = await app.request(`/v1/dx/projects/${project.id}/repos/repo_dx_provider_assignment/files/read`, {
				method: 'POST',
				headers: {
					...providerHeaders,
					'x-treeseed-assignment-id': assignmentId,
					'x-treeseed-treedx-proxy-handle-id': handleId,
				},
				body: JSON.stringify({ paths: ['books/intro.mdx'] }),
			});
			expect(proxied.status).toBe(200);
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			fetchSpy.mockRestore();

			const audit = await json(await app.request(`/v1/projects/${project.id}/treedx-proxy-audit?assignmentId=${encodeURIComponent(assignmentId)}`, {
				headers: { authorization: `Bearer ${token}` },
			}));
			expect(audit.payload).toEqual(expect.arrayContaining([
				expect.objectContaining({
					projectId: project.id,
					assignmentId,
					actorType: 'capacity_provider',
					resultStatus: 'proxied',
					handle: expect.objectContaining({ id: handleId }),
				}),
				expect.objectContaining({
					projectId: project.id,
					assignmentId,
					actorType: 'capacity_provider',
					resultStatus: 'denied',
					reasonCode: 'treedx_proxy_path_denied',
				}),
			]));
		});
	});

	it('automatically provisions private TreeDX and central public mirror trust for private teams', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app, { principalId: 'private-owner' });
		const team = await json(await app.request('/v1/teams', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ slug: 'private-demo-team', name: 'Private Demo Team' }),
		}));
		expect(team.payload.metadata).toMatchObject({
			visibility: 'private',
			privateTreeDx: true,
		});

		const treedx = await json(await app.request(`/v1/teams/${team.payload.id}/treedx`, {
			headers: { authorization: `Bearer ${token}` },
		}));
		expect(treedx.payload.instance).toMatchObject({
			kind: 'managed_private',
			publicRead: false,
			registryUrl: 'https://api.treeseed.ai/treedx',
			metadata: expect.objectContaining({
				automaticPrivateTeamTreeDx: true,
				centralPublicRegistry: expect.objectContaining({
					trustMode: 'scoped_node_token',
					mirrorAllowed: true,
					queryDelegationAllowed: true,
				}),
			}),
		});
		expect(treedx.payload.mirrors).toEqual(expect.arrayContaining([
			expect.objectContaining({
				name: 'TreeSeed public registry mirror',
				direction: 'pull',
				targetKind: 'treedx',
				targetUrl: 'https://api.treeseed.ai/treedx',
				metadata: expect.objectContaining({
					centralPublicRegistry: true,
					privateDataEgress: 'deny_by_default',
				}),
			}),
		]));
	});

	it('accepts native Codex caps plus portfolio and agent-class allocation contracts', async () => {
		const app = createTestApp();
		const token = await authorizeApp(app, { principalId: 'allocation-owner' });
		const team = await json(await app.request('/v1/teams', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ slug: 'allocation-demo-team', name: 'Allocation Demo Team' }),
		}));
		const createProject = async (slug: string, name: string) => json(await app.request(`/v1/teams/${team.payload.id}/projects`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ slug, name, metadata: { sourceKind: 'template', sourceRef: slug.includes('engineering') ? 'engineering' : 'research' } }),
		}));
		const engineering = await createProject('engineering-demo', 'Engineering Demo');
		const research = await createProject('research-demo', 'Research Demo');
		const provider = await json(await app.request(`/v1/teams/${team.payload.id}/capacity-providers`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ name: 'Local Codex Provider', launchMode: 'self_hosted' }),
		}));
		const providerId = provider.provider.id;
		const executionProvider = await json(await app.request(`/v1/teams/${team.payload.id}/capacity-providers/${providerId}/execution-providers`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({
				name: 'Codex daily pool',
				kind: 'codex_subscription',
				nativeUnit: 'wall_minute',
				nativeLimits: [{
					scope: 'daily',
					nativeUnit: 'wall_minute',
					limitAmount: 300,
					dailyUsageCapPercent: 30,
					reserveBufferPercent: 20,
				}],
			}),
		}));
		expect(executionProvider.payload.nativeLimits[0]).toMatchObject({
			limitAmount: 300,
			dailyUsageCapPercent: 30,
			metadata: expect.objectContaining({ dailyUsageCapPercent: 30 }),
		});

		const portfolio = await json(await app.request(`/v1/teams/${team.payload.id}/capacity-allocation`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({
				capacityProviderId: providerId,
				allocations: [
					{ id: engineering.payload.project.id, name: 'Engineering Demo', percentage: 70 },
					{ id: research.payload.project.id, name: 'Research Demo', percentage: 30 },
				],
			}),
		}));
		expect(portfolio.payload.slices).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: engineering.payload.project.id, percentage: 70 }),
			expect.objectContaining({ id: research.payload.project.id, percentage: 30 }),
		]));
		expect(portfolio.payload.updatedGrants).toEqual(expect.arrayContaining([
			expect.objectContaining({
				projectId: engineering.payload.project.id,
				portfolioAllocationPercent: 70,
			}),
		]));

		const agentClasses = await json(await app.request(`/v1/projects/${engineering.payload.project.id}/capacity-allocation`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({
				allocations: [
					{ id: 'planning', name: 'Planning', percentage: 10 },
					{ id: 'research', name: 'Research', percentage: 20 },
					{ id: 'implementation', name: 'Implementation', percentage: 45 },
					{ id: 'review', name: 'Review', percentage: 15 },
					{ id: 'knowledge', name: 'Knowledge', percentage: 10 },
				],
			}),
		}));
		expect(agentClasses.payload.slices).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: 'implementation', percentage: 45 }),
			expect.objectContaining({ id: 'knowledge', percentage: 10 }),
		]));
	});
});
