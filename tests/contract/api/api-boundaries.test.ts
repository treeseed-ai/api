import { readFileSync } from 'node:fs';
import { describe,expect,it } from 'vitest';

describe('API backend boundaries', () => {
	it('keeps local content routes job-backed instead of filesystem-backed', () => {
		const source = readFileSync('src/api/routes/projects/access/projects-content-mutations.ts', 'utf8');
		const routeStart = source.indexOf("app.post('/v1/projects/:projectId/local-content/decisions/from-proposals'");
		expect(routeStart).toBeGreaterThan(-1);
		const routeBlock = source.slice(routeStart);
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

});
