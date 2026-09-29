import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';

const migration = readFileSync('drizzle/control-plane/0043_remove_retired_graph_estimate_minimum.sql', 'utf8');

it('removes only the retired minimum from persisted graph estimates and replays as a noop', async () => {
	const db = new PGlite();
	try {
		await db.exec(`CREATE TABLE execution_nodes (id text PRIMARY KEY, estimate_json text);
			INSERT INTO execution_nodes VALUES
			('legacy', '{"minimumSeconds":30,"expectedSeconds":60,"maximumSeconds":120,"rationale":"Measured work"}'),
			('current', '{"expectedSeconds":40,"maximumSeconds":90}'),
			('condition', NULL);`);
		await db.exec(migration);
		const first = (await db.query('SELECT id,estimate_json FROM execution_nodes ORDER BY id')).rows;
		await db.exec(migration);
		const second = (await db.query('SELECT id,estimate_json FROM execution_nodes ORDER BY id')).rows;
		expect(second).toEqual(first);
		expect(first.map((row) => ({ id: row.id, estimate: row.estimate_json ? JSON.parse(String(row.estimate_json)) : null }))).toEqual([
			{ id: 'condition', estimate: null },
			{ id: 'current', estimate: { expectedSeconds: 40, maximumSeconds: 90 } },
			{ id: 'legacy', estimate: { expectedSeconds: 60, maximumSeconds: 120, rationale: 'Measured work' } },
		]);
	} finally { await db.close(); }
}, 15_000);
