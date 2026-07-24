import { MarketPostgresDatabase } from '../../../../src/api/support/market-postgres.ts';
import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, PlatformRunnerClient, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, Core, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../support/api-harness.ts';

import { marketMigrationRoot } from '../../../support/api-harness.ts';

describe('market api', () => {
it('adopts an existing baseline Postgres schema before serving deep health', async () => {
		const legacyDb = createTestPostgresDatabase();
		await legacyDb.migrate();
		await legacyDb.pool.query(`DELETE FROM treeseed_market_schema_migrations WHERE name = '0000_market_control_plane.sql'`);
		const db = MarketPostgresDatabase.fromPool(legacyDb.pool, { migrationRoot: marketMigrationRoot });
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
			`SELECT name FROM treeseed_market_schema_migrations WHERE name = '0000_market_control_plane.sql'`,
		);
		expect(migration.rows).toHaveLength(1);
	});
});
