import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataType, newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import { MarketPostgresDatabase } from '../../../../src/api/support/market-postgres.js';
import { MarketControlPlaneStore } from '../../../../src/api/persistence/store.js';
import { AvailabilitySessionService } from '../../../../src/api/capacity/services/accounts/availability-session-service.ts';

const packageRoot = process.cwd();
const migrationRoot = existsSync(resolve(packageRoot, '../sdk/drizzle/market')) ? resolve(packageRoot, '../sdk/drizzle/market') : resolve(packageRoot, 'node_modules/@treeseed/sdk/drizzle/market');
const principal = { membershipId: 'membership-a', teamId: 'team-a', capacityProviderId: 'provider-a' };

function harness() {
	const memory = newDb();
	memory.public.registerFunction({ name: 'md5', args: [DataType.text], returns: DataType.text, implementation: (value: string) => `md5:${value}` });
	const pg = memory.adapters.createPg();
	const database = MarketPostgresDatabase.fromPool(new pg.Pool(), { migrationRoot });
	const store = new MarketControlPlaneStore({ repoRoot: packageRoot }, database);
	return { database, store, service: new AvailabilitySessionService(store) };
}

async function seed(store: MarketControlPlaneStore) {
	const now = new Date().toISOString();
	await store.ensureInitialized();
	await store.run(`INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES ('team-a', 'team-a', 'Team A', ?, ?)`, [now, now]);
	await store.run(`INSERT INTO capacity_providers (id, fingerprint, public_jwk_json, display_name, identity_version, status, created_at, updated_at) VALUES ('provider-a', 'fingerprint-a', '{}', 'Provider A', 1, 'active', ?, ?)`, [now, now]);
	await store.run(`INSERT INTO capacity_provider_team_memberships (id, team_id, capacity_provider_id, status, approved_at, approved_by_id, created_at, updated_at) VALUES ('membership-a', 'team-a', 'provider-a', 'approved', ?, 'owner-a', ?, ?)`, [now, now, now]);
}

function snapshot(status = 'active') {
	return { ttlSeconds: 90, capabilities: ['engineering'], nativeLimits: { maxConcurrentRunners: 2 }, runnerPressure: { pressure: 'normal', maxConcurrentRunners: 2 }, executionProviders: [{ id: 'codex', adapter: 'codex', status, maxConcurrentRunners: 2, capabilities: ['engineering'] }] };
}

describe('availability session service', () => {
	it('opens one membership-scoped session and closes the prior session atomically', async () => {
		const { database, store, service } = harness();
		try {
			await seed(store);
			const first = await service.open(principal, snapshot());
			const second = await service.open(principal, snapshot());
			expect(first).toMatchObject({ membershipId: 'membership-a', status: 'open', sequence: 1 });
			expect(second).toMatchObject({ membershipId: 'membership-a', status: 'open', sequence: 1 });
			expect(await service.get('team-a', first!.id)).toMatchObject({ status: 'closed' });
			expect(await store.all(`SELECT id FROM capacity_provider_availability_sessions WHERE status = 'open'`)).toHaveLength(1);
		} finally { await database.close(); }
	});

	it('uses sequence CAS and does not apply provider inventory from a stale refresh', async () => {
		const { database, store, service } = harness();
		try {
			await seed(store);
			const opened = await service.open(principal, snapshot('active'));
			expect(await service.refresh(principal, opened!.id, { ...snapshot('degraded'), expectedSequence: 1 })).toMatchObject({ sequence: 2 });
			expect(await service.refresh(principal, opened!.id, { ...snapshot('unavailable'), expectedSequence: 1 })).toBeNull();
			expect(await store.first(`SELECT status FROM capacity_execution_providers WHERE capacity_provider_id = 'provider-a' AND id = 'codex'`)).toEqual({ status: 'degraded' });
		} finally { await database.close(); }
	});

	it('treats close as idempotent after the session is closed or naturally expired', async () => {
		const { database, store, service } = harness();
		try {
			await seed(store);
			const closed = await service.open(principal, snapshot());
			expect(await service.close(principal, closed!.id)).toMatchObject({ status: 'closed' });
			expect(await service.close(principal, closed!.id)).toMatchObject({ status: 'closed' });
			const expired = await service.open(principal, snapshot());
			await store.run(`UPDATE capacity_provider_availability_sessions SET status = 'expired', updated_at = ? WHERE id = ?`, [new Date().toISOString(), expired!.id]);
			expect(await service.close(principal, expired!.id)).toMatchObject({ status: 'expired' });
		} finally { await database.close(); }
	});

	it('rejects invalid bounds, unauthorized principals, and suspended memberships', async () => {
		const { database, store, service } = harness();
		try {
			await seed(store);
			await expect(service.open(principal, { ...snapshot(), ttlSeconds: 0 })).rejects.toMatchObject({ code: 'provider_availability_ttl_invalid' });
			const opened = await service.open(principal, snapshot());
			await expect(service.close({ ...principal, membershipId: 'membership-other' }, opened!.id)).rejects.toMatchObject({ code: 'provider_membership_not_approved' });
			expect(await service.get('team-a', opened!.id)).toMatchObject({ status: 'open' });
			await store.run(`UPDATE capacity_provider_team_memberships SET status = 'suspended', updated_at = ? WHERE id = 'membership-a'`, [new Date().toISOString()]);
			await expect(service.refresh(principal, opened!.id, { ...snapshot(), expectedSequence: 1 })).rejects.toMatchObject({ code: 'provider_membership_not_approved' });
			await expect(service.close(principal, opened!.id)).rejects.toMatchObject({ code: 'provider_membership_not_approved' });
		} finally { await database.close(); }
	});
});
