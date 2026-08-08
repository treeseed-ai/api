import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataType,newDb } from 'pg-mem';
import { describe,expect,it } from 'vitest';
import { MarketControlPlaneStore } from '../../../../src/api/persistence/store.js';
import { MarketPostgresDatabase } from '../../../../src/api/support/market-postgres.js';
import { applyLocalSeedFromCli } from '../../../../src/market/seeds/apply.js';
import { seedTreeDxFetch } from '../../../support/seed-treedx.js';

const packageRoot = process.cwd();
const seedRoot = resolve(packageRoot, 'tests/fixtures/seed-project');
const migrationRoot = existsSync(resolve(packageRoot, '../sdk/drizzle/market'))
	? resolve(packageRoot, '../sdk/drizzle/market')
	: resolve(packageRoot, 'node_modules/@treeseed/sdk/drizzle/market');

function createStore() {
	const memory = newDb();
	memory.public.registerFunction({ name: "replace", args: [DataType.text, DataType.text, DataType.text], returns: DataType.text, implementation: (value: string, search: string, replacement: string) => value.split(search).join(replacement) });
	memory.public.registerFunction({ name: 'md5', args: [DataType.text], returns: DataType.text,
		implementation: (value: string) => `md5:${value}` });
	const pg = memory.adapters.createPg();
	const db = MarketPostgresDatabase.fromPool(new pg.Pool(), { migrationRoot });
	return { db, store: new MarketControlPlaneStore({ repoRoot: packageRoot, projectId: 'treeseed-market-test',
		authSecret: 'test-auth-secret', assertionSecret: 'test-assertion-secret', serviceId: 'web',
		serviceSecret: 'test-service-secret', fetchImpl: seedTreeDxFetch }, db) };
}

describe('seeded project visibility reconciliation', () => {
	it('detects and repairs project metadata drift before checking seed postconditions', async () => {
		const { db,store } = createStore();
		try {
			await applyLocalSeedFromCli({ projectRoot: seedRoot, seedName: 'treeseed', environments: 'local', store });
			const team = await store.getTeamBySlug('treeseed');
			const project = await store.getProjectByTeamAndSlug(team!.id, 'market');
			await store.run('UPDATE projects SET metadata_json = ? WHERE id = ?', [
				JSON.stringify({ ...project!.metadata, metadata: { ...project!.metadata.metadata, visibility: 'private' } }), project!.id,
			]);

			const repaired = await applyLocalSeedFromCli({ projectRoot: seedRoot, seedName: 'treeseed', environments: 'local', store });
			expect(repaired.plan.actions).toEqual(expect.arrayContaining([
				expect.objectContaining({ key: 'project:treeseed/market', action: 'update' }),
			]));
			const current = await store.getProjectByTeamAndSlug(team!.id, 'market');
			expect(current?.metadata?.metadata?.visibility).toBe('public');
			expect(current?.metadata?.metadata).not.toHaveProperty('metadata');
		} finally {
			db.close();
		}
	});
});
