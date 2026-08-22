import { createTestApp,createTestPostgresDatabase,describe,expect,it,json } from '../../../support/api-harness.ts';


describe('control-plane API database', () => {
it('repairs an incomplete Postgres baseline with a stale applied marker before serving deep health', async () => {
		const db = createTestPostgresDatabase();
		await db.pool.query(`CREATE TABLE IF NOT EXISTS treeseed_control_plane_schema_migrations (
			name text PRIMARY KEY,
			applied_at text NOT NULL
		)`);
		await db.pool.query(
			`INSERT INTO treeseed_control_plane_schema_migrations (name, applied_at) VALUES ($1, $2)`,
			['0000_control_plane.sql', new Date().toISOString()],
		);
		const app = createTestApp({ db });
		const deepHealth = await json(await app.request('/v1/health/deep'));
		expect(deepHealth).toMatchObject({
			data: {
				status: 'ok',
				checks: { database: true },
			},
		});
		const table = await db.pool.query(
			`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'capacity_providers'`,
		);
		expect(table.rows).toHaveLength(1);
	});
});
