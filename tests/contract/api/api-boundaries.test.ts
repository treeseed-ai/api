import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createExecutorsForOptions } from '../../../src/operations-runner/entrypoint.ts';

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
		const source = readFileSync('src/api/routes/projects/access/projects-capabilities-content-and-ci.ts', 'utf8');
		const routeStart = source.indexOf("app.post('/v1/projects/:projectId/local-content/decisions/from-proposals'");
		const routeEnd = source.indexOf("app.post('/v1/projects/:projectId/ci/oidc/exchange'", routeStart);
		expect(routeStart).toBeGreaterThan(-1);
		expect(routeEnd).toBeGreaterThan(routeStart);
		const routeBlock = source.slice(routeStart, routeEnd);
		expect(routeBlock).toContain('createPlatformOperation');
		expect(routeBlock).not.toMatch(/\bwriteLocalContentRecord\(|\bcreateRelatedLocalContentRecord\(|\bcreateDecisionFromProposals\(/u);
		expect(routeBlock).not.toMatch(/\bwriteFile\(|process\.cwd\(\).*src.*content/u);
	});

	it('keeps migration ownership in the PostgreSQL adapter boundary', () => {
		const storeSource = readFileSync('src/api/persistence/store.ts', 'utf8');
		const appSource = readFileSync('src/api/support/app.ts', 'utf8');
		const adapterSource = readFileSync('src/api/support/market-postgres.ts', 'utf8');
		const testSource = readFileSync('tests/support/api-harness.ts', 'utf8');
		expect(storeSource).not.toMatch(/migrations\/|migrationPaths|loadMigrationSql|PostgresD1Database/u);
		expect(storeSource).not.toMatch(/\bCREATE\s+TABLE\b|\bALTER\s+TABLE\b|PRAGMA\s+table_info/iu);
		expect(appSource).not.toContain('resolveApiD1Database');
		expect(appSource).not.toContain('postgres-d1');
		expect(adapterSource).not.toContain('PostgresD1');
		expect(testSource).not.toContain('TestD1Database');
		expect(adapterSource).toContain('applyDrizzleMigrations');
	});

	it('has no remote-job capacity-provider claim bypass', () => {
		const storeSource = readFileSync('src/api/persistence/store.ts', 'utf8');
		const appSource = readFileSync('src/api/support/app.ts', 'utf8');
		expect(storeSource).not.toContain('pullCapacityProviderJobs');
		expect(appSource).not.toContain('pullCapacityProviderJobs');
		expect(storeSource).not.toContain("json_extract(input_json, '$.capacity.providerId')");
	});

	it('has no destructive project-capacity evidence cleanup path', () => {
		const storeSource = readFileSync('src/api/persistence/store.ts', 'utf8');
		expect(storeSource).not.toContain('async deleteProject(');
		for (const table of ['capacity_usage_actuals', 'capacity_ledger_entries', 'capacity_reservations']) {
			expect(storeSource).not.toContain(`DELETE FROM ${table} WHERE project_id`);
		}
	});

	it('keeps project launch route persistence ahead of hosting readiness work', () => {
		const launchRoute = readFileSync('src/api/routes/projects/launch/projects-teams-item-projects-launch.ts', 'utf8');
		const launchPhases = readFileSync('src/api/routes/projects/launch/project-launch-phases.ts', 'utf8');
		const repositoryHostLookup = launchRoute.indexOf('let repositoryHost = await store.getRepositoryHost(teamId, repositoryHostId)');
		const audit = launchRoute.indexOf('hostingAudit = await runTreeseedHostingAudit');
		const createProject = launchRoute.indexOf('details = await store.createProject(c.req.param');
		const prepare = launchRoute.indexOf('await prepareProjectLaunch');
		const createJob = launchPhases.indexOf('const launchJob = await store.createJob');
		const createHubLaunch = launchPhases.indexOf('const hubLaunch = await store.createHubLaunch');
		const bootstrap = launchPhases.lastIndexOf('scheduleBackgroundBootstrap(');
		expect(repositoryHostLookup).toBeGreaterThan(-1);
		expect(audit).toBe(-1);
		expect(createProject).toBeGreaterThan(repositoryHostLookup);
		expect(prepare).toBeGreaterThan(createProject);
		expect(createJob).toBeGreaterThan(-1);
		expect(createHubLaunch).toBeGreaterThan(createJob);
		expect(bootstrap).toBeGreaterThan(createHubLaunch);
		expect(launchRoute).toContain('rejectProjectSecretUnlockMaterial');
		expect(launchRoute).toContain('sensitive_passphrase_rejected');
		expect(launchRoute).not.toContain('bindProviderCredentialSession');
		expect(launchRoute).not.toContain('Submit sensitivePassphrase');
	});

	it('keeps backend credential and launch recovery guardrails in API routes', () => {
		const api = [
			'src/api/routes/projects/operations/operations-project-jobs-and-credential-sessions.ts',
			'src/api/routes/projects/launch/projects-teams-item-projects-launch.ts',
			'src/api/routes/projects/launch/project-launch-phases.ts',
			'src/api/app/support/hosting/hosting-launch-bootstrap.ts',
			'src/api/app/support/configuration/foundation-configuration.ts',
			'src/api/routes/teams/teams-repository-and-web-hosts.ts',
		].map((path) => readFileSync(path, 'utf8')).join('\n');
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
