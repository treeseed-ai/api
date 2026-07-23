import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataType, newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import { MarketPostgresDatabase } from '../../../src/api/market-postgres.js';
import { MarketControlPlaneStore } from '../../../src/api/store.js';
import { CapacityAllocationPolicyError, CapacityAllocationService } from '../../../src/api/capacity/services/allocation-service.ts';

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
	return { database, store, service: new CapacityAllocationService(store) };
}

function policy(projectId: string) {
	return {
		reservePolicy: { percent: 10, overflow: 'approval-required' as const },
		slices: [{ id: `project:${projectId}`, scope: 'project' as const, targetId: projectId, policy: { minPercent: 50, targetPercent: 90, maxPercent: 90, hardCapPercent: 95 } }],
		borrowingRules: [],
	};
}

async function seedTeam(store: MarketControlPlaneStore, teamId = 'team-a') {
	const now = new Date().toISOString();
	await store.ensureInitialized();
	await store.run(`INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, [teamId, teamId, teamId, now, now]);
	for (const projectId of ['project-a', 'project-b']) {
		await store.run(`INSERT INTO projects (id, team_id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, [projectId, teamId, projectId, projectId, now, now]);
	}
}

describe('capacity allocation service', () => {
	it('owns planning, persistence, immutable activation, supersession, and archival', async () => {
		const { database, store, service } = harness();
		try {
			await seedTeam(store);
			const first = await service.create('team-a', { id: 'allocation-a', ...policy('project-a') }, 'owner-a', 'create-a');
			const second = await service.create('team-a', { id: 'allocation-b', ...policy('project-b') }, 'owner-a', 'create-b');
			expect([first.version, second.version]).toEqual([1, 2]);
			expect((await service.activate('team-a', first.id, 'activate-a'))?.status).toBe('active');
			const supersession = await service.supersede('team-a', second.id, first.id, 'supersede-b');
			expect(supersession).toMatchObject({
				superseded: { id: first.id },
				active: { id: second.id, status: 'active' },
			});
			expect(await service.supersede('team-a', second.id, first.id, 'supersede-b')).toEqual(supersession);
			expect(await service.get('team-a', first.id)).toMatchObject({ status: 'superseded', supersededById: second.id });
			await expect(service.activate('team-a', second.id, 'activate-b-again')).rejects.toMatchObject({ code: 'capacity_allocation_transition_invalid' });
			const archived = await service.archive('team-a', first.id, 'archive-a');
			expect(archived).toMatchObject({ status: 'archived' });
			expect(await service.archive('team-a', first.id, 'archive-a')).toEqual(archived);
			await expect(service.archive('team-a', second.id, 'archive-b')).rejects.toMatchObject({ code: 'capacity_allocation_active_archive_denied' });
		} finally {
			await database.close();
		}
	});

	it('rejects supersession when the expected active version changed', async () => {
		const { database, store, service } = harness();
		try {
			await seedTeam(store);
			const first = await service.create('team-a', { id: 'allocation-a', ...policy('project-a') }, null, 'create-a');
			const replacement = await service.create('team-a', { id: 'allocation-b', ...policy('project-b') }, null, 'create-b');
			await service.activate('team-a', first.id, 'activate-a');
			await expect(service.supersede('team-a', replacement.id, 'allocation-stale', 'supersede-stale'))
				.rejects.toMatchObject({ code: 'capacity_allocation_supersession_conflict' });
			expect(await service.get('team-a', replacement.id)).toMatchObject({ status: 'draft' });
		} finally {
			await database.close();
		}
	});

	it('allows only one concurrent replacement to supersede the expected active allocation', async () => {
		const { database, store, service } = harness();
		try {
			await seedTeam(store);
			const active = await service.create('team-a', { id: 'allocation-active', ...policy('project-a') }, null, 'race-create-active');
			const left = await service.create('team-a', { id: 'allocation-left', ...policy('project-b') }, null, 'race-create-left');
			const right = await service.create('team-a', { id: 'allocation-right', ...policy('project-b') }, null, 'race-create-right');
			await service.activate('team-a', active.id, 'race-activate');
			const results = await Promise.allSettled([
				service.supersede('team-a', left.id, active.id, 'race-supersede-left'),
				service.supersede('team-a', right.id, active.id, 'race-supersede-right'),
			]);
			expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
			expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
			expect((await service.listPage('team-a', { limit: 10, cursor: null })).items.filter((entry) => entry.status === 'active')).toHaveLength(1);
		} finally {
			await database.close();
		}
	});

	it('durably replays allocation mutations and rejects conflicting key reuse', async () => {
		const { database, store, service } = harness();
		try {
			await seedTeam(store);
			const input = { id: 'allocation-a', ...policy('project-a') };
			const created = await service.create('team-a', input, 'owner-a', 'stable-create');
			expect(await service.create('team-a', input, 'owner-a', 'stable-create')).toEqual(created);
			await expect(service.create('team-a', { ...input, id: 'allocation-b' }, 'owner-a', 'stable-create'))
				.rejects.toMatchObject({ code: 'capacity_idempotency_key_conflict' });
			const active = await service.activate('team-a', created.id, 'stable-activate');
			expect(await service.activate('team-a', created.id, 'stable-activate')).toEqual(active);
			expect(await store.all('SELECT id FROM capacity_allocation_sets')).toHaveLength(1);
			expect(await store.all('SELECT id FROM capacity_operation_receipts')).toHaveLength(2);
		} finally {
			await database.close();
		}
	});

	it('returns non-mutating validation plans and rejects invalid policies before persistence', async () => {
		const { database, store, service } = harness();
		try {
			await seedTeam(store);
			const planned = await service.plan('team-a', { id: 'allocation-invalid', ...policy('project-a'), slices: [] });
			expect(planned.validation.ok).toBe(false);
			await expect(service.create('team-a', { id: 'allocation-invalid', ...policy('project-a'), slices: [] }, null, 'create-invalid')).rejects.toBeInstanceOf(CapacityAllocationPolicyError);
			expect(await store.all(`SELECT id FROM capacity_allocation_sets`)).toEqual([]);
			const missingProject = await service.plan('team-a', { id: 'allocation-missing-project', ...policy('project-missing') });
			expect(missingProject.validation.diagnostics.map((entry) => entry.code)).toContain('allocation_project_not_found');
			const now = new Date().toISOString();
			await store.run(`INSERT INTO project_agent_classes (id, team_id, project_id, slug, name, status, allowed_modes_json, required_capabilities_json, kernel_profile_json, kernel_policy_json, handler_refs_json, output_contracts_json, metadata_json, created_at, updated_at) VALUES ('class-a', 'team-a', 'project-a', 'class-a', 'Class A', 'active', '["planning"]', '[]', '{}', '{}', '{}', '{}', '{}', ?, ?), ('class-b', 'team-a', 'project-b', 'class-b', 'Class B', 'active', '["planning"]', '[]', '{}', '{}', '{}', '{}', '{}', ?, ?)`, [now, now, now, now]);
			const unsupportedMode = await service.plan('team-a', {
				id: 'allocation-unsupported-mode', reservePolicy: { percent: 0, overflow: 'deny' },
				slices: [
					{ id: 'project-a', scope: 'project', targetId: 'project-a', policy: { minPercent: 0, targetPercent: 100, maxPercent: 100, hardCapPercent: 100 } },
					{ id: 'class-a', scope: 'agent-class', targetId: 'class-a', parentSliceId: 'project-a', policy: { minPercent: 0, targetPercent: 100, maxPercent: 100, hardCapPercent: 100 } },
					{ id: 'acting', scope: 'mode', targetId: 'acting', parentSliceId: 'class-a', policy: { minPercent: 0, targetPercent: 100, maxPercent: 100, hardCapPercent: 100 } },
				], borrowingRules: [],
			});
			expect(unsupportedMode.validation.diagnostics.map((entry) => entry.code)).toContain('allocation_mode_not_supported');
			const mismatchedClass = await service.plan('team-a', {
				id: 'allocation-mismatched-class', reservePolicy: { percent: 0, overflow: 'deny' },
				slices: [
					{ id: 'project-a', scope: 'project', targetId: 'project-a', policy: { minPercent: 0, targetPercent: 100, maxPercent: 100, hardCapPercent: 100 } },
					{ id: 'class-b', scope: 'agent-class', targetId: 'class-b', parentSliceId: 'project-a', policy: { minPercent: 0, targetPercent: 100, maxPercent: 100, hardCapPercent: 100 } },
				], borrowingRules: [],
			});
			expect(mismatchedClass.validation.diagnostics.map((entry) => entry.code)).toContain('allocation_agent_class_project_mismatch');
		} finally {
			await database.close();
		}
	});

	it('keeps non-overlapping active intervals and resolves only the currently effective version', async () => {
		const { database, store, service } = harness();
		try {
			await seedTeam(store);
			const current = await service.create('team-a', { id: 'allocation-current', ...policy('project-a'), effectiveFrom: '2020-01-01T00:00:00.000Z', effectiveUntil: '2030-01-01T00:00:00.000Z' }, null, 'create-current');
			const future = await service.create('team-a', { id: 'allocation-future', ...policy('project-b'), effectiveFrom: '2030-01-01T00:00:00.000Z' }, null, 'create-future');
			await service.activate('team-a', current.id, 'activate-current');
			await service.activate('team-a', future.id, 'activate-future');
			expect(await service.get('team-a', current.id)).toMatchObject({ status: 'active' });
			expect(await service.get('team-a', future.id)).toMatchObject({ status: 'active' });
			expect(await service.getActive('team-a')).toMatchObject({ id: current.id });
		} finally {
			await database.close();
		}
	});

	it('fails closed when durable allocation JSON is malformed', async () => {
		const { database, store, service } = harness();
		try {
			await seedTeam(store);
			const now = new Date().toISOString();
			await store.run(`INSERT INTO capacity_allocation_sets (id, team_id, version, status, effective_from, reserve_policy_json, slices_json, borrowing_rules_json, metadata_json, created_at, updated_at) VALUES ('allocation-corrupt', 'team-a', 1, 'draft', ?, '{', '[]', '[]', '{}', ?, ?)`, [now, now, now]);
			await expect(service.get('team-a', 'allocation-corrupt')).rejects.toMatchObject({ code: 'capacity_durable_json_invalid' });
		} finally {
			await database.close();
		}
	});
});
