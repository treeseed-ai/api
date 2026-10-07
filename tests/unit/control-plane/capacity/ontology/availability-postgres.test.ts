import { randomUUID, generateKeyPairSync, createHash } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createControlPlanePostgresDatabase } from '../../../../../src/api/support/control-plane-postgres.ts';
import { AvailabilitySessionService } from '../../../../../src/api/capacity/services/accounts/availability-session-service.ts';
import { AvailabilitySessionRepository } from '../../../../../src/api/capacity/repositories/accounts/availability-session.ts';
import { postgresGraph } from '../execution/graph/architecture/living/living-postgres-fixture.ts';
import { canonicalOfferBuildInput, executionCapability, invalidCanonicalOffers, invalidQualificationOffers, signSuppliedOffer, substitutedSignedOffers } from '../execution/fixtures/assignment-attempt-fixtures.ts';
import { CORE_CAPABILITY_DEFINITIONS } from '@treeseed/sdk/capacity-provider';
import { appliedWorkdaySchema } from '@treeseed/sdk/agent-capacity';
import { resolveProviderSynthesisContext } from '../../../../../src/api/capacity/services/capacity/providers/provider-synthesis-context-service.ts';
import { buildAssignmentAttempt } from '../../../../../src/api/capacity/services/capacity/assignments/planning/execution/assignment-attempt-builder.ts';
import { CapacityGovernanceError } from '../../../../../src/api/capacity/database.ts';

const url = process.env.TREESEED_TEST_POSTGRES_URL;
describe('provider accounting in disposable PostgreSQL', () => {
  it('native canonical availability publication freezes exact executable supply and denies corrupted retained qualification before assignment with independent immutable SQL readback', async () => {
    const f = await postgresGraph();
    try {
      const original = canonicalOfferBuildInput(new Date().toISOString()), adapter = original.providers[0]!;
      const registeredKey = generateKeyPairSync('ed25519').privateKey, signed = signSuppliedOffer(adapter.offers[0]!, registeredKey);
      adapter.offers = [signed.offer]; const before = structuredClone(original), identityBefore = structuredClone(signed.publicJwk);
      await f.left.pool.query(`INSERT INTO capacity_providers (id,fingerprint,public_jwk_json,display_name,created_at,updated_at)
        VALUES ('provider',$2,$3,'Controlled publication input',$1,$1)`, [original.now,
          createHash('sha256').update(JSON.stringify(signed.publicJwk)).digest('hex'), JSON.stringify(signed.publicJwk)]);
      await f.left.pool.query(`INSERT INTO capacity_provider_team_memberships
        (id,team_id,capacity_provider_id,approved_at,approved_by_id,created_at,updated_at)
        VALUES ('membership','team','provider',$1,'controlled-operator',$1,$1)`, [original.now]);
      const store = { db: f.left, ensureInitialized: () => f.left.migrate(),
        run: async (sql: string, params: unknown[] = []) => { await f.left.prepare(sql).bind(...params).run(); },
        first: <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => f.left.prepare(sql).bind(...params).first<T>(),
        all: async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => (await f.left.prepare(sql).bind(...params).all<T>()).results,
        batch: (operations: Array<{ query: string; params?: unknown[] }>) => f.left.batch(operations) };
      const principal = { teamId: 'team', membershipId: 'membership', capacityProviderId: 'provider' };
      const input = { adapters: [{ id: adapter.id, runtimeBuild: adapter.runtimeBuild, offers: adapter.offers,
        capabilities: adapter.capabilities, status: 'available', maxConcurrentWorkers: 1, activeWorkers: 0,
        laneIds: ['communication', 'platform', 'workday'], nativeLimits: adapter.accountingLimits,
        accountingObservation: adapter.accountingObservation }],
        lanes: ['communication', 'platform', 'workday'].map(purpose => ({ id: purpose, purpose, maxConcurrentWorkers: 1,
          priority: 1, capabilities: adapter.capabilities })) };
      const inputBefore = structuredClone(input), service = new AvailabilitySessionService(store);
      const opened = await service.open(principal, input); if (!opened) throw new Error('Actual canonical session publication required');
      const compileNow = new Date().toISOString();
      const buildSource = { ...original, run: canonicalOfferBuildInput(compileNow).run, now: compileNow };
      const tables = ['capacity_providers', 'capacity_provider_team_memberships', 'capacity_provider_availability_sessions',
        'capacity_execution_providers', 'capacity_provider_lanes', 'execution_capability_offers', 'capacity_provider_assignments',
        'capacity_reservations', 'capacity_usage_actuals', 'capacity_ledger_entries', 'capacity_operation_receipts'];
      const snapshot = async (database: typeof f.left) => {
        const result: Record<string, Array<Record<string, unknown>>> = {};
        for (const table of tables) result[table] = (await database.pool.query<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY to_jsonb(${table})::text`)).rows;
        return result;
      };
      const automated = CORE_CAPABILITY_DEFINITIONS.find(value => value.qualificationTier === 'automated-suite');
      if (!automated) throw new Error('Original automated qualification definition required');
      const qualification = canonicalOfferBuildInput(original.now, automated.id).providers[0]!.offers[0]!;
      qualification.conformance[0]!.suite = { id: 'supplied-native-qualification', version: '1.0.0' };
      const qualifiedInput = structuredClone(input); qualifiedInput.adapters[0]!.id = 'qualified-input-adapter';
      qualifiedInput.adapters[0]!.capabilities = [automated.id]; qualifiedInput.adapters[0]!.offers = [signSuppliedOffer(qualification, registeredKey).offer];
      // A separate controlled membership leaves the original executable session
      // open; normal same-membership publication deliberately closes its prior one.
      await f.left.pool.query(`INSERT INTO teams (id,slug,name,created_at,updated_at) VALUES ('qualification-team','qualification-team','Qualification input',$1,$1)`, [original.now]);
      await f.left.pool.query(`INSERT INTO capacity_provider_team_memberships
        (id,team_id,capacity_provider_id,approved_at,approved_by_id,created_at,updated_at)
        VALUES ('qualification-membership','qualification-team','provider',$1,'controlled-operator',$1,$1)`, [original.now]);
      const qualificationPrincipal = { ...principal, teamId: 'qualification-team', membershipId: 'qualification-membership' };
      const qualifiedBefore = structuredClone(qualifiedInput), qualified = await service.open(qualificationPrincipal, qualifiedInput);
      if (!qualified) throw new Error('Actual declared-tier publication control required');
      expect(qualified.snapshot.adapters[0]!.offers).toEqual(qualifiedInput.adapters[0]!.offers);
      expect((await service.close(qualificationPrincipal, qualified.id))?.status).toBe('closed'); expect(qualifiedInput).toEqual(qualifiedBefore);
      expect((await service.get(principal.teamId, opened.id))?.status).toBe('open');
      const baseline = await snapshot(f.left); expect(await snapshot(f.right)).toEqual(baseline);
      const qualificationOutcomes: Array<{ name: string; code: string; cause: unknown }> = [];
      for (const operation of ['open', 'refresh'] as const) for (const variant of invalidQualificationOffers(qualification, original.now)) {
        const supplied = structuredClone(input); supplied.adapters[0]!.offers = [signSuppliedOffer(variant.offer, registeredKey).offer];
        supplied.adapters[0]!.capabilities = [automated.id]; Object.assign(supplied, { expectedSequence: opened.sequence });
        const unchanged = structuredClone(supplied); let cause: unknown;
        try { if (operation === 'open') await service.open(principal, supplied); else await service.refresh(principal, opened.id, supplied); }
        catch (error) { cause = error; }
        qualificationOutcomes.push({ name: `${operation}:${variant.name}`, code: variant.code, cause }); expect(supplied).toEqual(unchanged);
        expect(await snapshot(f.left)).toEqual(baseline); expect(await snapshot(f.right)).toEqual(baseline);
      }
      for (const outcome of qualificationOutcomes) expect(outcome.cause, outcome.name).toMatchObject({ status: 409, code: outcome.code });
      const foreignKey = generateKeyPairSync('ed25519').privateKey, signatureOutcomes: Array<{ name: string; cause: unknown }> = [];
      for (const operation of ['open', 'refresh'] as const) for (const variant of substitutedSignedOffers(adapter.offers[0]!, foreignKey)) {
        const substituted = structuredClone(input); substituted.adapters[0]!.offers = [variant.offer];
        Object.assign(substituted, { expectedSequence: opened.sequence }); const unchanged = structuredClone(substituted); let cause: unknown;
        try { if (operation === 'open') await service.open(principal, substituted); else await service.refresh(principal, opened.id, substituted); }
        catch (error) { cause = error; }
        signatureOutcomes.push({ name: `${operation}:${variant.name}`, cause }); expect(substituted).toEqual(unchanged);
        expect(await snapshot(f.left)).toEqual(baseline); expect(await snapshot(f.right)).toEqual(baseline);
      }
      for (const outcome of signatureOutcomes) expect(outcome.cause, outcome.name).toMatchObject({ status: 409, code: 'provider_capability_conformance_invalid' });
      expect(signed.publicJwk).toEqual(identityBefore);
      const originalKeyBytes = JSON.stringify(signed.publicJwk), keyOutcomes: unknown[] = [];
      const identities = ['', '{invalid', 'null', '{}', JSON.stringify({ ...signed.publicJwk, kty: 'RSA' }),
        JSON.stringify({ ...signed.publicJwk, crv: 'X25519' }), JSON.stringify({ ...signed.publicJwk, x: '' }),
        JSON.stringify({ ...signed.publicJwk, d: 'controlled-prohibited-private-field' })];
      for (const identity of identities) {
        await f.left.pool.query('UPDATE capacity_providers SET public_jwk_json=$1 WHERE id=$2', [identity, principal.capacityProviderId]);
        const retained = await snapshot(f.right);
        for (const operation of ['open', 'refresh'] as const) {
          const supplied = structuredClone(input); Object.assign(supplied, { expectedSequence: opened.sequence });
          const unchanged = structuredClone(supplied); let cause: unknown;
          try { if (operation === 'open') await service.open(principal, supplied); else await service.refresh(principal, opened.id, supplied); }
          catch (error) { cause = error; }
          keyOutcomes.push(cause); expect(supplied).toEqual(unchanged);
          expect(await snapshot(f.left)).toEqual(retained); expect(await snapshot(f.right)).toEqual(retained);
        }
        expect((await f.right.pool.query('SELECT public_jwk_json FROM capacity_providers WHERE id=$1', [principal.capacityProviderId])).rows[0].public_jwk_json).toBe(identity);
        // Restore ONLY the controlled public input; all native publication,
        // availability, failed observations and accounting history remain.
        await f.left.pool.query('UPDATE capacity_providers SET public_jwk_json=$1 WHERE id=$2', [originalKeyBytes, principal.capacityProviderId]);
        expect(await snapshot(f.right)).toEqual(baseline);
      }
      for (const cause of keyOutcomes) expect(cause).toMatchObject({ status: 409, code: 'provider_capability_conformance_invalid' });
      const suppliedRow = await f.right.pool.query<{ execution_providers_json: string }>(
        'SELECT execution_providers_json FROM capacity_provider_availability_sessions WHERE id=$1', [opened.id]);
      expect(suppliedRow.rows).toHaveLength(1); const raw = suppliedRow.rows[0]!.execution_providers_json;
      const compile = async () => {
        const context = await resolveProviderSynthesisContext(store, principal, { sessionId: opened.id, now: compileNow });
        expect(context.executionProviders).toHaveLength(1);
        const supplied = { ...structuredClone(buildSource), providers: context.executionProviders, providerSessionId: opened.id };
        const unchanged = structuredClone(supplied), result = buildAssignmentAttempt(supplied); expect(supplied).toEqual(unchanged);
        return result;
      };
      const frozen = await compile();
      expect(frozen.assignment.provider).toEqual(buildAssignmentAttempt(buildSource).assignment.provider);
      expect(frozen.assignment.requiredCapabilities).toEqual(adapter.capabilities);
      expect(frozen.assignment.sourceRef).toEqual(original.candidate.node.sourceRef);
      expect(frozen.assignment.authorityRefs).toEqual(original.candidate.node.authorityRefs);
      expect(frozen.assignment.limits.maximumSeconds).toBe(3); expect(frozen.assignment.createdAt).toBe(compileNow);
      expect(frozen.assignment.deadline).toBe(appliedWorkdaySchema.parse(buildSource.run.parameters.appliedPlan).endsAt);
      for (const result of await Promise.all([compile(), compile()])) expect(result).toEqual(frozen);
      expect(await snapshot(f.right)).toEqual(baseline); expect(await snapshot(f.left)).toEqual(baseline);
      const outcomes: Array<{ name: string; cause: unknown }> = [];
      for (const variant of invalidCanonicalOffers(adapter.offers[0]!, compileNow)) {
        const stored: unknown = JSON.parse(raw);
        if (!Array.isArray(stored) || stored.length !== 1 || !stored[0] || typeof stored[0] !== 'object') throw new Error('Original adapter readback required');
        Object.assign(stored[0], { offers: [variant.offer] }); const changed = JSON.stringify(stored);
        await f.left.pool.query('UPDATE capacity_provider_availability_sessions SET execution_providers_json=$1 WHERE id=$2', [changed, opened.id]);
        const retained = await snapshot(f.right); let cause: unknown;
        try { await compile(); } catch (error) { cause = error; }
        outcomes.push({ name: variant.name, cause });
        expect(await snapshot(f.left)).toEqual(retained); expect(await snapshot(f.right)).toEqual(retained);
        expect((await f.right.pool.query('SELECT execution_providers_json FROM capacity_provider_availability_sessions WHERE id=$1', [opened.id])).rows[0].execution_providers_json).toBe(changed);
        // Restore ONLY controlled corrupted bytes, not service failure history,
        // accounting, availability clocks, reservations or a passing receipt.
        await f.left.pool.query('UPDATE capacity_provider_availability_sessions SET execution_providers_json=$1 WHERE id=$2', [raw, opened.id]);
        expect(await snapshot(f.right)).toEqual(baseline);
      }
      for (const outcome of outcomes) {
        expect(outcome.cause, outcome.name).toBeInstanceOf(CapacityGovernanceError);
        expect(outcome.cause, outcome.name).toMatchObject({ status: 409, code: 'capacity_execution_provider_unavailable' });
      }
      expect(await compile()).toEqual(frozen); expect(await snapshot(f.right)).toEqual(baseline);
      await service.close(principal, opened.id); const closed = await snapshot(f.right);
      await expect(compile()).rejects.toMatchObject({ status: 409, code: 'provider_synthesis_session_not_open' });
      expect(await snapshot(f.left)).toEqual(closed); expect(input).toEqual(inputBefore); expect(original).toEqual(before);
      // Original services, full migrations, two PostgreSQL pools and exact
      // persisted bytes. Supplied identity/conformance are not bearer auth,
      // native qualification, live model work or atomic assignment admission.
    } finally { await f.close(); }
  }, 30_000);
  it('serializes observations across memberships before validation and publication', async () => {
    if (!url) throw new Error('TREESEED_TEST_POSTGRES_URL is required; native accounting coverage cannot be skipped.');
    const connection = new URL(url);
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
    const spy = vi.spyOn(AvailabilitySessionRepository.prototype, 'open').mockImplementation(async function(this: AvailabilitySessionRepository, write, operations) {
      if (write.membershipId === 'membership-first') { entered(); await released; }
      return original.call(this, write, operations);
    });
    try {
      await db.migrate();
      const now = new Date().toISOString();
      const canonical = canonicalOfferBuildInput(now).providers[0]!;
      const signed = signSuppliedOffer(canonical.offers[0]!, generateKeyPairSync('ed25519').privateKey);
      await db.pool.query(`INSERT INTO capacity_providers (id,fingerprint,public_jwk_json,display_name,created_at,updated_at)
        VALUES ('provider','test',$2,'Provider',$1,$1)`, [now, JSON.stringify(signed.publicJwk)]);
      for (const team of ['first', 'second']) {
        await db.pool.query(`INSERT INTO teams (id,slug,name,created_at,updated_at) VALUES ($1,$1,$1,$2,$2)`, [team, now]);
        await db.pool.query(`INSERT INTO capacity_provider_team_memberships
          (id,team_id,capacity_provider_id,approved_at,approved_by_id,created_at,updated_at)
          VALUES ($1,$2,'provider',$3,'test',$3,$3)`, [`membership-${team}`, team, now]);
      }
      const store = { db, ensureInitialized: () => db.migrate(),
        run: async (sql: string, params: unknown[] = []) => { await db.prepare(sql).bind(...params).run(); },
        first: <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => db.prepare(sql).bind(...params).first<T>(),
        all: async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.prepare(sql).bind(...params).all<T>()).results,
        batch: (operations: Array<{ query: string; params?: unknown[] }>) => db.batch(operations) };
      const service = new AvailabilitySessionService(store);
      const input = (activeSeconds: number) => {
        const observed = { day: now.slice(0, 10), observedAt: now, healthy: true, activeSeconds, reservedSeconds: 0 };
        return { adapters: [{ id: 'codex-implementation', adapter: 'codex', runtimeBuild: `sha256:${'a'.repeat(64)}`,
          offers: [signed.offer], capabilities: [executionCapability],
          status: 'available', maxConcurrentWorkers: 1, laneIds: ['communication', 'platform', 'workday'],
          nativeLimits: { modelConfigurationId: 'terra-medium', dailyActiveSecondsLimit: 28800,
            capabilityLimits: { [executionCapability]: { dailyActiveSecondsLimit: 28800 } } },
          accountingObservation: { modelUsage: observed, capabilityUsage: { [executionCapability]: observed } } }],
          lanes: ['communication', 'platform', 'workday'].map(purpose => ({ id: purpose, purpose, maxConcurrentWorkers: 1 })) };
      };
      const principal = (team: string) => ({ teamId: team, membershipId: `membership-${team}`, capacityProviderId: 'provider' });
      const first = service.open(principal('first'), input(2));
      await Promise.race([firstEntered, first.then(() => { throw new Error('Native publication returned before the owning transaction barrier'); })]);
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

// Every original native case fails when its explicit disposable PostgreSQL
// prerequisite is missing. No service start,
// environment replacement or in-process database fallback is permitted.
describe('native provider restart accounting authority', () => {
  it('native PostgreSQL retains closed shared model history across membership restart and rejects malformed or regressed reports before publication', async () => {
    if (!url) throw new Error('TREESEED_TEST_POSTGRES_URL is required for native accounting authority.');
    const connection = new URL(url);
    if (connection.hostname !== '127.0.0.1' || connection.pathname !== '/postgres') throw new Error('Explicit disposable loopback PostgreSQL admin database required.');
    const admin = new pg.Pool({ connectionString: connection.href });
    const name = `treeseed_accounting_restart_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE "${name}"`);
    connection.pathname = `/${name}`;
    const db = createControlPlanePostgresDatabase(connection.href, { migrationMode: 'apply' });
    const reader = new pg.Pool({ connectionString: connection.href });
    try {
      await db.migrate(); const now = new Date().toISOString();
      const canonical = canonicalOfferBuildInput(now).providers[0]!;
      const signed = signSuppliedOffer(canonical.offers[0]!, generateKeyPairSync('ed25519').privateKey);
      await db.pool.query(`INSERT INTO capacity_providers (id,fingerprint,public_jwk_json,display_name,created_at,updated_at)
        VALUES ('provider','restart-test',$2,'Provider',$1,$1)`, [now, JSON.stringify(signed.publicJwk)]);
      for (const team of ['first', 'second']) {
        await db.pool.query(`INSERT INTO teams (id,slug,name,created_at,updated_at) VALUES ($1,$1,$1,$2,$2)`, [team, now]);
        await db.pool.query(`INSERT INTO capacity_provider_team_memberships
          (id,team_id,capacity_provider_id,approved_at,approved_by_id,created_at,updated_at)
          VALUES ($1,$2,'provider',$3,'test',$3,$3)`, [`membership-${team}`, team, now]);
      }
      const store = { db, ensureInitialized: () => db.migrate(),
        run: async (sql: string, params: unknown[] = []) => { await db.prepare(sql).bind(...params).run(); },
        first: <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => db.prepare(sql).bind(...params).first<T>(),
        all: async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.prepare(sql).bind(...params).all<T>()).results,
        batch: (operations: Array<{ query: string; params?: unknown[] }>) => db.batch(operations) };
      const principal = (team: string) => ({ teamId: team, membershipId: `membership-${team}`, capacityProviderId: 'provider' });
      const input = (activeSeconds: number, id = 'configured-runtime') => {
        const observedAt = new Date().toISOString(), observed = { day: observedAt.slice(0, 10), observedAt, healthy: true, activeSeconds, reservedSeconds: 0 };
        return { adapters: [{ id, adapter: 'codex', runtimeBuild: `sha256:${'a'.repeat(64)}`, status: 'available', maxConcurrentWorkers: 1,
          offers: [signed.offer], capabilities: [executionCapability],
          laneIds: ['communication', 'platform', 'workday'], nativeLimits: { modelConfigurationId: 'shared-model', dailyActiveSecondsLimit: 120,
            capabilityLimits: { [executionCapability]: { dailyActiveSecondsLimit: 60 } } }, accountingObservation: {
              modelUsage: { ...observed }, capabilityUsage: { [executionCapability]: { ...observed } } } }],
          lanes: ['communication', 'platform', 'workday'].map(purpose => ({ id: purpose, purpose, maxConcurrentWorkers: 1 })) };
      };
      const service = new AvailabilitySessionService(store), firstInput = input(10), firstBefore = structuredClone(firstInput);
      const opened = await service.open(principal('first'), firstInput);
      if (!opened) throw new Error('Actual first publication required');
      expect(opened.snapshot.adapters[0]?.accountingObservation?.modelUsage.activeSeconds).toBe(10);
      await service.close(principal('first'), opened.id);
      const tables = ['capacity_provider_availability_sessions', 'capacity_execution_providers', 'capacity_provider_lanes',
        'capacity_providers', 'capacity_provider_team_memberships', 'capacity_grants', 'capacity_provider_assignments',
        'capacity_reservations', 'capacity_usage_actuals', 'capacity_ledger_entries', 'capacity_operation_receipts'];
      const snapshot = async (pool: pg.Pool) => {
        const result: Record<string, Array<Record<string, unknown>>> = {};
        for (const table of tables) result[table] = (await pool.query<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY id`)).rows;
        return result;
      };
      const baseline = await snapshot(db.pool); expect(await snapshot(reader)).toEqual(baseline);
      expect((await service.get('first', opened.id))?.status).toBe('closed');
      const restarted = new AvailabilitySessionService(store);
			const partial = { offerId: 'invalid-partial-offer', capabilities: [{ id: 'treeseed.engineering.implementation' }] };
			const invalidOffers: unknown[] = [undefined, null, [], {}, 'offer', [null], [0], [partial],
				[partial, null], [partial, structuredClone(partial)], [{ ...partial, capabilities: null }]];
			const deniedOffers: Array<{ cause: unknown; inputUnchanged: boolean; stateUnchanged: boolean }> = [];
			const offersBefore = (await reader.query('SELECT * FROM execution_capability_offers ORDER BY capacity_provider_id,offer_id')).rows;
			for (const offers of invalidOffers) {
				const supplied = input(10, 'invalid-offer-runtime'); Object.assign(supplied.adapters[0]!, { offers });
				const before = structuredClone(supplied); let cause: unknown;
				try { await restarted.open(principal('second'), supplied); } catch (error) { cause = error; }
				deniedOffers.push({ cause, inputUnchanged: JSON.stringify(supplied) === JSON.stringify(before),
					stateUnchanged: JSON.stringify(await snapshot(reader)) === JSON.stringify(baseline) });
				expect(await snapshot(db.pool)).toEqual(await snapshot(reader));
				expect((await reader.query('SELECT * FROM execution_capability_offers ORDER BY capacity_provider_id,offer_id')).rows).toEqual(offersBefore);
			}
			for (const observed of deniedOffers) {
				expect(observed.cause).toMatchObject({ status: 400, code: 'provider_capability_offer_invalid' });
				expect(observed.inputUnchanged).toBe(true); expect(observed.stateUnchanged).toBe(true);
			}
			// Actual original service/migrations/native transactions and independent
			// SQL reader, with deliberately INVALID supplied offers. No fabricated
			// qualification, bearer authentication or successful provider dispatch.
      const originalClosed = await reader.query<{ execution_providers_json: string }>(
        'SELECT execution_providers_json FROM capacity_provider_availability_sessions WHERE id=$1', [opened.id]);
      expect(originalClosed.rows).toHaveLength(1); const originalBytes = originalClosed.rows[0]!.execution_providers_json;
      const patches: Array<Record<string, unknown>> = [{ reservedSeconds: -1 }, { reservedSeconds: '0' }, { reservedSeconds: null },
        { healthy: 'true' }, { healthy: null }, { day: 'not-a-day' }, { day: '2026-02-30' },
        { day: '2000-01-01' }, { observedAt: 'not-a-clock' }, { observedAt: null }];
      for (const scope of ['model', 'capability']) for (const patch of patches) {
        const adapters: unknown = JSON.parse(originalBytes);
        if (!Array.isArray(adapters) || adapters.length !== 1 || !adapters[0] || typeof adapters[0] !== 'object') throw new Error('Original retained adapter required');
        const accounting = Reflect.get(adapters[0], 'accountingObservation');
        if (!accounting || typeof accounting !== 'object') throw new Error('Original retained accounting required');
        const capabilities = Reflect.get(accounting, 'capabilityUsage');
        if (!capabilities || typeof capabilities !== 'object') throw new Error('Original retained capability observations required');
        const target = scope === 'model' ? Reflect.get(accounting, 'modelUsage') : Reflect.get(capabilities, executionCapability);
        if (!target || typeof target !== 'object') throw new Error('Original retained scope required');
        Object.assign(target, patch); const suppliedBytes = JSON.stringify(adapters);
        await db.pool.query('UPDATE capacity_provider_availability_sessions SET execution_providers_json=$1 WHERE id=$2', [suppliedBytes, opened.id]);
        const suppliedState = await snapshot(reader), fresh = input(10, 'renamed-after-corrupt-history'), before = structuredClone(fresh);
        await expect(restarted.open(principal('second'), fresh)).rejects.toMatchObject({ message: 'capability_accounting_invalid' });
        expect(await snapshot(db.pool)).toEqual(suppliedState); expect(await snapshot(reader)).toEqual(suppliedState); expect(fresh).toEqual(before);
        expect((await reader.query('SELECT execution_providers_json FROM capacity_provider_availability_sessions WHERE id=$1', [opened.id])).rows[0].execution_providers_json).toBe(suppliedBytes);
        // Restore ONLY this controlled invalid input, never failed service
        // history, counters, a newly published session or the original clock.
        await db.pool.query('UPDATE capacity_provider_availability_sessions SET execution_providers_json=$1 WHERE id=$2', [originalBytes, opened.id]);
        expect(await snapshot(reader)).toEqual(baseline);
      }
      const outcomes = [];
      for (const fault of ['model-regression', 'capability-regression', 'backward-clock', 'model-health', 'capability-health'] as const) {
        const supplied = input(10, 'renamed-after-restart'), observation = supplied.adapters[0]!.accountingObservation;
        if (fault === 'model-regression') observation.modelUsage.activeSeconds = 9;
        if (fault === 'capability-regression') observation.capabilityUsage[executionCapability]!.activeSeconds = 9;
        if (fault === 'backward-clock') observation.modelUsage.observedAt = new Date(Date.parse(firstInput.adapters[0]!.accountingObservation.modelUsage.observedAt) - 1).toISOString();
        if (fault === 'model-health') Object.assign(observation.modelUsage, { healthy: 'true' });
        if (fault === 'capability-health') Object.assign(observation.capabilityUsage[executionCapability]!, { healthy: 'true' });
        const before = structuredClone(supplied); let error: unknown;
        try { await restarted.open(principal('second'), supplied); } catch (cause) { error = cause; }
        outcomes.push({ fault, error, unchanged: JSON.stringify(await snapshot(db.pool)) === JSON.stringify(baseline), inputUnchanged: JSON.stringify(supplied) === JSON.stringify(before) });
        expect(await snapshot(reader)).toEqual(await snapshot(db.pool));
      }
      for (const outcome of outcomes) {
        if (outcome.fault.endsWith('health')) expect(outcome.error).toMatchObject({ message: 'capability_accounting_invalid' });
        else expect(outcome.error).toMatchObject({ code: 'provider_accounting_regressed', status: 409 });
        expect(outcome.unchanged).toBe(true); expect(outcome.inputUnchanged).toBe(true);
      }
      const retryInput = input(10, 'renamed-after-restart'), retryBefore = structuredClone(retryInput);
      const retry = await restarted.open(principal('second'), retryInput); if (!retry) throw new Error('Actual unchanged accounting retry required');
      expect(retry.snapshot.adapters[0]?.accountingObservation).toEqual(retryInput.adapters[0]!.accountingObservation);
      expect((await reader.query('SELECT * FROM capacity_provider_availability_sessions WHERE id=$1', [opened.id])).rows)
        .toEqual(baseline.capacity_provider_availability_sessions!.filter(value => value.id === opened.id));
      expect((await reader.query('SELECT count(*)::int AS count FROM capacity_provider_availability_sessions')).rows[0].count).toBe(2);
      const beforeRace = await snapshot(reader);
      const raced = await Promise.all([20, 21].map(seconds => new AvailabilitySessionService(store).open(principal('second'), input(seconds))
        .then(value => ({ seconds, value }), error => ({ seconds, error }))));
      expect(raced.filter(value => 'value' in value && value.value).length).toBeGreaterThanOrEqual(1);
      for (const outcome of raced) if ('error' in outcome) expect(outcome.error).toMatchObject({ code: 'provider_accounting_regressed', status: 409 });
      const highest = await reader.query(`SELECT execution_providers_json FROM capacity_provider_availability_sessions WHERE status='open' ORDER BY id`);
      expect(highest.rows).toHaveLength(1);
      expect(JSON.parse(highest.rows[0].execution_providers_json)[0].accountingObservation.modelUsage.activeSeconds).toBe(21);
      const afterRace = await snapshot(reader); expect(await snapshot(db.pool)).toEqual(afterRace);
      for (const table of tables.filter(value => !['capacity_provider_availability_sessions', 'capacity_execution_providers', 'capacity_provider_lanes'].includes(value)))
        expect(afterRace[table]).toEqual(beforeRace[table]);
      expect(firstInput).toEqual(firstBefore); expect(retryInput).toEqual(retryBefore);
      // Supplied principals/observations are controlled inputs. Real provider
      // row locks, independent reader and retained SQL history are exercised;
      // no external model charge, managed dispatch or physical closure claim.
    } finally {
      await reader.end(); await db.close();
      try { await admin.query(`DROP DATABASE "${name}"`); } finally { await admin.end(); }
    }
  }, 30_000);
});
