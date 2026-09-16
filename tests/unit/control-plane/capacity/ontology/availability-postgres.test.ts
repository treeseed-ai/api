import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createControlPlanePostgresDatabase } from '../../../../../src/api/support/control-plane-postgres.ts';
import { AvailabilitySessionService } from '../../../../../src/api/capacity/services/accounts/availability-session-service.ts';
import { AvailabilitySessionRepository } from '../../../../../src/api/capacity/repositories/accounts/availability-session.ts';

const url = process.env.TREESEED_TEST_POSTGRES_URL;
describe.skipIf(!url)('provider accounting in disposable PostgreSQL', () => {
  it('serializes observations across memberships before validation and publication', async () => {
    const connection = new URL(url!);
    if (connection.hostname !== '127.0.0.1' || connection.pathname !== '/postgres') throw new Error('Explicit disposable loopback PostgreSQL required.');
    const admin = new pg.Pool({ connectionString: connection.href });
    const name = `treeseed_availability_test_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE "${name}"`);
    connection.pathname = `/${name}`;
    const db = createControlPlanePostgresDatabase(connection.href, { migrationMode: 'apply' });
    let release = () => {};
    const released = new Promise<void>(resolve => { release = resolve; });
    let entered = () => {};
    const firstEntered = new Promise<void>(resolve => { entered = resolve; });
    const original = AvailabilitySessionRepository.prototype.open;
    const spy = vi.spyOn(AvailabilitySessionRepository.prototype, 'open').mockImplementation(async function(write, operations) {
      if (write.membershipId === 'membership-first') { entered(); await released; }
      return original.call(this, write, operations);
    });
    try {
      await db.migrate();
      const now = new Date().toISOString();
      await db.pool.query(`INSERT INTO capacity_providers (id,fingerprint,public_jwk_json,display_name,created_at,updated_at)
        VALUES ('provider','test','{}','Provider',$1,$1)`, [now]);
      for (const team of ['first', 'second']) {
        await db.pool.query(`INSERT INTO teams (id,slug,name,created_at,updated_at) VALUES ($1,$1,$1,$2,$2)`, [team, now]);
        await db.pool.query(`INSERT INTO capacity_provider_team_memberships
          (id,team_id,capacity_provider_id,approved_at,approved_by_id,created_at,updated_at)
          VALUES ($1,$2,'provider',$3,'test',$3,$3)`, [`membership-${team}`, team, now]);
      }
      const store = { db, ensureInitialized: () => db.migrate(),
        run: async (sql: string, params: unknown[] = []) => { await db.prepare(sql).bind(...params).run(); },
        first: (sql: string, params: unknown[] = []) => db.prepare(sql).bind(...params).first(),
        all: async (sql: string, params: unknown[] = []) => (await db.prepare(sql).bind(...params).all()).results,
        batch: (operations: Array<{ query: string; params?: unknown[] }>) => db.batch(operations) };
      const service = new AvailabilitySessionService(store);
      const input = (activeSeconds: number) => {
        const observed = { day: now.slice(0, 10), observedAt: now, healthy: true, activeSeconds, reservedSeconds: 0 };
        return { adapters: [{ id: 'codex-implementation', adapter: 'codex', runtimeBuild: `sha256:${'a'.repeat(64)}`,
          status: 'available', maxConcurrentWorkers: 1, laneIds: ['communication', 'platform', 'workday'],
          nativeLimits: { modelConfigurationId: 'terra-medium', dailyActiveSecondsLimit: 28800,
            capabilityLimits: { implementation: { dailyActiveSecondsLimit: 28800 } } },
          accountingObservation: { modelUsage: observed, capabilityUsage: { implementation: observed } } }],
          lanes: ['communication', 'platform', 'workday'].map(purpose => ({ id: purpose, purpose, maxConcurrentWorkers: 1 })) };
      };
      const principal = (team: string) => ({ teamId: team, membershipId: `membership-${team}`, capacityProviderId: 'provider' });
      const first = service.open(principal('first'), input(2));
      await firstEntered;
      const second = service.open(principal('second'), input(1));
      const rejection = expect(second).rejects.toMatchObject({ code: 'provider_accounting_regressed' });
      release();
      expect((await first)?.snapshot.adapters[0]?.accountingObservation?.modelUsage.activeSeconds).toBe(2);
      await rejection;
      expect((await db.pool.query('SELECT count(*)::int AS count FROM capacity_provider_availability_sessions')).rows[0].count).toBe(1);
    } finally {
      release(); spy.mockRestore(); await db.close();
      await admin.query(`DROP DATABASE "${name}"`); await admin.end();
    }
  }, 30_000);
});
