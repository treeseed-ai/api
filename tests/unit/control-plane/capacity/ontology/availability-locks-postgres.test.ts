import { randomUUID, generateKeyPairSync, createHash } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createControlPlanePostgresDatabase } from '../../../../../src/api/support/control-plane-postgres.ts';
import { AvailabilitySessionService } from '../../../../../src/api/capacity/services/accounts/availability-session-service.ts';
import { canonicalOfferBuildInput, signSuppliedOffer } from '../execution/fixtures/assignment-attempt-fixtures.ts';

const url = process.env.TREESEED_TEST_POSTGRES_URL;
async function clientForeignKeys(pool: pg.Pool, table: string): Promise<string[]> {
  const result = await pool.query<{ conname: string }>(`SELECT constraint_row.conname FROM pg_trigger trigger_row
    JOIN pg_constraint constraint_row ON constraint_row.oid=trigger_row.tgconstraint
    WHERE trigger_row.tgrelid=$1::regclass AND trigger_row.tgtype & 4 = 4 AND constraint_row.contype='f'
    ORDER BY trigger_row.tgname`, [table]);
  return result.rows.map(row => row.conname);
}
describe('availability publication foreign-key lock compatibility', () => {
  async function publishAlongside(kind: 'assignment' | 'reservation', operation: 'open' | 'refresh' = 'refresh') {
    if (!url) throw new Error('TREESEED_TEST_POSTGRES_URL is required; native availability lock coverage cannot be skipped.');
    const connection = new URL(url);
    if (connection.hostname !== '127.0.0.1' || connection.pathname !== '/postgres') throw new Error('Explicit disposable loopback PostgreSQL required.');
    const admin = new pg.Pool({ connectionString: connection.href });
    const name = `treeseed_availability_locks_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE "${name}"`);
    connection.pathname = `/${name}`;
    const db = createControlPlanePostgresDatabase(connection.href, { migrationMode: 'apply' });
    let release = () => {};
    const released = new Promise<void>(resolve => { release = resolve; });
    let entered = () => {};
    const publishing = new Promise<void>(resolve => { entered = resolve; });
    let consumer: pg.PoolClient | undefined;
    let spy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await db.migrate();
      const now = new Date().toISOString();
      const adapter = canonicalOfferBuildInput(now).providers[0]!;
      const signed = signSuppliedOffer(adapter.offers[0]!, generateKeyPairSync('ed25519').privateKey);
      await db.pool.query(`INSERT INTO teams (id,slug,name,created_at,updated_at) VALUES ('team','team','Team',$1,$1)`, [now]);
      await db.pool.query(`INSERT INTO projects (id,team_id,slug,name,created_at,updated_at) VALUES ('project','team','project','Project',$1,$1)`, [now]);
      await db.pool.query(`INSERT INTO capacity_providers (id,fingerprint,public_jwk_json,display_name,created_at,updated_at)
        VALUES ('provider',$2,$3,'Provider',$1,$1)`, [now,
          createHash('sha256').update(JSON.stringify(signed.publicJwk)).digest('hex'), JSON.stringify(signed.publicJwk)]);
      await db.pool.query(`INSERT INTO capacity_provider_team_memberships
        (id,team_id,capacity_provider_id,approved_at,approved_by_id,created_at,updated_at)
        VALUES ('membership','team','provider',$1,'test',$1,$1)`, [now]);
      await db.pool.query(`INSERT INTO project_agent_classes (id,team_id,project_id,slug,name,created_at,updated_at)
        VALUES ('engineer','team','project','engineer','Engineer',$1,$1)`, [now]);
      const store = { db, ensureInitialized: () => db.migrate(),
        run: async (sql: string, params: unknown[] = []) => { await db.prepare(sql).bind(...params).run(); },
        first: (sql: string, params: unknown[] = []) => db.prepare(sql).bind(...params).first(),
        all: async (sql: string, params: unknown[] = []) => (await db.prepare(sql).bind(...params).all()).results,
        batch: (operations: Array<{ query: string; params?: unknown[] }>) => db.batch(operations) };
      const service = new AvailabilitySessionService(store);
      const principal = { teamId: 'team', membershipId: 'membership', capacityProviderId: 'provider' };
      const input = { adapters: [{ id: 'codex', adapter: 'codex', runtimeBuild: `sha256:${'a'.repeat(64)}`,
        offers: [signed.offer], status: 'available', maxConcurrentWorkers: 5, laneIds: ['communication', 'platform', 'workday'] }],
        lanes: ['communication', 'platform', 'workday'].map(purpose => ({ id: purpose, purpose, maxConcurrentWorkers: 5 })) };
      const session = await service.open(principal, input);
      expect(session?.sequence).toBe(1);
      consumer = await db.pool.connect();
      await consumer.query('BEGIN');
      // Retain the KEY SHARE locks taken by real dependent foreign-key checks.
      // Force both live cycles: publisher waits for this row, consumer checks provider.
      await consumer.query(`SELECT id FROM capacity_execution_providers WHERE capacity_provider_id='provider' AND id='codex' FOR KEY SHARE`);
      if (kind === 'reservation') {
        // A reservation checks the execution-provider FK before the lane FK;
        // retaining only the latter would invent a reverse lock order.
        const order = await clientForeignKeys(db.pool, 'capacity_reservations');
        expect(order.indexOf('fk_capacity_reservations_execution_provider')).toBeLessThan(order.indexOf('fk_capacity_reservations_lane'));
        await consumer.query(`SELECT id FROM capacity_provider_lanes WHERE capacity_provider_id='provider' AND id='workday' FOR KEY SHARE`);
      }
      const original = db.transaction.bind(db);
      spy = vi.spyOn(db, 'transaction').mockImplementation(run => original(client => run(new Proxy(client, {
        get(target, key) {
          if (key === 'query') return async (sql: string, params?: unknown[]) => {
            // Pause after the production provider/membership/session row locks,
            // not a substituted transaction or synthetic foreign-key check.
            if (sql.startsWith('INSERT INTO capacity_execution_providers')) { entered(); await released; }
            return target.query(sql, params);
          };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }))));
      const refresh = operation === 'open' ? service.open(principal, input)
        : service.refresh(principal, session!.id, { ...input, expectedSequence: 1 });
      const refreshOutcome = refresh.then(value => ({ value }), error => ({ error }));
      await publishing;
      const client = consumer;
      const write = (async () => {
        try {
          if (kind === 'assignment') {
            await client.query(`INSERT INTO capacity_provider_assignments
              (id,team_id,project_id,project_agent_class_id,capacity_provider_id,membership_id,provider_session_id,execution_provider_id,lane_id,mode,status,created_at,updated_at)
              VALUES ('assignment','team','project','engineer','provider','membership',$2,'codex','workday','planning','leased',$1,$1)`, [now, session!.id]);
            await client.query(`UPDATE capacity_provider_assignments SET assignment_result_json='{}',updated_at=$1 WHERE id='assignment'`, [now]);
          } else {
            await client.query(`INSERT INTO capacity_reservations
              (id,idempotency_key,admission_token,membership_id,capacity_provider_id,execution_provider_id,lane_id,project_agent_class_id,mode,team_id,project_id,requested_seconds,reserved_seconds,created_at,updated_at)
              VALUES ('reservation','reservation','test','membership','provider','codex','workday','engineer','planning','team','project',180,180,$1,$1)`, [now]);
          }
          await client.query('COMMIT');
          return { committed: true };
        } catch (error) { await client.query('ROLLBACK'); return { error }; }
      })();
      release();
      const [publication, mutation] = await Promise.all([refreshOutcome, write]);
      expect(publication).not.toHaveProperty('error');
      expect(mutation).toEqual({ committed: true });
      expect((await service.get('team', session!.id))?.sequence).toBe(operation === 'refresh' ? 2 : 1);
      expect((await service.get('team', session!.id))?.status).toBe(operation === 'refresh' ? 'open' : 'closed');
      const table = kind === 'assignment' ? 'capacity_provider_assignments' : 'capacity_reservations';
      expect((await db.pool.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count).toBe(1);
    } finally {
      release(); spy?.mockRestore();
      if (consumer) { await consumer.query('ROLLBACK'); consumer.release(); }
      await db.close(); await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); await admin.end();
    }
  }
  it('publishes while a concurrent assignment write holds a dependent provider row', () => publishAlongside('assignment'), 30_000);
  it('publishes while a concurrent reservation write holds a dependent provider row', () => publishAlongside('reservation'), 30_000);
  it('opens availability while an assignment FK write holds a dependent provider row', () => publishAlongside('assignment', 'open'), 30_000);
  it('opens availability while a reservation FK write holds a dependent provider row', () => publishAlongside('reservation', 'open'), 30_000);
});
