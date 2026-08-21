import { createTestApp,createTestPostgresDatabase,describe,expect,it,json } from '../../../support/api-harness.ts';

describe('control-plane API', () => {
it('uses the Drizzle-owned web session schema before serving deep health', async () => {
		const db = createTestPostgresDatabase();
		const app = createTestApp({ db });
		const deepHealth = await json(await app.request('/healthz/deep'));
		expect(deepHealth).toMatchObject({
			data: {
				status: 'ok',
				checks: { database: true },
			},
		});

		const tableInfo = await db.prepare(`
			SELECT column_name AS name
			FROM information_schema.columns
			WHERE table_name = 'web_sessions'
		`).all();
		const columns = new Set(((tableInfo.results ?? []) as Array<{ name: string }>).map((row) => row.name));
		expect([...columns]).toEqual(expect.arrayContaining([
			'better_auth_session_id',
			'ip_address',
			'user_agent',
			'last_seen_at',
			'revoked_at',
		]));
	});
});
