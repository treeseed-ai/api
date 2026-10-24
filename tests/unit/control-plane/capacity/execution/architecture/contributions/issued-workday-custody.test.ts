import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { compileWorkday, DEFAULT_WORKDAY_POLICY, executionNodeSchema, executionEdgeSchema, graphRevisionSchema, type AgentDefinition } from '@treeseed/sdk/agent-capacity';
import { projectActiveWorkdays } from '../../../../../../../src/api/capacity/policy/execution/workday-execution-projector.ts';
import { agentProfileReference } from '../../../../../../../src/api/capacity/policy/execution/agent-profile-reference.ts';
import { digest, type TeamGraph } from '../../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-state.ts';
import { persistExecutionGraph } from '../../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-service.ts';
import { decodeExecutionNode, decodeExecutionEdge } from '../../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-storage.ts';
import { splitPostgresSqlStatements } from '../../../../../../../src/api/persistence/postgres-sql-statements.ts';
import { livingGraphDatabase, emptyLivingGraph } from '../../graph/architecture/living/living-graph-fixture.ts';

// Controlled historical node/edge INPUTS. No model execution, claims, usage or
// settlement is fabricated or claimed by these projection/storage checks.
function originalPlanning() {
	const definitions: AgentDefinition[] = ['author', 'critic'].map(name => ({ schemaVersion: 'treeseed.agent/v1',
		id: `old/${name}`, name: `Original ${name}`, agentClass: 'shared-allocation', purpose: 'Own useful project work.',
		responsibilities: ['Preserve original authority.'], capabilities: ['planning'], context: { include: ['assignment-subject'] },
		activityProfiles: { planning: { handler: 'writer', prompt: { system: 'Contribute to the actual project objective.' },
			permissions: { content: { read: ['proposal'], write: ['proposal'] }, tools: [] } } },
	}));
	const plan = { ...compileWorkday({ id: 'retained', teamId: 'team', policyId: 'default', policyRevision: 1,
		executionMode: 'simulation', startsAt: '2026-10-19T12:00:00Z', policy: DEFAULT_WORKDAY_POLICY,
		agentIds: definitions.map(definition => `sdk/${definition.id}:planning`) }), state: 'active' as const };
	const source = { id: plan.id, teamId: 'team', parameters: { appliedPlan: plan, scheduledProjectIds: ['sdk'],
		agentProfilesByProjectId: { sdk: { agents: definitions.map(definition => ({ definition, activities: ['planning'] })) } } } };
	const authority = projectActiveWorkdays({ teamId: 'team', revision: 1, profiles: {}, sources: [source] }).changedSourceRefs[0]!;
	const nodes = definitions.map((definition, index) => executionNodeSchema.parse({ schemaVersion: 'treeseed.execution-node/v1',
		id: plan.planningRounds[0]!.assignmentIds[index], teamId: 'team', projectId: 'sdk', workdayId: plan.id,
		kind: 'planning', pairRole: null, sourceRef: authority, authorityRefs: [authority, agentProfileReference(definition)],
		agentClass: definition.agentClass, ruleRevision: 1, nodeRevision: 1, status: index ? 'running' : 'completed',
		estimate: { expectedSeconds: 20, maximumSeconds: 30 }, requiredCapabilities: ['treeseed.coordination.planning'], requestedPermissions: definition.activityProfiles.planning!.permissions,
		workspace: 'treedx', acceptanceCriteria: ['Controlled original work scope.'], graphRevisionCreated: 1, graphRevisionUpdated: 1 }));
	const edge = executionEdgeSchema.parse({ schemaVersion: 'treeseed.execution-edge/v1', id: 'original-precedence', teamId: 'team',
		fromNodeId: nodes[0]!.id, toNodeId: nodes[1]!.id, sourceRef: authority, provenance: 'profile-agent', graphRevisionCreated: 1 });
	const input = { teamId: 'team', revision: 2, profiles: {}, sources: [source], retainedNodes: nodes,
		retainedEdges: [edge], issuedNodeIds: nodes.map(node => node.id) };
	return { input, nodes, edge };
}

it('preserves issued planning identities and original predecessor edges without group or class reselection', () => {
	const f = originalPlanning(), before = structuredClone(f.input);
	const projected = projectActiveWorkdays(f.input);
	expect(projected.nodes).toEqual(f.nodes); expect(projected.edges).toEqual([f.edge]); expect(f.input).toEqual(before);
	expect(projectActiveWorkdays({ ...f.input, issuedNodeIds: [], retainedNodes: [] }).nodes).toEqual([]);
});

it('rejects missing or foreign issued predecessor custody instead of silently removing its original dependency', () => {
	const f = originalPlanning();
	for (const patch of [{ retainedNodes: f.nodes.slice(1), issuedNodeIds: [f.nodes[1]!.id] },
		{ retainedEdges: [{ ...f.edge, teamId: 'foreign' }] }]) {
		const input = { ...f.input, ...patch }, before = structuredClone(input);
		expect(() => projectActiveWorkdays(input)).toThrow(/predecessor custody/u); expect(input).toEqual(before);
	}
});

it('original SQL graph storage retains the exact issued nodes edges and observations through role-free replay', async () => {
	const f = await livingGraphDatabase(), supplied = originalPlanning();
	try {
		const ddl = splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0000_control_plane.sql', 'utf8'));
		for (const table of ['capacity_workday_runs', 'capacity_workday_events']) {
			const statement = ddl.find(sql => sql.startsWith(`CREATE TABLE "${table}" (`));
			if (!statement) throw new Error(`Original DDL required: ${table}`); await f.db.exec(statement);
		}
		await f.query(`INSERT INTO capacity_workday_runs (id,team_id,scenario_id,environment,parameters_json,created_at,updated_at)
			VALUES ('retained','team','controlled-history','local',?,'2026-10-19T12:00:00Z','2026-10-19T12:00:00Z')`, [JSON.stringify(supplied.input.sources[0]!.parameters)]);
		const store = { ...f.store, ensureInitialized: async () => {} };
		const initial: TeamGraph = { teamId: 'team', revision: 1, nodes: supplied.nodes, edges: [supplied.edge],
			digest: digest({ teamId: 'team', nodes: supplied.nodes, edges: [supplied.edge] }) };
		const revisionInput = (graph: TeamGraph) => graphRevisionSchema.parse({ schemaVersion: 'treeseed.graph-revision/v1', teamId: 'team',
			revision: graph.revision, ruleRevision: 1, graphDigest: graph.digest, changedSourceRefs: [supplied.nodes[0]!.sourceRef],
			changes: { added: graph.revision === 1 ? graph.nodes.map(node => node.id) : [], changed: [], completed: [], blocked: [], stale: [],
				removedEdges: [], addedEdges: graph.revision === 1 ? graph.edges.map(edge => edge.id) : [] }, createdAt: '2026-10-19T12:01:00Z' });
		await persistExecutionGraph(store, initial, emptyLivingGraph(), revisionInput(initial));
		const rows = await f.snapshot(), events = await store.all('SELECT * FROM capacity_workday_events ORDER BY id');
		const current = { ...initial, nodes: rows.nodes.map(decodeExecutionNode), edges: rows.edges.map(decodeExecutionEdge) };
		const projected = projectActiveWorkdays({ ...supplied.input, retainedNodes: current.nodes, retainedEdges: current.edges });
		const next = { teamId: 'team', revision: 2, nodes: projected.nodes, edges: projected.edges,
			digest: digest({ teamId: 'team', nodes: projected.nodes, edges: projected.edges }) };
		await persistExecutionGraph(store, next, current, revisionInput(next));
		const replay = await f.snapshot();
		expect(replay.nodes).toEqual(rows.nodes); expect(replay.edges).toEqual(rows.edges); expect(replay.assignments).toEqual([]);
		expect(await store.all('SELECT * FROM capacity_workday_events ORDER BY id')).toEqual(events);
	} finally { await f.db.close(); }
});
