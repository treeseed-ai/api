import { createHmac } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DataType, newDb } from 'pg-mem';
import { MarketControlPlaneStore } from '../../src/api/store.js';
import { MarketPostgresDatabase } from '../../src/api/market-postgres.js';
import { loadInfrastructureSeedState } from '../../src/market/infrastructure-seeds.js';
import { applyLocalSeedFromCli, exportSeedWithStore, resolveLocalSeedEnv } from '../../src/market/seeds/apply.js';
import { applyLocalSeedViaApiFromCli } from '../../src/market/seeds/local-api.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const marketMigrationRoot = existsSync(resolve(projectRoot, '../sdk/drizzle/market'))
	? resolve(projectRoot, '../sdk/drizzle/market')
	: resolve(projectRoot, 'node_modules/@treeseed/sdk/drizzle/market');

const tempDirs: string[] = [];
const TREESEED_PROJECT_SLUGS = ['admin', 'agent', 'api', 'cli', 'core', 'market', 'sdk', 'treedx', 'ui'];
const TREESEED_PACKAGE_SLUGS = ['admin', 'agent', 'api', 'cli', 'core', 'sdk', 'treedx', 'ui'];

function createAccessToken(payload: Record<string, unknown>, secret: string) {
	const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
	const encodedSignature = createHmac('sha256', secret).update(encodedPayload).digest('base64url');
	return `${encodedPayload}.${encodedSignature}`;
}

function localUserAccessToken(userId = 'user-local', email = 'adrian.webb@knowledge.coop') {
	return createAccessToken({
		sub: userId,
		displayName: 'Adrian Webb',
		scopes: ['auth:me', 'market'],
		roles: ['platform_admin'],
		permissions: ['*:*:*'],
		metadata: { email },
		iat: Math.floor(Date.now() / 1000),
		exp: Math.floor(Date.now() / 1000) + 3600,
		iss: 'http://127.0.0.1:3000',
		jti: `test-${userId}`,
		tokenType: 'access',
	}, 'test-auth-secret');
}

function createStore() {
	const memory = newDb();
	memory.public.registerFunction({
		name: 'md5',
		args: [DataType.text],
		returns: DataType.text,
		implementation: (value: string) => `md5:${value}`,
	});
	const pg = memory.adapters.createPg();
	const db = MarketPostgresDatabase.fromPool(new pg.Pool(), { migrationRoot: marketMigrationRoot });
	const store = new MarketControlPlaneStore({
		repoRoot: projectRoot,
		projectId: 'treeseed-market-test',
		authSecret: 'test-auth-secret',
		assertionSecret: 'test-assertion-secret',
		serviceId: 'web',
		serviceSecret: 'test-service-secret',
	}, db);
	return { db, store };
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe('local seed apply', () => {
	it('derives TREESEED_DATABASE_URL for local CLI seed apply', () => {
		const resolved = resolveLocalSeedEnv(projectRoot, {
			TREESEED_MARKET_LOCAL_POSTGRES_PORT: '55439',
		});
		expect(resolved.TREESEED_DATABASE_URL).toBe('postgres://treeseed:treeseed-local-dev@127.0.0.1:55439/treeseed_api');
		expect(resolved).not.toHaveProperty('TREESEED_MARKET_DATABASE_URL');

		const explicit = resolveLocalSeedEnv(projectRoot, {
			TREESEED_DATABASE_URL: 'postgres://configured-db',
		});
		expect(explicit.TREESEED_DATABASE_URL).toBe('postgres://configured-db');
	});

	it('targets the Treeseed PostgreSQL database and attaches the local owner', async () => {
		const tempRoot = mkdtempSync(resolve(tmpdir(), 'treeseed-local-seed-root-'));
		tempDirs.push(tempRoot);
		mkdirSync(resolve(tempRoot, 'seeds'), { recursive: true });
		copyFileSync(resolve(projectRoot, 'seeds', 'treeseed.yaml'), resolve(tempRoot, 'seeds', 'treeseed.yaml'));
		const { db, store } = createStore();
		try {
			await store.ensureInitialized();
			await store.run(
				`INSERT INTO users (id, email, display_name, status, metadata_json, created_at, updated_at)
				 VALUES (?, ?, ?, 'active', '{}', ?, ?)`,
				['user-local', 'adrian.webb@knowledge.coop', 'Adrian Webb', '2026-05-15T00:00:00.000Z', '2026-05-15T00:00:00.000Z'],
			);

			const applied = await applyLocalSeedViaApiFromCli({
				projectRoot: tempRoot,
				seedName: 'treeseed',
				environments: 'local',
				accessToken: localUserAccessToken(),
				db,
				env: {
					TREESEED_API_AUTH_SECRET: 'test-auth-secret',
					TREESEED_API_BOOTSTRAP_ADMIN_ALLOWLIST: 'adrian.webb@knowledge.coop',
				},
			} as any);

			expect(applied.plan.summary).toMatchObject({
				create: 29,
				update: 0,
				unchanged: 0,
				skip: 2,
			});
			expect((applied.result as any).localTeamMemberships).toEqual([
				expect.objectContaining({
					userId: 'user-local',
					email: 'adrian.webb@knowledge.coop',
					role: 'team_owner',
				}),
			]);

			const team = await store.getTeamBySlug('treeseed');
			expect(team?.id).toBeTruthy();
			const teamContext = await store.resolvePrincipalTeamContext(team!.id, { id: 'user-local', roles: [] });
			expect(teamContext?.roles).toContain('team_owner');
			const projects = await store.listTeamProjects(team!.id);
			expect(projects.map((project: any) => project.slug).sort()).toEqual(TREESEED_PROJECT_SLUGS);
		} finally {
			db.close();
		}
	}, 15000);

	it('creates the TreeSeed local portfolio and reports unchanged on repeat apply', async () => {
		const { db, store } = createStore();
		try {
			const first = await applyLocalSeedFromCli({
				projectRoot,
				seedName: 'treeseed',
				environments: 'local',
				store,
			});

			expect(first.plan.summary).toMatchObject({
				create: 29,
				update: 0,
				unchanged: 0,
				skip: 2,
			});

			const team = await store.getTeamBySlug('treeseed');
			expect(team?.metadata?.seed).toMatchObject({
				name: 'treeseed',
				version: 1,
				resourceKey: 'team:treeseed',
				manifestHash: first.result.manifestHash,
			});
			expect(team?.metadata?.visibility).toBe('private');

			const marketProject = await store.getProjectByTeamAndSlug(team!.id, 'market');
			expect(marketProject?.metadata?.metadata?.seed).toMatchObject({
				name: 'treeseed',
				resourceKey: 'project:treeseed/market',
			});

			const repositories = await store.listHubRepositories(marketProject!.id);
			expect(repositories).toHaveLength(1);
			expect(repositories[0]).toMatchObject({
				role: 'primary',
				provider: 'github',
				owner: 'knowledge-coop',
				name: 'market',
				url: 'https://github.com/knowledge-coop/market.git',
				defaultBranch: 'main',
			});
			expect(repositories[0].metadata?.seed).toMatchObject({
				resourceKey: 'project:treeseed/market',
				manifestHash: first.result.manifestHash,
			});

			const projectDetails = await store.getProjectDetails(marketProject!.id);
			expect(projectDetails?.hosting).toMatchObject({
				kind: 'self_hosted_project',
				registration: 'optional',
				sourceRepoOwner: 'knowledge-coop',
				sourceRepoName: 'market',
				sourceRepoUrl: 'https://github.com/knowledge-coop/market.git',
			});
			expect(projectDetails?.hosting?.metadata?.seed).toMatchObject({
				resourceKey: 'project:treeseed/market',
				manifestHash: first.result.manifestHash,
			});
			expect(projectDetails?.connection).toMatchObject({
				mode: 'hybrid',
				executionOwner: 'project_runner',
			});
			expect((await store.getProjectSummary(marketProject!.id))?.health.state).not.toBe('setup_needed');

			const projects = await store.listTeamProjects(team!.id);
			expect(projects.map((project: any) => project.slug).sort()).toEqual(TREESEED_PROJECT_SLUGS);
			expect(marketProject?.metadata?.metadata).toMatchObject({ visibility: 'private' });
			for (const slug of TREESEED_PACKAGE_SLUGS) {
				const packageProject = await store.getProjectByTeamAndSlug(team!.id, slug);
				expect(packageProject).toMatchObject({
					slug,
				});
				expect(packageProject?.metadata?.kind).toBe('package');
				expect(packageProject?.metadata?.metadata).toMatchObject({
					visibility: 'public',
					releaseOwnership: 'treeseed.package.yaml',
				});
				expect(packageProject?.metadata?.architecture).toMatchObject({
					topology: 'single_repository_site',
					rootPath: '.',
					sitePath: 'docs',
					contentPath: 'docs/src/content',
					contentRuntimeSource: 'r2_published_manifest',
					contentPublishTarget: {
						kind: 'cloudflare_r2',
						prefix: `packages/${slug}`,
					},
				});
				const packageRepositories = await store.listHubRepositories(packageProject!.id);
				expect(packageRepositories).toEqual([
					expect.objectContaining({
						role: 'primary',
						provider: 'github',
						owner: 'treeseed-ai',
						name: slug,
						url: `https://github.com/treeseed-ai/${slug}.git`,
						defaultBranch: 'main',
					}),
				]);
			}

			const repositoryHosts = await store.listRepositoryHosts(team!.id, { includePlatform: false });
			expect(repositoryHosts).toEqual(expect.arrayContaining([
				expect.objectContaining({
					provider: 'github',
					ownership: 'treeseed_managed',
					name: 'knowledge-coop',
					organizationOrOwner: 'knowledge-coop',
					metadata: expect.objectContaining({
						credentialRef: 'env:TREESEED_GITHUB_TOKEN',
						seed: expect.objectContaining({
							resourceKey: 'repository-host:treeseed/knowledge-coop-github',
							manifestHash: first.result.manifestHash,
						}),
					}),
				}),
				expect.objectContaining({
					provider: 'github',
					ownership: 'treeseed_managed',
					name: 'treeseed-ai',
					organizationOrOwner: 'treeseed-ai',
					defaultVisibility: 'public',
					metadata: expect.objectContaining({
						credentialRef: 'env:TREESEED_GITHUB_TOKEN',
						seed: expect.objectContaining({
							resourceKey: 'repository-host:treeseed/treeseed-ai-github',
							manifestHash: first.result.manifestHash,
						}),
					}),
				}),
			]));

			const products = await store.listTeamProducts(team!.id, { type: 'user', id: 'user-1', permissions: ['teams:manage:team'] } as any);
			expect(products.map((product: any) => product.slug).sort()).toEqual(expect.arrayContaining([
				'engineering',
				'research',
				'treeseed-market',
			]));
			const template = products.find((product: any) => product.slug === 'treeseed-market');
			expect(template).toMatchObject({
				kind: 'template',
				title: 'TreeSeed Market Starter',
				visibility: 'public',
				listingEnabled: true,
				artifactKey: 'catalog/treeseed-market/1.0.0/template',
			});
			expect(template?.metadata?.seed?.resourceKey).toBe('product:treeseed/market-template');
			const artifacts = await store.listCatalogArtifactVersions(template!.id);
			expect(artifacts[0]).toMatchObject({
				version: '1.0.0',
				contentKey: 'catalog/treeseed-market/1.0.0/template',
				manifestKey: 'seeds/treeseed.yaml',
			});
			expect(artifacts[0].metadata?.seed?.resourceKey).toBe('catalog-artifact:treeseed/market-template/1.0.0');

			const exported = await exportSeedWithStore({
				store,
				teamId: team!.id,
				name: 'treeseed',
				environments: 'local',
				includeArtifacts: true,
				includePrivate: false,
				principal: { type: 'user', id: 'user-1', permissions: ['projects:read:team'] },
			} as any);
			expect(exported.ok).toBe(true);
			expect(exported.yaml).toContain('repositoryHosts:');
			expect(exported.yaml).toContain('architecture:');
			expect(exported.yaml).toContain('topology: single_repository_site');
			expect(exported.yaml).toContain('sitePath: docs');
			expect(exported.yaml).toContain('products:');
			expect(exported.yaml).toContain('catalogArtifacts:');
			expect(exported.yaml).toContain('project:treeseed/api');
			expect(exported.yaml).toContain('project:treeseed/agent');
			expect(exported.yaml).not.toContain('capacityProviders:');
			expect(exported.yaml).not.toContain('capacityGrants:');
			expect(exported.yaml).not.toContain('project:karyon');
			expect(exported.yaml).not.toContain('repositoryTopology');
			expect(exported.yaml).not.toContain('contentRoot');
			expect(exported.yaml).not.toMatch(/encryptedPayload|BEGIN PRIVATE KEY|ghp_/u);

			const second = await applyLocalSeedFromCli({
				projectRoot,
				seedName: 'treeseed',
				environments: 'local',
				store,
			});

			expect(second.plan.summary).toMatchObject({
				create: 0,
				update: 0,
				unchanged: 29,
				skip: 2,
			});
		} finally {
			db.close();
		}
	});

	it('repairs missing project hosting for an unchanged seeded project', async () => {
		const { db, store } = createStore();
		try {
			await applyLocalSeedFromCli({
				projectRoot,
				seedName: 'treeseed',
				environments: 'local',
				store,
			});
			const team = await store.getTeamBySlug('treeseed');
			const marketProject = await store.getProjectByTeamAndSlug(team!.id, 'market');
			await store.run(`DELETE FROM project_connections WHERE project_id = ?`, [marketProject!.id]);
			await store.run(`DELETE FROM project_hosting WHERE project_id = ?`, [marketProject!.id]);

			const repaired = await applyLocalSeedFromCli({
				projectRoot,
				seedName: 'treeseed',
				environments: 'local',
				store,
			});
			expect(repaired.plan.summary).toMatchObject({
				create: 0,
				update: 0,
				unchanged: 29,
				skip: 2,
			});
			expect((repaired.result as any).repairs).toEqual([
				expect.objectContaining({ kind: 'projectHosting', projectId: marketProject!.id }),
			]);
			const details = await store.getProjectDetails(marketProject!.id);
			expect(details?.hosting).toMatchObject({
				kind: 'self_hosted_project',
				registration: 'optional',
				sourceRepoOwner: 'knowledge-coop',
				sourceRepoName: 'market',
			});
			expect(details?.connection).toMatchObject({
				mode: 'hybrid',
				executionOwner: 'project_runner',
			});
		} finally {
			db.close();
		}
	});

	it('does not overwrite existing project hosting during unchanged seed apply', async () => {
		const { db, store } = createStore();
		try {
			await applyLocalSeedFromCli({
				projectRoot,
				seedName: 'treeseed',
				environments: 'local',
				store,
			});
			const team = await store.getTeamBySlug('treeseed');
			const marketProject = await store.getProjectByTeamAndSlug(team!.id, 'market');
			await store.upsertProjectHosting(marketProject!.id, {
				kind: 'hosted_project',
				registration: 'required',
				marketBaseUrl: 'https://custom.example.com',
				sourceRepoOwner: 'custom-owner',
				sourceRepoName: 'custom-market',
				sourceRepoUrl: 'https://github.com/custom-owner/custom-market.git',
				sourceRepoWorkflowPath: '.github/workflows/custom.yml',
				executionOwner: 'project_api',
				metadata: { editedBy: 'test' },
			});

			const repeated = await applyLocalSeedFromCli({
				projectRoot,
				seedName: 'treeseed',
				environments: 'local',
				store,
			});
			expect((repeated.result as any).repairs).toEqual([]);
			const details = await store.getProjectDetails(marketProject!.id);
			expect(details?.hosting).toMatchObject({
				kind: 'hosted_project',
				registration: 'required',
				marketBaseUrl: 'https://custom.example.com',
				sourceRepoOwner: 'custom-owner',
				sourceRepoName: 'custom-market',
			});
			expect(details?.connection).toMatchObject({
				mode: 'hosted',
				executionOwner: 'project_api',
			});
		} finally {
			db.close();
		}
	});

	it('loads team seed page data without creating an audit run', async () => {
		const { db, store } = createStore();
		try {
			const team = await store.createTeam({
				slug: 'treeseed',
				name: 'treeseed',
				displayName: 'TreeSeed',
			});
			const context = {
				store,
				team,
				teams: [team],
				principal: {
					id: 'user-1',
					type: 'user',
				},
			};

			const seedPage: any = await loadInfrastructureSeedState({
				store: context.store,
				team: context.team,
				principal: context.principal,
				locals: {
					runtime: {
						env: {
							TREESEED_ENVIRONMENT: 'local',
						},
						resolved: {
							config: {
								repoRoot: projectRoot,
							},
						},
					},
				} as any,
				url: new URL('https://market.example.com/app/work/decisions'),
			});

			expect(seedPage.selectedSeed).toBe('treeseed');
			expect(seedPage.selectedEnvironments).toBe('local');
			expect(seedPage.plan.summary).toMatchObject({
				create: 28,
				update: 1,
				unchanged: 0,
				skip: 2,
			});
			expect(await store.listSeedRuns()).toHaveLength(0);
		} finally {
			db.close();
		}
	});
});
