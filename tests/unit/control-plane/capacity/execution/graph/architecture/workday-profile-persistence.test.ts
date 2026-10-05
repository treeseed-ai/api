import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import type { GraphRevision } from '@treeseed/sdk/agent-capacity';
import { persistExecutionGraph } from '../../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-service.ts';
import type { TeamGraph } from '../../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-state.ts';
import { splitPostgresSqlStatements } from '../../../../../../../src/api/persistence/postgres-sql-statements.ts';
import { emptyGraph, profile, project, reconcile } from './workday-profile-fixture.ts';

type ReportingRow = { id: string; agent_class: string; status: string;
	requested_permissions_json: string; source_ref_json: string };
type LifecycleRow = { kind: string; source_kind: string; condition_json: string };

async function database() {
	const db = new PGlite();
	try {
		await db.exec(`CREATE TABLE teams (id text PRIMARY KEY);
			INSERT INTO teams VALUES ('team');
			CREATE TABLE capacity_provider_assignments (id text PRIMARY KEY, team_id text, status text);`);
		for (const file of ['0023_living_execution_graph.sql', '0041_execution_content_output_authority.sql', '0044_execution_priority_dependency_provenance.sql']) {
			for (const statement of splitPostgresSqlStatements(readFileSync(`drizzle/control-plane/${file}`, 'utf8'))) {
				await db.exec(statement);
			}
		}
		return db;
	} catch (error) { await db.close(); throw error; }
}

async function persist(db: PGlite, next: TeamGraph, current: TeamGraph) {
	const query = async (sql: string, params: unknown[] = []) => {
		let index = 0;
		return db.query(sql.replace(/\?/gu, () => `$${++index}`), params);
	};
	const store = {
		batch: (operations: Array<{ query: string; params: unknown[] }>) => db.transaction(async transaction => {
			for (const operation of operations) {
				let index = 0;
				await transaction.query(operation.query.replace(/\?/gu, () => `$${++index}`), operation.params);
			}
		}),
		first: async (sql: string, params: unknown[]) => (await query(sql, params)).rows[0],
	};
	const receipt: GraphRevision = { schemaVersion: 'treeseed.graph-revision/v1', teamId: next.teamId,
		revision: next.revision, ruleRevision: 1, changedSourceRefs: next.nodes.map(node => node.sourceRef),
		graphDigest: next.digest, changes: { added: [], changed: [], completed: [], blocked: [], stale: [],
			removedEdges: [], addedEdges: [] }, createdAt: `2026-09-16T12:00:0${next.revision}.000Z` };
	await persistExecutionGraph(store, next, current, receipt);
}

describe('governed lifecycle graph SQL custody', () => {
	it('persists and read-backs renamed reporting readiness through the original closing transition', async () => {
		const db = await database();
		try {
			const definition = profile('closeout-author');
			const active = reconcile(project([definition]));
			await persist(db, active, emptyGraph());
			const closing = reconcile(project([definition], 'closing'), active, 2);
			await persist(db, closing, active);
			const rows = (await db.query<ReportingRow>(`SELECT id,agent_class,status,requested_permissions_json,source_ref_json
				FROM execution_nodes WHERE kind='reporting' ORDER BY id`)).rows;
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ agent_class: 'closeout-author', status: 'ready' });
			expect(JSON.parse(String(rows[0]!.requested_permissions_json))).toEqual(definition.activityProfiles.reporting!.permissions);
			expect(JSON.parse(String(rows[0]!.source_ref_json))).toEqual(closing.nodes.find(node => node.kind === 'reporting')!.sourceRef);
			const replay = reconcile(project([definition], 'closing'), closing, 3);
			await persist(db, replay, closing);
			expect((await db.query("SELECT id FROM execution_nodes WHERE kind='reporting'")).rows).toEqual([{ id: rows[0]!.id }]);
			expect((await db.query(`SELECT from_node_id,to_node_id,COUNT(*) AS count FROM execution_edges
				GROUP BY from_node_id,to_node_id HAVING COUNT(*)>1`)).rows).toEqual([]);
			expect((await db.query('SELECT revision FROM execution_graph_revisions ORDER BY revision')).rows)
				.toEqual([{ revision: 1 }, { revision: 2 }, { revision: 3 }]);
		} finally { await db.close(); }
	});

	it('persists lifecycle edges only for the activity that declares them in YAML', async () => {
		const db = await database();
		try {
			const graph = reconcile(project([profile('reporter', { closing: false, planningClosing: true })]));
			await persist(db, graph, emptyGraph());
			const rows = (await db.query<LifecycleRow>(`SELECT target.kind,source.kind AS source_kind,source.condition_json
				FROM execution_edges edge JOIN execution_nodes target ON target.id=edge.to_node_id
				JOIN execution_nodes source ON source.id=edge.from_node_id
				WHERE edge.provenance='profile-event' AND edge.graph_revision_removed IS NULL`)).rows;
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ kind: 'planning', source_kind: 'condition' });
			expect(JSON.parse(String(rows[0]!.condition_json))).toMatchObject({ expectedState: 'closing' });
			expect((await db.query("SELECT kind,status FROM execution_nodes WHERE kind IN ('planning','reporting') ORDER BY kind")).rows)
				.toEqual([{ kind: 'planning', status: 'blocked' }, { kind: 'reporting', status: 'ready' }]);
		} finally { await db.close(); }
	});
});
