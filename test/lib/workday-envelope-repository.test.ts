import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataType, newDb } from 'pg-mem';
import { CapacityGovernanceError } from '../../src/api/capacity/database.ts';
import { WorkdayCapacityEnvelopeRepository, serializeWorkdayCapacityEnvelopeRow } from '../../src/api/capacity/repositories/workday-envelope.ts';
import { MarketPostgresDatabase } from '../../src/api/market-postgres.js';
import { MarketControlPlaneStore } from '../../src/api/store.js';

const packageRoot = process.cwd();
const migrationRoot = existsSync(resolve(packageRoot, '../sdk/drizzle/market')) ? resolve(packageRoot, '../sdk/drizzle/market') : resolve(packageRoot, 'node_modules/@treeseed/sdk/drizzle/market');

function harness() {
	const memory = newDb();
	memory.public.registerFunction({ name: 'md5', args: [DataType.text], returns: DataType.text, implementation: (value: string) => `md5:${value}` });
	const pg = memory.adapters.createPg();
	const database = MarketPostgresDatabase.fromPool(new pg.Pool(), { migrationRoot });
	const store = new MarketControlPlaneStore({ repoRoot: packageRoot }, database);
	return { database, store, repository: new WorkdayCapacityEnvelopeRepository(store) };
}

function row(overrides: Record<string, unknown> = {}) {
	return {
		id: 'workday-a',
		team_id: 'team-a',
		project_id: 'project-a',
		workday_run_id: 'run-a',
		allocation_set_id: 'allocation-a',
		status: 'active',
		started_at: '2026-07-18T00:00:00.000Z',
		paused_at: null,
		completed_at: null,
		envelope_json: '{"teamId":"team-a","projectId":"project-a","workDayId":"workday-a"}',
		metadata_json: '{}',
		created_at: '2026-07-18T00:00:00.000Z',
		updated_at: '2026-07-18T00:00:00.000Z',
		...overrides,
	};
}

describe('workday capacity envelope repository serialization', () => {
	it('preserves durable run, allocation, lifecycle, and envelope provenance', () => {
		expect(serializeWorkdayCapacityEnvelopeRow(row())).toMatchObject({
			id: 'workday-a',
			teamId: 'team-a',
			projectId: 'project-a',
			workdayRunId: 'run-a',
			allocationSetId: 'allocation-a',
			status: 'active',
			envelope: { workDayId: 'workday-a' },
		});
	});

	it.each([
		['missing JSON', { envelope_json: null }, 'capacity_durable_json_invalid'],
		['malformed JSON', { metadata_json: '{' }, 'capacity_durable_json_invalid'],
		['non-object JSON', { metadata_json: '[]' }, 'capacity_durable_json_invalid'],
		['unknown status', { status: 'running' }, 'capacity_workday_status_invalid'],
	])('fails closed for %s', (_label, overrides, code) => {
		expect(() => serializeWorkdayCapacityEnvelopeRow(row(overrides))).toThrowError(
			expect.objectContaining<Partial<CapacityGovernanceError>>({ code }),
		);
	});
});

describe('workday capacity envelope mutation idempotency', () => {
	it('durably replays create and transition and rejects conflicting key reuse', async () => {
		const { database, store, repository } = harness();
		try {
			await store.ensureInitialized();
			const now = new Date().toISOString();
			await store.run(`INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES ('team-a', 'team-a', 'Team A', ?, ?)`, [now, now]);
			await store.run(`INSERT INTO projects (id, team_id, slug, name, created_at, updated_at) VALUES ('project-a', 'team-a', 'project-a', 'Project A', ?, ?)`, [now, now]);
			const input = { id: 'workday-a', projectId: 'project-a', status: 'draft' as const, availableCredits: 10 };
			const [created, concurrentReplay] = await Promise.all([
				repository.create(input, 'stable-workday-create'),
				repository.create(input, 'stable-workday-create'),
			]);
			expect(concurrentReplay).toEqual(created);
			const restartedRepository = new WorkdayCapacityEnvelopeRepository(store);
			expect(await restartedRepository.create(input, 'stable-workday-create')).toEqual(created);
			await expect(repository.create({ ...input, id: 'workday-b' }, 'stable-workday-create'))
				.rejects.toMatchObject({ code: 'capacity_idempotency_key_conflict' });
			const active = await repository.transition('workday-a', 'active', 'stable-workday-start');
			expect(await restartedRepository.transition('workday-a', 'active', 'stable-workday-start')).toEqual(active);
			expect(await store.all('SELECT id FROM workday_capacity_envelopes')).toHaveLength(1);
			expect(await store.all('SELECT id FROM capacity_operation_receipts')).toHaveLength(2);
		} finally { await database.close(); }
	});
});
