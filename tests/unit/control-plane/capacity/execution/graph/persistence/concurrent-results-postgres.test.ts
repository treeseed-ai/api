import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createControlPlanePostgresDatabase } from '../../../../../../../src/api/support/control-plane-postgres.ts';
import { commitLivingExecutionLifecycle } from '../../../../../../../src/api/capacity/services/capacity/assignments/lifecycle/execution/living-execution-lifecycle.ts';
import { persistExecutionGraph } from '../../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-service.ts';
import type { ExecutionNode, GraphRevision } from '@treeseed/sdk/agent-capacity';

describe.skipIf(!process.env.TREESEED_TEST_POSTGRES_URL)('concurrent terminal graph revision custody', () => {
	it('commits five simultaneous results against reconciliation without duplicate or lost revisions', async () => {
		const connection = new URL(process.env.TREESEED_TEST_POSTGRES_URL!);
		if (connection.hostname !== '127.0.0.1' || connection.pathname !== '/postgres') throw new Error('Disposable loopback PostgreSQL required.');
		const admin = new pg.Pool({ connectionString: connection.href });
		const name = `treeseed_revision_test_${randomUUID().replaceAll('-', '')}`;
		await admin.query(`CREATE DATABASE "${name}"`);
		connection.pathname = `/${name}`;
		const db = createControlPlanePostgresDatabase(connection.href, { migrationMode: 'apply' });
		try {
			await db.migrate();
			const now = new Date().toISOString(), digest = `sha256:${'a'.repeat(64)}`;
			await db.pool.query(`INSERT INTO teams (id,slug,name,created_at,updated_at) VALUES ('team','team','Team',$1,$1)`, [now]);
			await db.pool.query(`INSERT INTO projects (id,team_id,slug,name,created_at,updated_at) VALUES ('project','team','project','Project',$1,$1)`, [now]);
			await db.pool.query(`INSERT INTO capacity_providers (id,fingerprint,public_jwk_json,display_name,created_at,updated_at) VALUES ('provider','test','{}','Provider',$1,$1)`, [now]);
			await db.pool.query(`INSERT INTO capacity_provider_team_memberships (id,team_id,capacity_provider_id,approved_at,approved_by_id,created_at,updated_at) VALUES ('membership','team','provider',$1,'test',$1,$1)`, [now]);
			await db.pool.query(`INSERT INTO project_agent_classes (id,team_id,project_id,slug,name,created_at,updated_at) VALUES ('engineer','team','project','engineer','Engineer',$1,$1)`, [now]);
			const sourceRef = { store: 'treedx' as const, model: 'proposal', id: 'proposal', revision: 1,
				digest, repository: 'library', commit: 'b'.repeat(40), path: 'proposals/one.mdx' };
			const nodes: ExecutionNode[] = Array.from({ length: 5 }, (_, index) => ({
				schemaVersion: 'treeseed.execution-node/v1', id: `node-${index}`, teamId: 'team', projectId: 'project',
				kind: 'planning', pairRole: null, sourceRef, authorityRefs: [], ruleRevision: 1, nodeRevision: 1,
				estimate: { expectedSeconds: 180, maximumSeconds: 180 }, requiredCapabilities: ['treeseed.coordination.planning'],
				requestedPermissions: { content: { read: ['proposal'], write: [] }, tools: ['source.read'] }, workspace: 'read-only',
				agentClass: 'engineer', status: 'running', graphRevisionCreated: 1, graphRevisionUpdated: 1,
			}));
			const store = { db, ensureInitialized: async () => {},
				run: async (sql: string, params: unknown[] = []) => { await db.prepare(sql).bind(...params).run(); },
				first: (sql: string, params: unknown[] = []) => db.prepare(sql).bind(...params).first(),
				all: async (sql: string, params: unknown[] = []) => (await db.prepare(sql).bind(...params).all()).results,
				batch: (operations: Array<{ query: string; params?: unknown[] }>) => db.batch(operations) };
			const graph = { teamId: 'team', revision: 1, digest, nodes, edges: [] };
			const receipt: GraphRevision = { schemaVersion: 'treeseed.graph-revision/v1', teamId: 'team', revision: 1,
				ruleRevision: 1, changedSourceRefs: [sourceRef], graphDigest: digest, createdAt: now,
				changes: { added: nodes.map(node => node.id), changed: [], completed: [], blocked: [], stale: [], addedEdges: [], removedEdges: [] } };
			await persistExecutionGraph(store, graph, { ...graph, revision: 0, nodes: [] }, receipt);
			for (const node of nodes) await db.pool.query(`INSERT INTO capacity_provider_assignments
				(id,team_id,project_id,project_agent_class_id,capacity_provider_id,membership_id,mode,status,execution_node_id,execution_node_revision,created_at,updated_at)
				VALUES ($1,'team','project','engineer','provider','membership','planning','leased',$2,1,$3,$3)`, [`assignment-${node.id}`, node.id, now]);
			// Hold the common row so all five real connections contend together.
			const blocker = await db.pool.connect();
			await blocker.query('BEGIN'); await blocker.query("SELECT id FROM teams WHERE id='team' FOR UPDATE");
			const writes = nodes.map(node => commitLivingExecutionLifecycle({ store,
				assignment: { id: `assignment-${node.id}`, teamId: 'team', executionNodeId: node.id,
					executionNodeRevision: 1, assignmentAttempt: { sourceRef } } as never,
				status: 'completed', now }, [{ query: 'UPDATE capacity_provider_assignments SET status=? WHERE id=?',
					params: ['completed', `assignment-${node.id}`] }]));
			const staleProjection = persistExecutionGraph(store, { ...graph, revision: 2 }, graph, { ...receipt, revision: 2 })
				.catch(error => { expect(error).toMatchObject({ code: 'execution_graph_revision_conflict' }); });
			await blocker.query('COMMIT'); blocker.release();
			await Promise.all([...writes, staleProjection]);
			const revisions = (await db.pool.query('SELECT revision,changes_json FROM execution_graph_revisions ORDER BY revision')).rows;
			expect(revisions.map(row => row.revision)).toEqual(Array.from({ length: revisions.length }, (_, index) => index + 1));
			expect(revisions.flatMap(row => JSON.parse(row.changes_json).completed)).toEqual(expect.arrayContaining(nodes.map(node => node.id)));
			expect(revisions.flatMap(row => JSON.parse(row.changes_json).completed)).toHaveLength(5);
			expect((await db.pool.query('SELECT status,source_ref_json,node_revision FROM execution_nodes')).rows)
				.toEqual(nodes.map(() => expect.objectContaining({ status: 'completed', source_ref_json: JSON.stringify(sourceRef), node_revision: 1 })));
			expect((await db.pool.query('SELECT status FROM capacity_provider_assignments')).rows.every(row => row.status === 'completed')).toBe(true);
		} finally {
			await db.close(); await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); await admin.end();
		}
	}, 30_000);
});
