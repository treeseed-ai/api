import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { splitPostgresSqlStatements } from '../../../../../../src/api/persistence/postgres-sql-statements.ts';

it('stores normalized team graphs with one append-only revision stream', async () => {
	const db = new PGlite();
	try {
		await db.exec('CREATE TABLE capacity_provider_assignments(id text PRIMARY KEY, team_id text NOT NULL, status text NOT NULL);');
		for (const statement of splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0023_living_execution_graph.sql', 'utf8'))) await db.exec(statement);
		await db.exec(`INSERT INTO execution_graph_revisions
			(team_id,revision,rule_revision,changed_source_refs_json,graph_digest,changes_json,created_at)
			VALUES ('team-a',1,1,'[]','sha256:${'a'.repeat(64)}','{}','now'),
				('team-a',2,1,'[]','sha256:${'b'.repeat(64)}','{}','later'),
				('team-b',1,1,'[]','sha256:${'c'.repeat(64)}','{}','now');`);
		expect((await db.query("SELECT revision FROM execution_graph_revisions WHERE team_id='team-a' ORDER BY revision")).rows)
			.toEqual([{ revision: 1 }, { revision: 2 }]);
		await db.exec(`INSERT INTO execution_nodes (
			id,team_id,project_id,work_item_id,kind,pair_role,source_ref_json,authority_refs_json,
			rule_revision,node_revision,agent_class,status,estimate_json,required_capabilities_json,
			requested_permissions_json,workspace,acceptance_criteria_json,maximum_review_cycles,
			graph_revision_created,graph_revision_updated,created_at,updated_at
		) VALUES ('node-a','team-a','project-a','work','acting','actor','{}','[]',1,1,'engineer','ready','{}','[]','{}','git','[]',1,1,1,'now','now')`);
		expect((await db.query("SELECT id FROM execution_nodes WHERE team_id='team-b'")).rows).toEqual([]);
		const tables = (await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'")).rows;
		expect(tables).not.toEqual(expect.arrayContaining([
			{ table_name: 'execution_graph_events' },
			{ table_name: 'execution_graph_reconciliation_receipts' },
		]));
	} finally { await db.close(); }
}, 15_000);

it('contains no execution-plan, capacity-plan, demand, source-candidate, or artifact-manifest storage', () => {
	const migration = readFileSync('drizzle/control-plane/0023_living_execution_graph.sql', 'utf8');
	expect(migration).not.toMatch(/execution_plan|capacity_plan|workday_demands|source_candidate|artifact_manifest/iu);
});

it('allows living assignments to reserve a node without legacy grant or allocation identity', async () => {
	const db = new PGlite();
	try {
		await db.exec(`CREATE TABLE capacity_reservations (
			id text PRIMARY KEY, admission_token text NOT NULL, grant_id text NOT NULL,
			allocation_set_id text NOT NULL, allocation_version integer NOT NULL,
			CONSTRAINT chk_capacity_reservations_allocation_version CHECK (allocation_version >= 1)
		);`);
		for (const statement of splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0025_living_execution_reservations.sql', 'utf8'))) {
			await db.exec(statement);
		}
		await db.exec("INSERT INTO capacity_reservations(id,admission_token,grant_id,allocation_set_id,allocation_version) VALUES ('living',NULL,NULL,NULL,NULL)");
		expect((await db.query("SELECT id FROM capacity_reservations WHERE id='living'")).rows).toEqual([{ id: 'living' }]);
	} finally { await db.close(); }
}, 15_000);

it('repairs partial live graph adoption without restoring retired authorities', () => {
	const migration = readFileSync('drizzle/control-plane/0029_complete_living_assignment_result.sql', 'utf8');
	expect(migration).toContain('ADD COLUMN IF NOT EXISTS assignment_result_json');
	expect(migration).not.toMatch(/capacity_workday_demands|agent_capacity_plans|execution_plan/u);
});
