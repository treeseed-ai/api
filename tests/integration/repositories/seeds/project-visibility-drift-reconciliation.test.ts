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
	memory.public.registerFunction({ name: 'md5', args: [DataType.text], returns: DataType.text,
		implementation: (value: string) => `md5:${value}` });
	const pg = memory.adapters.createPg();
	const db = ControlPlanePostgresDatabase.fromPool(new pg.Pool(), { migrationRoot });
	return { db, store: new ControlPlaneStore({ repoRoot: packageRoot, projectId: 'treeseed-api-test',
		authSecret: 'test-auth-secret', assertionSecret: 'test-assertion-secret', serviceId: 'web',
		serviceSecret: 'test-service-secret', fetchImpl: seedTreeDxFetch }, db) };
}

describe('seeded project visibility reconciliation', () => {
	it('detects and repairs project metadata drift before checking seed postconditions', async () => {
		const { db,store } = createStore();
		try {
			await applyLocalSeedFromCli({ projectRoot: seedRoot, seedName: 'treeseed', environments: 'local', store });
			const team = await store.getTeamBySlug('treeseed');
			const project = await store.getProjectByTeamAndSlug(team!.id, 'api');
			await store.run('UPDATE projects SET metadata_json = ? WHERE id = ?', [
				JSON.stringify({ ...project!.metadata, metadata: { ...project!.metadata.metadata, visibility: 'private' } }), project!.id,
			]);

			const repaired = await applyLocalSeedFromCli({ projectRoot: seedRoot, seedName: 'treeseed', environments: 'local', store });
			expect(repaired.plan.actions).toEqual(expect.arrayContaining([
				expect.objectContaining({ key: 'project:treeseed/api', action: 'update' }),
			]));
			const current = await store.getProjectByTeamAndSlug(team!.id, 'api');
			expect(current?.metadata?.metadata?.visibility).toBe('public');
			expect(current?.metadata?.metadata).not.toHaveProperty('metadata');
		} finally {
			db.close();
		}
	});
});
