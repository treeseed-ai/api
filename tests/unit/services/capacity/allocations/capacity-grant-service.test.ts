import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataType, newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import { MarketPostgresDatabase } from '../../../../../src/api/support/market-postgres.js';
import { MarketControlPlaneStore } from '../../../../../src/api/persistence/store.js';
import { CapacityGrantService } from '../../../../../src/api/capacity/services/capacity/allocations/grant-service.ts';

const packageRoot = process.cwd();
const migrationRoot = existsSync(resolve(packageRoot, '../sdk/drizzle/market'))
	? resolve(packageRoot, '../sdk/drizzle/market')
	: resolve(packageRoot, 'node_modules/@treeseed/sdk/drizzle/market');

function harness() {
	const memory = newDb();
	memory.public.registerFunction({ name: 'md5', args: [DataType.text], returns: DataType.text, implementation: (value: string) => `md5:${value}` });
	const pg = memory.adapters.createPg();
	const database = MarketPostgresDatabase.fromPool(new pg.Pool(), { migrationRoot });
	const store = new MarketControlPlaneStore({ repoRoot: packageRoot }, database);
	return { database, store, service: new CapacityGrantService(store) };
}

async function seedGrantOwnership(
	store: MarketControlPlaneStore,
	status: 'approved' | 'suspended' = 'approved',
) {
	const now = new Date().toISOString();
	await store.run(`INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, ['team-a', 'team-a', 'Team A', now, now]);
	await store.run(`INSERT INTO projects (id, team_id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, ['project-a', 'team-a', 'project-a', 'Project A', now, now]);
	await store.run(`INSERT INTO capacity_providers (id, fingerprint, public_jwk_json, display_name, identity_version, status, metadata_json, created_at, updated_at) VALUES (?, ?, '{}', ?, 1, 'active', '{}', ?, ?)`, ['provider-a', 'sha256:provider-a', 'Provider A', now, now]);
	await store.run(`INSERT INTO capacity_execution_providers (id, capacity_provider_id, display_name, adapter, status, capabilities_json, native_unit, quota_visibility, max_concurrent_runners, native_limits_json, metadata_json, created_at, updated_at) VALUES ('codex', 'provider-a', 'Codex', 'codex', 'active', '["engineering"]', 'assignment', 'exact', 2, '[]', '{}', ?, ?)`, [now, now]);
	await store.run(`INSERT INTO capacity_provider_lanes (id, capacity_provider_id, execution_provider_id, display_name, status, capabilities_json, max_concurrent_runners, native_limits_json, metadata_json, created_at, updated_at) VALUES ('lane-a', 'provider-a', 'codex', 'Lane A', 'active', '["engineering"]', 1, '[]', '{}', ?, ?)`, [now, now]);
	await store.run(`INSERT INTO capacity_provider_team_memberships (id, team_id, capacity_provider_id, status, approved_at, approved_by_id, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?)`, ['membership-a', 'team-a', 'provider-a', status, now, 'owner-a', now, now]);
}

describe('capacity grant governance', () => {
	it('creates immutable scoped grants and enforces explicit lifecycle transitions', async () => {
		const { database, store, service } = harness();
		try {
			await store.ensureInitialized();
			await seedGrantOwnership(store);

			const created = await service.create('team-a', {
				membershipId: 'membership-a', projectId: 'project-a', environment: 'local',
				executionProviderIds: ['codex'], capabilities: ['engineering'], allowedModes: ['planning', 'acting'],
				dailyCreditLimit: 100, monthlyCreditLimit: 1000, maxConcurrentAssignments: 2,
			}, 'create-local');
			expect(created).toMatchObject({ schemaVersion: 2, membershipId: 'membership-a', providerId: 'provider-a', projectId: 'project-a', status: 'planned', dailyCreditLimit: 100 });
			expect(await service.transition('team-a', created!.id, 'active', 'activate-1')).toMatchObject({ status: 'active' });
			expect(await service.transition('team-a', created!.id, 'paused', 'pause-1')).toMatchObject({ status: 'paused' });
			expect(await service.transition('team-a', created!.id, 'active', 'activate-2')).toMatchObject({ status: 'active' });
			expect(await service.transition('team-a', created!.id, 'revoked', 'revoke-1')).toMatchObject({ status: 'revoked' });
			await expect(service.transition('team-a', created!.id, 'active', 'activate-invalid')).rejects.toMatchObject({ code: 'capacity_grant_transition_invalid' });
			expect((await service.listPage('team-a', { membershipId: 'membership-a', status: 'revoked' })).items).toHaveLength(1);
			await service.create('team-a', {
				id: 'grant-staging', membershipId: 'membership-a', projectId: 'project-a', environment: 'staging',
				executionProviderIds: ['codex'], allowedModes: ['planning'], unmetered: true,
			}, 'create-staging');
			expect((await service.listPage('team-a', { projectId: 'project-a', environment: 'local' })).items.map((grant) => grant.id)).toEqual([created!.id]);
			expect((await service.listPage('team-a', { projectId: 'project-a', environment: 'staging' })).items.map((grant) => grant.id)).toEqual(['grant-staging']);
		} finally {
			await database.close();
		}
	});

	it('rejects grants for unapproved memberships and invalid hard-limit policy', async () => {
		const { database, store, service } = harness();
		try {
			await store.ensureInitialized();
			await seedGrantOwnership(store, 'suspended');
			await expect(service.create('team-a', { membershipId: 'membership-a', projectId: 'project-a', environment: 'local', dailyCreditLimit: 1 }, 'create-suspended')).rejects.toMatchObject({ code: 'capacity_grant_membership_not_approved' });
			await store.run(`UPDATE capacity_provider_team_memberships SET status = 'approved' WHERE id = ?`, ['membership-a']);
			const denied = await service.create('team-a', { membershipId: 'membership-a', projectId: 'project-a', environment: 'local', executionProviderIds: ['codex'], allowedModes: ['planning'], dailyCreditLimit: 0, monthlyCreditLimit: 0, maxConcurrentAssignments: 0, unmetered: false }, 'create-denied');
			expect(denied).toMatchObject({ status: 'planned', dailyCreditLimit: 0, maxConcurrentAssignments: 0 });
			await expect(service.create('team-a', { membershipId: 'membership-a', projectId: 'project-a', environment: 'local', executionProviderIds: ['missing'], allowedModes: ['planning'], unmetered: true }, 'create-missing-provider')).rejects.toMatchObject({ code: 'capacity_grant_execution_provider_invalid' });
			await expect(service.create('team-a', { membershipId: 'membership-a', projectId: 'project-a', environment: 'local', executionProviderIds: ['codex'], laneIds: ['missing'], allowedModes: ['planning'], unmetered: true }, 'create-missing-lane')).rejects.toMatchObject({ code: 'capacity_grant_lane_invalid' });
			await expect(service.create('team-a', { membershipId: 'membership-a', projectId: 'project-a', environment: 'local', executionProviderIds: ['codex'], capabilities: ['research'], allowedModes: ['planning'], unmetered: true }, 'create-missing-capability')).rejects.toMatchObject({ code: 'capacity_grant_capability_invalid' });
		} finally {
			await database.close();
		}
	});

	it('plans canonical grants with reference diagnostics without persisting', async () => {
		const { database, store, service } = harness();
		try {
			await store.ensureInitialized();
			await seedGrantOwnership(store);
			const valid = await service.plan('team-a', {
				id: 'grant-plan',
				membershipId: 'membership-a',
				projectId: 'project-a',
				environment: 'local',
				executionProviderIds: ['codex'],
				capabilities: ['engineering'],
				allowedModes: ['planning'],
				unmetered: true,
			});
			expect(valid).toMatchObject({
				candidate: { id: 'grant-plan', providerId: 'provider-a', status: 'planned' },
				validation: { ok: true, diagnostics: [] },
			});
			const invalid = await service.plan('team-a', {
				id: 'grant-invalid-plan',
				membershipId: 'membership-a',
				projectId: 'project-a',
				environment: 'local',
				executionProviderIds: ['missing'],
				allowedModes: ['planning'],
				unmetered: true,
			});
			expect(invalid.validation.ok).toBe(false);
			expect(invalid.validation.diagnostics.map((entry) => entry.code)).toContain('capacity_grant_execution_provider_invalid');
			expect(await store.all('SELECT id FROM capacity_grants')).toEqual([]);
		} finally {
			await database.close();
		}
	});

	it('durably replays create and transition mutations and rejects key reuse with different input', async () => {
		const { database, store, service } = harness();
		try {
			await store.ensureInitialized();
			await seedGrantOwnership(store);
			const input = {
				membershipId: 'membership-a',
				projectId: 'project-a',
				environment: 'local',
				executionProviderIds: ['codex'],
				allowedModes: ['planning'],
				unmetered: true,
			};
			const created = await service.create('team-a', input, 'stable-create');
			expect(await service.create('team-a', input, 'stable-create')).toEqual(created);
			await expect(service.create('team-a', { ...input, environment: 'staging' }, 'stable-create'))
				.rejects.toMatchObject({ code: 'capacity_idempotency_key_conflict' });
			const active = await service.transition('team-a', created.id, 'active', 'stable-activate');
			expect(await service.transition('team-a', created.id, 'active', 'stable-activate')).toEqual(active);
			expect(await store.all('SELECT id FROM capacity_grants')).toHaveLength(1);
			expect(await store.all('SELECT id FROM capacity_operation_receipts')).toHaveLength(2);
		} finally {
			await database.close();
		}
	});

	it('returns stable bounded cursor pages without repeating grants', async () => {
		const { database, store, service } = harness();
		try {
			await store.ensureInitialized();
			await seedGrantOwnership(store);
			for (const id of ['grant-a', 'grant-b', 'grant-c']) {
				await service.create('team-a', { id, membershipId: 'membership-a', projectId: 'project-a', environment: 'local', executionProviderIds: ['codex'], allowedModes: ['planning'], unmetered: true }, `create-${id}`);
			}
			const first = await service.listPage('team-a', { limit: 2 });
			expect(first.items).toHaveLength(2);
			expect(first.page).toMatchObject({ limit: 2, hasMore: true });
			expect(first.page.nextCursor).toEqual(expect.any(String));
			const second = await service.listPage('team-a', { limit: 2, cursor: first.page.nextCursor });
			expect(second.items).toHaveLength(1);
			expect(second.page).toMatchObject({ limit: 2, hasMore: false, nextCursor: null });
			expect(new Set([...first.items, ...second.items].map((grant) => grant.id))).toEqual(new Set(['grant-a', 'grant-b', 'grant-c']));
			await expect(service.listPage('team-a', { limit: 201 })).rejects.toMatchObject({ code: 'capacity_page_invalid' });
		} finally {
			await database.close();
		}
	});
});
