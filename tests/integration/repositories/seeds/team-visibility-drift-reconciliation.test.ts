import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataType,newDb } from 'pg-mem';
import { describe,expect,it } from 'vitest';
import { ControlPlaneStore } from '../../../../src/api/persistence/store.js';
import { ControlPlanePostgresDatabase } from '../../../../src/api/support/control-plane-postgres.js';
import { applyLocalSeedFromCli } from '../../../../src/control-plane/seeds/apply.js';
import { seedTreeDxFetch } from '../../../support/seed-treedx.js';

const packageRoot = process.cwd();
const seedRoot = resolve(packageRoot, 'tests/fixtures/seed-project');
const migrationRoot = resolve(packageRoot, 'drizzle/control-plane');

function createStore() {
	const memory = newDb();
	memory.public.registerFunction({ name: "replace", args: [DataType.text, DataType.text, DataType.text], returns: DataType.text, implementation: (value: string, search: string, replacement: string) => value.split(search).join(replacement) });
	memory.public.registerFunction({
		name: 'md5',
		args: [DataType.text],
		returns: DataType.text,
		implementation: (value: string) => `md5:${value}`,
	});
	const pg = memory.adapters.createPg();
	const db = ControlPlanePostgresDatabase.fromPool(new pg.Pool(), { migrationRoot });
	const store = new ControlPlaneStore({
		repoRoot: packageRoot,
		projectId: 'treeseed-market-test',
		authSecret: 'test-auth-secret',
		assertionSecret: 'test-assertion-secret',
		serviceId: 'web',
		serviceSecret: 'test-service-secret',
		fetchImpl: seedTreeDxFetch,
	}, db);
	return { db, store };
}

describe('seeded team visibility reconciliation', () => {
	it('detects and repairs profile visibility drift from the canonical seed', async () => {
		const { db, store } = createStore();
		try {
			await applyLocalSeedFromCli({
				projectRoot: seedRoot,
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
				projectRoot: seedRoot,
				seedName: 'treeseed',
				environments: 'local',
				store,
			});
			expect(repaired.plan.summary).toMatchObject({ create: 0, update: 1, skip: 0 });
			expect((await store.getTeamBySlug('treeseed'))?.metadata?.visibility).toBe('public');
			expect(await store.loadTeamProfileByName('treeseed')).toEqual(expect.objectContaining({
				team: expect.objectContaining({ name: 'treeseed' }),
			}));
		} finally {
			db.close();
		}
	});
});
