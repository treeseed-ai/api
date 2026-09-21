import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';

const migration = readFileSync('drizzle/control-plane/0040_remove_retired_allocation_authority.sql', 'utf8');

async function database() {
	const db = new PGlite();
	await db.exec(`CREATE TABLE capacity_workday_runs(id text PRIMARY KEY, status text NOT NULL, completed_at text, updated_at text NOT NULL DEFAULT '', error_json text NOT NULL DEFAULT '{}');
		CREATE TABLE capacity_allocation_sets(id text PRIMARY KEY);
		CREATE TABLE decision_assignment_graphs(id text PRIMARY KEY);
		CREATE TABLE capacity_provider_assignments(id text PRIMARY KEY, status text NOT NULL DEFAULT 'completed', allocation_set_id text REFERENCES capacity_allocation_sets(id));
		CREATE TABLE capacity_reservations(id text PRIMARY KEY, work_day_id text, state text NOT NULL DEFAULT 'reserved', reserved_seconds integer NOT NULL DEFAULT 1,
			active_seconds integer NOT NULL DEFAULT 0, released_seconds integer NOT NULL DEFAULT 0, updated_at text NOT NULL DEFAULT '', allocation_set_id text REFERENCES capacity_allocation_sets(id),
			allocation_version integer, allocation_slice_ids_json text NOT NULL DEFAULT '[]',
			CONSTRAINT chk_capacity_reservations_allocation_version CHECK (allocation_version IS NULL OR allocation_version >= 1));`);
	return db;
}

it('removes only retired allocation and decision authorities while retaining reservations', async () => {
	const db = await database();
	try {
		await db.exec(`INSERT INTO capacity_allocation_sets VALUES ('old');
			INSERT INTO decision_assignment_graphs VALUES ('old');
			INSERT INTO capacity_provider_assignments(id,allocation_set_id) VALUES ('assignment','old');
			INSERT INTO capacity_reservations(id,allocation_set_id,allocation_version,allocation_slice_ids_json) VALUES ('reservation','old',1,'["slice"]');`);
		await db.exec(migration);
		expect((await db.query('SELECT id FROM capacity_reservations')).rows).toEqual([{ id: 'reservation' }]);
		expect((await db.query('SELECT id FROM capacity_provider_assignments')).rows).toEqual([{ id: 'assignment' }]);
		for (const table of ['capacity_allocation_sets', 'decision_assignment_graphs']) {
			expect((await db.query('SELECT to_regclass($1) AS name', [table])).rows).toEqual([{ name: null }]);
		}
	} finally { await db.close(); }
}, 15_000);

it('cancels orphaned workdays and releases their unused reservation during the one-time cutover', async () => {
	const db = await database();
	try {
		await db.exec("INSERT INTO capacity_workday_runs(id,status) VALUES ('workday','running')");
		await db.exec("INSERT INTO capacity_reservations(id,work_day_id,reserved_seconds,active_seconds) VALUES ('reservation','workday',10,3)");
		await db.exec(migration);
		expect((await db.query("SELECT status,error_json FROM capacity_workday_runs")).rows)
			.toEqual([{ status: 'cancelled', error_json: '{"code":"architecture_contract_cutover"}' }]);
		expect((await db.query("SELECT state,released_seconds FROM capacity_reservations")).rows)
			.toEqual([{ state: 'released', released_seconds: 7 }]);
	} finally { await db.close(); }
}, 15_000);

it('refuses to remove an allocation authority while assignments are active', async () => {
	const db = await database();
	try {
		await db.exec("INSERT INTO capacity_provider_assignments(id,status) VALUES ('assignment','leased')");
		await expect(db.exec(migration)).rejects.toThrow('drain active assignments');
	} finally { await db.close(); }
}, 15_000);
