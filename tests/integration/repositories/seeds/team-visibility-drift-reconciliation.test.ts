import { DataType, newDb } from 'pg-mem';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MarketControlPlaneStore } from '../../../../src/api/persistence/store.js';
import { MarketPostgresDatabase } from '../../../../src/api/support/market-postgres.js';
import { applyLocalSeedFromCli } from '../../../../src/market/seeds/apply.js';

const projectRoot = process.cwd();
const migrationRoot = existsSync(resolve(projectRoot, '../sdk/drizzle/market'))
	? resolve(projectRoot, '../sdk/drizzle/market')
	: resolve(projectRoot, 'node_modules/@treeseed/sdk/drizzle/market');

function createStore() {
	const memory = newDb();
	memory.public.registerFunction({
		name: 'md5',
		args: [DataType.text],
		returns: DataType.text,
		implementation: (value: string) => `md5:${value}`,
	});
	const pg = memory.adapters.createPg();
	const db = MarketPostgresDatabase.fromPool(new pg.Pool(), { migrationRoot });
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

describe('seeded team visibility reconciliation', () => {
	it('detects and repairs profile visibility drift from the canonical seed', async () => {
		const { db, store } = createStore();
		try {
			await applyLocalSeedFromCli({
				projectRoot,
				seedName: 'treeseed',
				environments: 'local',
				store,
			});
			const team = await store.getTeamBySlug('treeseed');
			expect(await store.loadTeamProfileByName('treeseed')).toEqual(expect.objectContaining({
				team: expect.objectContaining({ name: 'treeseed' }),
			}));

			await store.run('UPDATE teams SET metadata_json = ? WHERE id = ?', [
				JSON.stringify({ ...team!.metadata, visibility: 'private' }),
				team!.id,
			]);
			expect(await store.loadTeamProfileByName('treeseed')).toBeNull();

			const repaired = await applyLocalSeedFromCli({
				projectRoot,
				seedName: 'treeseed',
				environments: 'local',
				store,
			});
			expect(repaired.plan.summary).toMatchObject({
				create: 0,
				update: 1,
				unchanged: 19,
				skip: 0,
			});
			expect((await store.getTeamBySlug('treeseed'))?.metadata?.visibility).toBe('public');
			expect(await store.loadTeamProfileByName('treeseed')).toEqual(expect.objectContaining({
				team: expect.objectContaining({ name: 'treeseed' }),
			}));
		} finally {
			db.close();
		}
	});
});
