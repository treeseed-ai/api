import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createExecutorsForOptions } from '../../src/operations-runner/entrypoint.ts';

describe('API backend boundaries', () => {
	it('registers project-host operation executors on the Treeseed operations runner', () => {
		const capabilities = createExecutorsForOptions({ operationKey: null })
			.map((executor) => `${executor.namespace}:${executor.operation}`);
		expect(capabilities).toEqual(expect.arrayContaining([
			'repository:initialize_linked_repository',
			'project_hosts:host_binding_audit',
			'project_hosts:host_binding_resync',
			'project_hosts:host_binding_replace',
			'project_hosts:host_binding_rotate',
		]));
	});

	it('keeps local content routes job-backed instead of filesystem-backed', () => {
		const source = readFileSync('src/api/app.ts', 'utf8');
		const routeStart = source.indexOf("app.post('/v1/projects/:projectId/local-content/decisions/from-proposals'");
		const routeEnd = source.indexOf("app.post('/v1/projects/:projectId/update-plans'", routeStart);
		expect(routeStart).toBeGreaterThan(-1);
		expect(routeEnd).toBeGreaterThan(routeStart);
		const routeBlock = source.slice(routeStart, routeEnd);
		expect(routeBlock).toContain('createPlatformOperation');
		expect(routeBlock).not.toMatch(/\bwriteLocalContentRecord\(|\bcreateRelatedLocalContentRecord\(|\bcreateDecisionFromProposals\(/u);
		expect(routeBlock).not.toMatch(/\bwriteFile\(|process\.cwd\(\).*src.*content/u);
	});

	it('keeps migration ownership in the PostgreSQL adapter boundary', () => {
		const storeSource = readFileSync('src/api/store.ts', 'utf8');
		const appSource = readFileSync('src/api/app.ts', 'utf8');
		const adapterSource = readFileSync('src/api/market-postgres.ts', 'utf8');
		const testSource = readFileSync('test/api/api.test.ts', 'utf8');
		expect(storeSource).not.toMatch(/migrations\/|migrationPaths|loadMigrationSql|PostgresD1Database/u);
		expect(storeSource).not.toMatch(/\bCREATE\s+TABLE\b|\bALTER\s+TABLE\b|PRAGMA\s+table_info/iu);
		expect(appSource).not.toContain('resolveApiD1Database');
		expect(appSource).not.toContain('postgres-d1');
		expect(adapterSource).not.toContain('PostgresD1');
		expect(testSource).not.toContain('TestD1Database');
		expect(adapterSource).toContain('applyDrizzleMigrations');
	});

	it('keeps project launch route persistence ahead of hosting readiness work', () => {
		const api = readFileSync('src/api/app.ts', 'utf8');
		const routeStart = api.indexOf("app.post('/v1/teams/:teamId/projects/launch'");
		const routeEnd = api.indexOf("app.get('/v1/projects/:projectId'", routeStart);
		const launchRoute = api.slice(routeStart, routeEnd);
		const repositoryHostLookup = launchRoute.indexOf('let repositoryHost = await store.getRepositoryHost(teamId, repositoryHostId)');
		const audit = launchRoute.indexOf('hostingAudit = await runTreeseedHostingAudit');
		const createProject = launchRoute.indexOf('details = await store.createProject(c.req.param');
		const createJob = launchRoute.indexOf('const launchJob = await store.createJob');
		const createHubLaunch = launchRoute.indexOf('const hubLaunch = await store.createHubLaunch');
		const bootstrap = launchRoute.indexOf('scheduleBackgroundBootstrap');
		expect(repositoryHostLookup).toBeGreaterThan(-1);
		expect(audit).toBe(-1);
		expect(createProject).toBeGreaterThan(repositoryHostLookup);
		expect(createJob).toBeGreaterThan(createProject);
		expect(createHubLaunch).toBeGreaterThan(createJob);
		expect(bootstrap).toBeGreaterThan(createHubLaunch);
		expect(launchRoute).toContain('rejectProjectSecretUnlockMaterial');
		expect(launchRoute).toContain('sensitive_passphrase_rejected');
		expect(launchRoute).not.toContain('bindProviderCredentialSession');
		expect(launchRoute).not.toContain('Submit sensitivePassphrase');
	});

	it('keeps backend credential and launch recovery guardrails in API routes', () => {
		const api = readFileSync('src/api/app.ts', 'utf8');
		expect(api).toContain('retryApiLaunchBootstrapFromRequest');
		expect(api).toContain('rejectProjectSecretUnlockMaterial');
		expect(api).toContain('sensitive_passphrase_rejected');
		expect(api).not.toContain('sensitive_passphrase_required');
		expect(api).toContain('runProjectLaunchApiBootstrap');
		expect(api).toContain('rejectPlaintextHostCredentialFields');
		expect(api).toContain("if (hostKind === 'email_host')");
		expect(api).toContain("SMTP_HOST: smtp.host.trim()");
		expect(api).not.toContain("'smtpHost',");
		expect(api).not.toContain("'SMTP_HOST',");
	});
});
