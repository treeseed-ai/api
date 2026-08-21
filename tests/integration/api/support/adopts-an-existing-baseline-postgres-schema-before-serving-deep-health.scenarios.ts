import { ControlPlanePostgresDatabase } from '../../../../src/api/support/control-plane-postgres.ts';
import { createTestApp,createTestPostgresDatabase,describe,expect,it,json } from '../../../support/api-harness.ts';

import { controlPlaneMigrationRoot } from '../../../support/api-harness.ts';

describe('control-plane API database', () => {
it('adopts an existing baseline Postgres schema before serving deep health', async () => {
		const legacyDb = createTestPostgresDatabase();
		await legacyDb.migrate();
		await legacyDb.pool.query(`DELETE FROM treeseed_control_plane_schema_migrations WHERE name = '0000_control_plane.sql'`);
		const db = ControlPlanePostgresDatabase.fromPool(legacyDb.pool, { migrationRoot: controlPlaneMigrationRoot });
		const app = createTestApp({ db });
		const deepHealth = await json(await app.request('/healthz/deep'));
		expect(deepHealth, JSON.stringify(deepHealth)).toMatchObject({
			ok: true,
			status: 'ok',
			checks: {
				database: true,
			},
		});
		const migration = await db.pool.query(
			`SELECT name FROM treeseed_control_plane_schema_migrations WHERE name = '0000_control_plane.sql'`,
		);
		expect(migration.rows).toHaveLength(1);
	});
});
