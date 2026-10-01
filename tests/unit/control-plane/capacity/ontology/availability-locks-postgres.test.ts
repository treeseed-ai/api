import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createControlPlanePostgresDatabase } from '../../../../../src/api/support/control-plane-postgres.ts';
import { AvailabilitySessionService } from '../../../../../src/api/capacity/services/accounts/availability-session-service.ts';
import { AvailabilitySessionRepository } from '../../../../../src/api/capacity/repositories/accounts/availability-session.ts';

const url = process.env.TREESEED_TEST_POSTGRES_URL;
describe.skipIf(!url)('availability publication foreign-key lock compatibility', () => {
  async function publishAlongside(kind: 'assignment' | 'reservation') {
    const connection = new URL(url!);
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
      await db.pool.query(`INSERT INTO teams (id,slug,name,created_at,updated_at) VALUES ('team','team','Team',$1,$1)`, [now]);
      await db.pool.query(`INSERT INTO projects (id,team_id,slug,name,created_at,updated_at) VALUES ('project','team','project','Project',$1,$1)`, [now]);
      await db.pool.query(`INSERT INTO capacity_providers (id,fingerprint,public_jwk_json,display_name,created_at,updated_at)
        VALUES ('provider','test','{}','Provider',$1,$1)`, [now]);
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
        status: 'available', maxConcurrentWorkers: 5, laneIds: ['communication', 'platform', 'workday'] }],
        lanes: ['communication', 'platform', 'workday'].map(purpose => ({ id: purpose, purpose, maxConcurrentWorkers: 5 })) };
      const session = await service.open(principal, input);
      expect(session?.sequence).toBe(1);
      consumer = await db.pool.connect();
      await consumer.query('BEGIN');
      // Admission/completion can retain dependent row locks before their FK checks.
      // Force both live cycles: publisher waits for this row, consumer checks provider.
      await consumer.query(kind === 'assignment'
        ? `SELECT id FROM capacity_execution_providers WHERE capacity_provider_id='provider' AND id='codex' FOR UPDATE`
        : `SELECT id FROM capacity_provider_lanes WHERE capacity_provider_id='provider' AND id='workday' FOR UPDATE`);
      const original = AvailabilitySessionRepository.prototype.refresh;
      spy = vi.spyOn(AvailabilitySessionRepository.prototype, 'refresh').mockImplementation(async function(write, sequence, operations) {
        entered(); await released;
        return original.call(this, write, sequence, operations);
      });
      const refresh = service.refresh(principal, session!.id, { ...input, expectedSequence: 1 });
      const refreshOutcome = refresh.then(value => ({ value }), error => ({ error }));
      await publishing;
      const client = consumer;
      const write = (async () => {
        try {
          if (kind === 'assignment') {
            await client.query(`INSERT INTO capacity_provider_assignments
              (id,team_id,project_id,project_agent_class_id,capacity_provider_id,membership_id,execution_provider_id,lane_id,mode,status,created_at,updated_at)
              VALUES ('assignment','team','project','engineer','provider','membership','codex','workday','planning','leased',$1,$1)`, [now]);
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
      expect((await service.get('team', session!.id))?.sequence).toBe(2);
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
});
