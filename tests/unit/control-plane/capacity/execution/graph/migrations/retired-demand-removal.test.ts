import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('removes retired scheduling tables while preserving the living graph and assignments', async () => {
	const db = new PGlite();
	try {
		await db.exec(`CREATE TABLE agent_capacity_plans(id text PRIMARY KEY);
			CREATE TABLE capacity_workday_demands(id text PRIMARY KEY, capacity_plan_id text REFERENCES agent_capacity_plans(id));
			CREATE TABLE capacity_workday_participation_cycles(id text PRIMARY KEY);
			CREATE TABLE capacity_workday_participation_entries(id text PRIMARY KEY,
				demand_id text REFERENCES capacity_workday_demands(id),
				cycle_id text REFERENCES capacity_workday_participation_cycles(id));
			CREATE TABLE capacity_provider_assignments(id text PRIMARY KEY);
			CREATE TABLE execution_nodes(id text PRIMARY KEY);`);
		await db.exec(readFileSync('drizzle/control-plane/0035_remove_retired_workday_demand_authority.sql', 'utf8'));
		const tables = (await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'")).rows;
		expect(tables).toEqual(expect.arrayContaining([
			{ table_name: 'capacity_provider_assignments' }, { table_name: 'execution_nodes' },
		]));
		for (const name of ['agent_capacity_plans', 'capacity_workday_demands',
			'capacity_workday_participation_cycles', 'capacity_workday_participation_entries']) {
			expect(tables).not.toContainEqual({ table_name: name });
		}
	} finally { await db.close(); }
}, 15_000);

it('removes the duplicated decision input without deleting immutable attempts', async () => {
	const db = new PGlite();
	try {
		await db.exec(`CREATE TABLE capacity_provider_assignments(id text PRIMARY KEY,
			decision_input_json text NOT NULL DEFAULT '{}', assignment_attempt_json jsonb);
			INSERT INTO capacity_provider_assignments(id,assignment_attempt_json)
			VALUES ('assignment','{"nodeId":"node"}'::jsonb);`);
		await db.exec(readFileSync('drizzle/control-plane/0036_remove_retired_decision_execution_input.sql', 'utf8'));
		const rows = (await db.query("SELECT assignment_attempt_json FROM capacity_provider_assignments WHERE id='assignment'")).rows;
		expect(rows).toEqual([{ assignment_attempt_json: { nodeId: 'node' } }]);
		const columns = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_name='capacity_provider_assignments'")).rows;
		expect(columns).not.toContainEqual({ column_name: 'decision_input_json' });
	} finally { await db.close(); }
}, 15_000);

it('drops duplicate project agent policy without discarding exact library custody', async () => {
	const db = new PGlite();
	try {
		await db.exec(`CREATE TABLE project_agent_classes(id text PRIMARY KEY, allowed_modes_json jsonb,
			required_capabilities_json jsonb, kernel_profile_json jsonb, kernel_policy_json jsonb,
			output_contracts_json jsonb, handler_refs_json jsonb, metadata_json jsonb);
			INSERT INTO project_agent_classes(id,handler_refs_json,metadata_json)
			VALUES ('class','{"agents":[]}'::jsonb,'{"immutableRef":"abc"}'::jsonb);`);
		await db.exec(readFileSync('drizzle/control-plane/0037_remove_retired_project_agent_policy.sql', 'utf8'));
		const rows = (await db.query("SELECT handler_refs_json,metadata_json FROM project_agent_classes WHERE id='class'")).rows;
		expect(rows).toEqual([{ handler_refs_json: { agents: [] }, metadata_json: { immutableRef: 'abc' } }]);
		const columns = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_name='project_agent_classes'")).rows;
		for (const column of ['allowed_modes_json', 'required_capabilities_json', 'kernel_profile_json', 'kernel_policy_json', 'output_contracts_json'])
			expect(columns).not.toContainEqual({ column_name: column });
	} finally { await db.close(); }
}, 15_000);

it('replaces mode-run links with exact assignment provenance before dropping the duplicate table', async () => {
	const db = new PGlite();
	try {
		await db.exec(`CREATE TABLE capacity_provider_assignments(id text PRIMARY KEY);
			CREATE TABLE agent_mode_runs(id text PRIMARY KEY, provider_assignment_id text NOT NULL REFERENCES capacity_provider_assignments(id));
			CREATE TABLE capacity_ledger_entries(id text PRIMARY KEY, assignment_id text, mode_run_id text REFERENCES agent_mode_runs(id));
			CREATE TABLE capacity_usage_actuals(id text PRIMARY KEY, assignment_id text, mode_run_id text REFERENCES agent_mode_runs(id));
			CREATE TABLE capacity_workday_events(id text PRIMARY KEY, assignment_id text, mode_run_id text);
			INSERT INTO capacity_provider_assignments VALUES ('assignment');
			INSERT INTO agent_mode_runs VALUES ('retired-run','assignment');
			INSERT INTO capacity_ledger_entries VALUES ('ledger',NULL,'retired-run');
			INSERT INTO capacity_usage_actuals VALUES ('usage',NULL,'retired-run');
			INSERT INTO capacity_workday_events VALUES ('event',NULL,'retired-run');`);
		await db.exec(readFileSync('drizzle/control-plane/0038_remove_retired_mode_runs.sql', 'utf8'));
		for (const [table, id] of [['capacity_ledger_entries', 'ledger'], ['capacity_usage_actuals', 'usage'], ['capacity_workday_events', 'event']]) {
			expect((await db.query(`SELECT assignment_id FROM ${table} WHERE id=$1`, [id])).rows)
				.toEqual([{ assignment_id: 'assignment' }]);
		}
		expect((await db.query("SELECT to_regclass('public.agent_mode_runs') AS table_name")).rows)
			.toEqual([{ table_name: null }]);
	} finally { await db.close(); }
}, 15_000);

it('refuses to erase conflicting mode-run assignment provenance', async () => {
	const db = new PGlite();
	try {
		await db.exec(`CREATE TABLE agent_mode_runs(id text PRIMARY KEY, provider_assignment_id text NOT NULL);
			CREATE TABLE capacity_ledger_entries(id text PRIMARY KEY, assignment_id text, mode_run_id text);
			CREATE TABLE capacity_usage_actuals(id text PRIMARY KEY, assignment_id text, mode_run_id text);
			CREATE TABLE capacity_workday_events(id text PRIMARY KEY, assignment_id text, mode_run_id text);
			INSERT INTO agent_mode_runs VALUES ('retired-run','correct-assignment');
			INSERT INTO capacity_workday_events VALUES ('event','different-assignment','retired-run');`);
		await expect(db.exec(readFileSync('drizzle/control-plane/0038_remove_retired_mode_runs.sql', 'utf8')))
			.rejects.toThrow(/provenance conflicts/u);
		expect((await db.query("SELECT to_regclass('public.agent_mode_runs') AS table_name")).rows[0]?.table_name)
			.not.toBeNull();
	} finally { await db.close(); }
}, 15_000);

it('removes drained workday envelopes without removing workday or assignment custody', async () => {
	const db = new PGlite();
	try {
		await db.exec(`CREATE TABLE capacity_workday_runs(id text PRIMARY KEY);
			CREATE TABLE capacity_provider_assignments(id text PRIMARY KEY);
			CREATE TABLE workday_capacity_envelopes(id text PRIMARY KEY,status text NOT NULL);
			INSERT INTO capacity_workday_runs VALUES ('run');
			INSERT INTO capacity_provider_assignments VALUES ('assignment');
			INSERT INTO workday_capacity_envelopes VALUES ('old','completed');`);
		await db.exec(readFileSync('drizzle/control-plane/0039_remove_workday_capacity_envelopes.sql', 'utf8'));
		expect((await db.query("SELECT to_regclass('public.workday_capacity_envelopes') AS table_name")).rows)
			.toEqual([{ table_name: null }]);
		expect((await db.query('SELECT id FROM capacity_workday_runs')).rows).toEqual([{ id: 'run' }]);
		expect((await db.query('SELECT id FROM capacity_provider_assignments')).rows).toEqual([{ id: 'assignment' }]);
	} finally { await db.close(); }
}, 15_000);

it('refuses to drop a still-admissible workday envelope', async () => {
	const db = new PGlite();
	try {
		await db.exec(`CREATE TABLE workday_capacity_envelopes(id text PRIMARY KEY,status text NOT NULL);
			INSERT INTO workday_capacity_envelopes VALUES ('live','active');`);
		await expect(db.exec(readFileSync('drizzle/control-plane/0039_remove_workday_capacity_envelopes.sql', 'utf8')))
			.rejects.toThrow(/must be drained/u);
		expect((await db.query("SELECT to_regclass('public.workday_capacity_envelopes') AS table_name")).rows[0]?.table_name)
			.not.toBeNull();
	} finally { await db.close(); }
}, 15_000);
