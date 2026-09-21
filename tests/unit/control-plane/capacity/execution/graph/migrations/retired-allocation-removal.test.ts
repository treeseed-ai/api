import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';

const migration = readFileSync('drizzle/control-plane/0040_remove_retired_allocation_authority.sql', 'utf8');

async function database() {
	const db = new PGlite();
	await db.exec(`CREATE TABLE capacity_workday_runs(id text PRIMARY KEY, status text NOT NULL);
		CREATE TABLE capacity_allocation_sets(id text PRIMARY KEY);
		CREATE TABLE decision_assignment_graphs(id text PRIMARY KEY);
		CREATE TABLE capacity_provider_assignments(id text PRIMARY KEY, status text NOT NULL DEFAULT 'completed', allocation_set_id text REFERENCES capacity_allocation_sets(id));
		CREATE TABLE capacity_reservations(id text PRIMARY KEY, allocation_set_id text REFERENCES capacity_allocation_sets(id),
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
			INSERT INTO capacity_reservations VALUES ('reservation','old',1,'["slice"]');`);
		await db.exec(migration);
		expect((await db.query('SELECT id FROM capacity_reservations')).rows).toEqual([{ id: 'reservation' }]);
		expect((await db.query('SELECT id FROM capacity_provider_assignments')).rows).toEqual([{ id: 'assignment' }]);
		for (const table of ['capacity_allocation_sets', 'decision_assignment_graphs']) {
			expect((await db.query('SELECT to_regclass($1) AS name', [table])).rows).toEqual([{ name: null }]);
		}
	} finally { await db.close(); }
}, 15_000);

it('refuses to remove an allocation authority while workdays are running', async () => {
	const db = await database();
	try {
		await db.exec("INSERT INTO capacity_workday_runs VALUES ('workday','running')");
		await expect(db.exec(migration)).rejects.toThrow('drain active workdays');
		expect((await db.query("SELECT to_regclass('capacity_allocation_sets') AS name")).rows)
			.toEqual([{ name: 'capacity_allocation_sets' }]);
	} finally { await db.close(); }
}, 15_000);

it('refuses to remove an allocation authority while assignments are active', async () => {
	const db = await database();
	try {
		await db.exec("INSERT INTO capacity_provider_assignments(id,status) VALUES ('assignment','leased')");
		await expect(db.exec(migration)).rejects.toThrow('drain active assignments');
	} finally { await db.close(); }
}, 15_000);
