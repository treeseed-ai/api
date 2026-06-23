import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DataType, newDb } from 'pg-mem';
import { MarketControlPlaneStore } from '../../src/api/store.js';
import { MarketPostgresDatabase } from '../../src/api/market-postgres.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const marketMigrationRoot = existsSync(resolve(packageRoot, '../sdk/drizzle/market'))
	? resolve(packageRoot, '../sdk/drizzle/market')
	: resolve(packageRoot, 'node_modules/@treeseed/sdk/drizzle/market');

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
		repoRoot: packageRoot,
		authSecret: 'test-auth-secret',
		assertionSecret: 'test-assertion-secret',
		serviceId: 'web',
		serviceSecret: 'test-service-secret',
	}, db);
	return { db, store };
}

describe('workday test runs', () => {
	it('persists test runs and ordered audit events', async () => {
		const { db, store } = createStore();
		try {
			await store.ensureInitialized();
			await store.createTeam({
				id: 'team-test',
				slug: 'treeseed',
				name: 'TreeSeed',
			});

			const run = await store.createWorkdayTestRun('team-test', {
				id: 'run-test',
				capacityProviderId: 'provider-local',
				status: 'running',
				parameters: { providerToken: 'secret-value', projects: ['market'] },
				expected: { projects: ['market'] },
			});
			expect(run).toMatchObject({
				id: 'run-test',
				teamId: 'team-test',
				status: 'running',
				capacityProviderId: 'provider-local',
				parameters: { providerToken: 'secret-value', projects: ['market'] },
			});

			const first = await store.createWorkdayTestEvent('team-test', 'run-test', {
				eventType: 'command.started',
				title: 'Started',
				parameters: { projects: ['market'] },
			});
			const second = await store.createWorkdayTestEvent('team-test', 'run-test', {
				eventType: 'command.completed',
				status: 'completed',
				title: 'Completed',
			});
			expect(first?.eventIndex).toBe(0);
			expect(second?.eventIndex).toBe(1);

			const updated = await store.updateWorkdayTestRun('team-test', 'run-test', {
				status: 'completed',
				metrics: { score: 100 },
				reportRefs: { jsonPath: '.treeseed/test-reports/workday-test-run-test.json' },
			});
			expect(updated).toMatchObject({
				status: 'completed',
				metrics: { score: 100 },
			});
			expect(updated?.completedAt).toBeTruthy();

			const events = await store.listWorkdayTestEvents('team-test', 'run-test');
			expect(events.map((event) => event.eventType)).toEqual(['command.started', 'command.completed']);
			const runs = await store.listWorkdayTestRuns('team-test');
			expect(runs.map((entry) => entry.id)).toEqual(['run-test']);
		} finally {
			db.close();
		}
	});
});
