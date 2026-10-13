import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createControlPlanePostgresDatabase } from '../../../../../../../src/api/support/control-plane-postgres.ts';
import { commitLivingExecutionLifecycle } from '../../../../../../../src/api/capacity/services/capacity/assignments/lifecycle/execution/living-execution-lifecycle.ts';
import { persistExecutionGraph, createExecutionGraphService } from '../../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-service.ts';
import { agentDefinitionSchema, type ExecutionNode, type ExecutionEdge, type GraphRevision } from '@treeseed/sdk/agent-capacity';
import { projectCommunicationInvocations } from '../../../../../../../src/api/capacity/policy/execution/communication-execution-projector.ts';
import { digest as graphDigest, type TeamGraph } from '../../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-state.ts';
import { verifyNativeCommunicationEdges } from '../../../../../../acceptance/execution-inventory.ts';

describe('concurrent terminal graph revision custody', () => {
	it('commits five simultaneous results against reconciliation without duplicate or lost revisions', async () => {
		const url = process.env.TREESEED_TEST_POSTGRES_URL;
		if (!url) throw new Error('TREESEED_TEST_POSTGRES_URL is required; native concurrent terminal revision coverage cannot be skipped.');
		const connection = new URL(url);
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
				first: <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => db.prepare(sql).bind(...params).first<T>(),
				all: async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.prepare(sql).bind(...params).all<T>()).results,
				batch: (operations: Array<{ query: string; params?: unknown[] }>) => db.batch(operations) };
			const graph = { teamId: 'team', revision: 1, digest, nodes, edges: [] };
			const receipt: GraphRevision = { schemaVersion: 'treeseed.graph-revision/v1', teamId: 'team', revision: 1,
				ruleRevision: 1, changedSourceRefs: [sourceRef], graphDigest: digest, createdAt: now,
				changes: { added: nodes.map(node => node.id), changed: [], completed: [], blocked: [], stale: [], addedEdges: [], removedEdges: [] } };
			await persistExecutionGraph(store, graph, { ...graph, revision: 0, nodes: [] }, receipt);
			for (const node of nodes) await db.pool.query(`INSERT INTO capacity_provider_assignments
				(id,team_id,project_id,project_agent_class_id,capacity_provider_id,membership_id,mode,status,lease_state,state_version,graph_revision,
				assignment_attempt_json,execution_node_id,execution_node_revision,created_at,updated_at)
				VALUES ($1,'team','project','engineer','provider','membership','planning','leased','leased',1,1,$4,$2,1,$3,$3)`,
				[`assignment-${node.id}`, node.id, now, JSON.stringify({ sourceRef, graphRevision: 1, nodeRevision: 1, nodeId: node.id })]);
			// Hold the common row so all five real connections contend together.
			const blocker = await db.pool.connect();
			await blocker.query('BEGIN'); await blocker.query("SELECT id FROM teams WHERE id='team' FOR UPDATE");
			const writes = nodes.map(node => commitLivingExecutionLifecycle({ store,
				assignment: { id: `assignment-${node.id}`, teamId: 'team', executionNodeId: node.id,
					executionNodeRevision: 1, graphRevision: 1, stateVersion: 1,
					assignmentAttempt: { sourceRef, graphRevision: 1, nodeRevision: 1, nodeId: node.id } } as never,
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
			const graphService = createExecutionGraphService({ ...store, principalCanAccessTeam: async () => true,
				getTeamAccessSummary: async () => ({ permissions: ['projects:read:team'] }) });
			const principal = { id: 'controlled-native-reader', roles: [], permissions: [] };
			const current: TeamGraph = await graphService.show(principal, 'team', {});
			const definition = agentDefinitionSchema.parse({ schemaVersion: 'treeseed.agent/v1', id: 'project/renamed-peer',
				name: 'Renamed peer', agentClass: 'renamed-peer', purpose: 'Answer coordination prompts.', responsibilities: ['Answer the addressed question.'],
				capabilities: ['reasoning'], context: { include: ['project-objectives'] }, activityProfiles: { chat: { handler: 'writer',
					permissions: { content: { read: ['discussion'], write: ['discussion'] }, tools: ['discussion'] }, prompt: { system: 'Answer with the authorized context.' } } } });
			await db.pool.query("INSERT INTO capacity_workday_runs (id,team_id,status,execution_mode,created_at,updated_at) VALUES ('chat-workday','team','running','simulation',$1,$1)", [now]);
			const projected = projectCommunicationInvocations({ teamId: 'team', revision: current.revision + 1,
				profiles: { 'project:renamed-peer': definition }, sources: [{ id: 'native-chat-invocation', teamId: 'team', projectId: 'project',
					workdayId: 'chat-workday', agentId: 'renamed-peer', repository: 'library', commit: 'b'.repeat(40), path: 'discussion-messages/native/request.mdx', durationSeconds: 180 }] });
			const unrelated: ExecutionEdge = { schemaVersion: 'treeseed.execution-edge/v1', id: 'native-unrelated-edge', teamId: 'team',
				fromNodeId: nodes[0]!.id, toNodeId: nodes[1]!.id, provenance: 'profile-event', sourceRef, graphRevisionCreated: current.revision + 1 };
			let previous = current;
			const publish = async (edges: ExecutionEdge[], changes: GraphRevision['changes']) => {
				const next = { ...previous, revision: previous.revision + 1, nodes: [...current.nodes, ...projected.nodes], edges };
				next.digest = graphDigest({ teamId: next.teamId, nodes: next.nodes, edges: next.edges });
				await persistExecutionGraph(store, next, previous, { schemaVersion: 'treeseed.graph-revision/v1', teamId: 'team', revision: next.revision,
					ruleRevision: 1, changedSourceRefs: projected.changedSourceRefs, graphDigest: next.digest, changes, createdAt: now });
				previous = await graphService.show(principal, 'team', {}); return previous;
			};
			const changes = { added: projected.nodes.map(node => node.id), changed: [], completed: [], blocked: [], stale: [], addedEdges: [unrelated.id], removedEdges: [] };
			const shown = await publish([unrelated], changes), scope = { teamId: 'team', id: 'chat-workday' };
			const ids = shown.nodes.filter(node => node.kind === 'communication' && node.workdayId === scope.id).map(node => node.id);
			const peer = new pg.Pool({ connectionString: connection.href, max: 1 });
			try {
				const nativeNodes = (await peer.query("SELECT * FROM execution_nodes WHERE team_id=$1 AND workday_id=$2 AND kind='communication' ORDER BY id", [scope.teamId, scope.id])).rows;
				const edgeSql = 'SELECT * FROM execution_edges WHERE team_id=$1 AND (from_node_id=ANY($2::text[]) OR to_node_id=ANY($2::text[])) ORDER BY id';
				const edges = async () => (await peer.query(edgeSql, [scope.teamId, ids])).rows;
				verifyNativeCommunicationEdges(nativeNodes, await edges(), scope, ids);
				const forbidden: ExecutionEdge = { ...unrelated, id: 'native-chat-edge', fromNodeId: ids[0]!, toNodeId: nodes[2]!.id, graphRevisionCreated: previous.revision + 1 };
				await publish([unrelated, forbidden], { ...changes, added: [], addedEdges: [forbidden.id] });
				const active = await edges(); expect(active).toHaveLength(1);
				expect(() => verifyNativeCommunicationEdges(nativeNodes, active, scope, ids)).toThrow('ACCEPTANCE_NATIVE_CHAT_EDGE');
				await publish([unrelated], { ...changes, added: [], addedEdges: [], removedEdges: [forbidden.id] });
				expect(previous.edges.map(edge => edge.id)).toEqual([unrelated.id]);
				const retained = await edges(); expect(retained).toHaveLength(1); expect(Number(retained[0]!.graph_revision_removed)).toBeGreaterThan(0);
				const held = structuredClone(retained); expect(() => verifyNativeCommunicationEdges(nativeNodes, retained, scope, ids)).toThrow('ACCEPTANCE_NATIVE_CHAT_EDGE');
				expect(retained).toEqual(held); expect(await edges()).toEqual(held);
				expect(previous.nodes.filter(node => node.kind !== 'communication')).toEqual(current.nodes);
			} finally { await peer.end(); }

		} finally {
			await db.close(); await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); await admin.end();
		}
	}, 30_000);
});
