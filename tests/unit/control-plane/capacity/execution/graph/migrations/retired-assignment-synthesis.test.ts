import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';

const migration = readFileSync('drizzle/control-plane/0042_retired_assignment_synthesis_provenance.sql', 'utf8');

it('normalizes only retired synthesis provenance and preserves historical assignments', async () => {
	const db = new PGlite();
	try {
		await db.exec(`CREATE TABLE capacity_provider_assignments (id text PRIMARY KEY, synthesized_from text, status text NOT NULL);
			INSERT INTO capacity_provider_assignments VALUES
			('legacy', 'engineering_pipeline', 'expired'),
			('living', 'living_execution_graph', 'completed'),
			('unattributed', NULL, 'completed');`);
		await db.exec(migration);
		await db.exec(migration);
		expect((await db.query('SELECT id,synthesized_from,status FROM capacity_provider_assignments ORDER BY id')).rows).toEqual([
			{ id: 'legacy', synthesized_from: null, status: 'expired' },
			{ id: 'living', synthesized_from: 'living_execution_graph', status: 'completed' },
			{ id: 'unattributed', synthesized_from: null, status: 'completed' },
		]);
	} finally { await db.close(); }
}, 15_000);

it('refuses to rewrite provenance on an active historical assignment', async () => {
	const db = new PGlite();
	try {
		await db.exec(`CREATE TABLE capacity_provider_assignments (id text PRIMARY KEY, synthesized_from text, status text NOT NULL);
			INSERT INTO capacity_provider_assignments VALUES ('active', 'engineering_pipeline', 'leased');`);
		await expect(db.exec(migration)).rejects.toThrow('Drain active retired-synthesis assignments');
		expect((await db.query("SELECT synthesized_from FROM capacity_provider_assignments WHERE id='active'")).rows)
			.toEqual([{ synthesized_from: 'engineering_pipeline' }]);
	} finally { await db.close(); }
}, 15_000);
