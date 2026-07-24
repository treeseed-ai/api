import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, Core, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../support/api-harness.ts';

import { marketMigrationRoot } from '../../../support/api-harness.ts';

describe('market api', () => {
it('repairs an incomplete Postgres baseline with a stale applied marker before serving deep health', async () => {
		const db = createTestPostgresDatabase();
		await db.pool.query(`CREATE TABLE IF NOT EXISTS treeseed_market_schema_migrations (
			name text PRIMARY KEY,
			applied_at text NOT NULL
		)`);
		await db.pool.query(
			`INSERT INTO treeseed_market_schema_migrations (name, applied_at) VALUES ($1, $2)`,
			['0000_market_control_plane.sql', new Date().toISOString()],
		);
		const app = createTestApp({ db });
		const deepHealth = await json(await app.request('/healthz/deep'));
		expect(deepHealth).toMatchObject({
			ok: true,
			status: 'ok',
			checks: {
				database: true,
			},
		});
		const table = await db.pool.query(
			`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'capacity_providers'`,
		);
		expect(table.rows).toHaveLength(1);
	});
});
