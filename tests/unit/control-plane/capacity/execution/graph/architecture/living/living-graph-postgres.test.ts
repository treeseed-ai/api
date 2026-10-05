import { describe, expect, it } from 'vitest';
import { createExecutionGraphService, persistExecutionGraph } from '../../../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-service.ts';
import { emptyLivingGraph, graphNode, graphProjection, graphSource, graphState } from './living-graph-fixture.ts';
import { applyOperationalState } from '../../../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-state.ts';
import { postgresGraph } from './living-postgres-fixture.ts';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyDatabaseMigrations } from '../../../../../../../../src/api/support/verify-database-migrations.ts';
describe('independent PostgreSQL connection graph custody', () => {
	it('native terminal graph reconciliation publishes changed and omitted priorities through independent pools without rewriting historical authority or retrying terminal work', async () => {
		const f = await postgresGraph();
		try {
			const input = graphProjection(), initial = graphState(input);
			const actor = graphNode(initial, 'first', 'actor'), reviewer = graphNode(initial, 'first', 'reviewer');
			const terminal = new Map([[actor.id, { status: 'completed' as const, nodeRevision: actor.nodeRevision }],
				[reviewer.id, { status: 'completed' as const, nodeRevision: reviewer.nodeRevision }]]);
			let current = applyOperationalState(initial, { ...initial, nodes: input.nodes, edges: input.edges }, 1, new Set(), terminal);
			await persistExecutionGraph(f.stores[0], current, emptyLivingGraph(), { ...input.revision, graphDigest: current.digest });
			const historical = await f.snapshot(), held = structuredClone({ input, initial, terminal });
			const frozen = new Map(current.nodes.map(node => [node.id, structuredClone(node)]));
			for (const priority of [Number.MIN_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER, undefined]) {
				const projected = graphProjection(undefined, current.revision + 1);
				for (const node of projected.nodes) if (terminal.has(node.id) && priority !== undefined) node.priority = priority;
				const candidate = { ...current, nodes: projected.nodes, edges: projected.edges };
				const original = structuredClone({ current, projected });
				const next = applyOperationalState(current, candidate, projected.revision.revision, new Set(), terminal);
				for (const id of terminal.keys()) {
					const { priority: _priority, graphRevisionUpdated: _revision, ...authority } = frozen.get(id)!;
					expect(next.nodes.find(node => node.id === id)).toEqual({ ...authority, ...(priority === undefined ? {} : { priority }), graphRevisionUpdated: next.revision });
				}
				const receipt = { ...projected.revision, graphDigest: next.digest };
				await persistExecutionGraph(f.stores[1], next, current, receipt);
				for (const store of f.stores) expect(await createExecutionGraphService(store).show(f.principal, 'team', {})).toEqual(next);
				for (const database of [f.left, f.right]) for (const id of terminal.keys())
					expect((await database.pool.query('SELECT to_jsonb(priority) AS priority FROM execution_nodes WHERE id=$1', [id])).rows).toEqual([{ priority: priority ?? null }]);
				const after = await f.snapshot();
				expect(after.assignments).toEqual(historical.assignments); expect(after.reservations).toEqual(historical.reservations);
				expect(after.revisions.slice(0, historical.revisions.length)).toEqual(historical.revisions);
				expect(applyOperationalState(next, candidate, next.revision, new Set(), terminal)).toEqual(next);
				await Promise.all(f.stores.map(store => persistExecutionGraph(store, next, next, receipt)));
				expect(await f.snapshot()).toEqual(after); expect({ current, projected }).toEqual(original);
				current = next;
			}
			expect({ input, initial, terminal }).toEqual(held);
			// Terminal statuses are supplied inputs. Actual native graph publication/readback
			// is proven here, not provider execution, governance, charges or physical teardown.
		} finally { await f.close(); }
	}, 30_000);
	it('native graph publication retains canonical integer priorities through independent public reads and matching concurrent replay without changing readiness or grants', async () => {
		const f = await postgresGraph();
		try {
			const projection = graphProjection();
			const priorities = projection.nodes.map((_node, index) => index - 1);
			const input = { ...projection, nodes: projection.nodes.map((node, index) => Object.assign({}, node, { priority: priorities[index]! })) };
			const held = structuredClone(input), graph = graphState(input), receipt = { ...input.revision, graphDigest: graph.digest };
			await persistExecutionGraph(f.stores[0], graph, emptyLivingGraph(), receipt);
			const before = await f.snapshot();
			for (const store of f.stores) {
				const visible = await createExecutionGraphService(store).show(f.principal, 'team', {});
				expect(visible).toEqual(graph);
				for (const node of visible.nodes) expect(node).toEqual(graph.nodes.find(value => value.id === node.id));
			}
			for (const database of [f.left, f.right]) {
				expect((await database.pool.query('SELECT id,to_jsonb(priority) AS priority FROM execution_nodes ORDER BY id')).rows)
					.toEqual(input.nodes.map(node => ({ id: node.id, priority: node.priority })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
			}
			await Promise.all(f.stores.map(store => persistExecutionGraph(store, graph, graph, receipt)));
			expect(await f.snapshot()).toEqual(before); expect(input).toEqual(held);
			expect(before.assignments).toEqual([]); expect(before.reservations).toEqual([]);
			// Supplied canonical graph input, not a new priority field on a profile,
			// provider, assignment or Proposal; priority cannot unblock a node.
		} finally { await f.close(); }
	}, 30_000);
	it('full native migration initialization removes every named retired execution authority while original graph writes and independent read-only retries retain exact custody', async () => {
		const root = resolve('drizzle/control-plane');
		const sources = readdirSync(root).filter(name => name.endsWith('.sql')).sort().map(name => ({ name, bytes: readFileSync(resolve(root, name)) }));
		const retiredTables = ['agent_capacity_plans', 'capacity_workday_demands', 'capacity_workday_participation_cycles',
			'capacity_workday_participation_entries', 'agent_mode_runs', 'workday_capacity_envelopes', 'decision_assignment_graphs', 'capacity_allocation_sets'];
		const retiredColumns = [
			['capacity_provider_assignments', 'decision_input_json'], ['capacity_provider_assignments', 'allocation_set_id'],
			...['allowed_modes_json', 'required_capabilities_json', 'kernel_profile_json', 'kernel_policy_json', 'output_contracts_json'].map(name => ['project_agent_classes', name]),
			...['capacity_usage_actuals', 'capacity_ledger_entries', 'capacity_workday_events'].map(name => [name, 'mode_run_id']),
			...['allocation_set_id', 'allocation_version', 'allocation_slice_ids_json'].map(name => ['capacity_reservations', name]),
		];
		const f = await postgresGraph();
		try {
			const ledger = (await f.left.pool.query('SELECT * FROM treeseed_control_plane_schema_migrations ORDER BY name')).rows;
			expect(ledger.map(value => value.name)).toEqual(sources.map(value => value.name));
			const projection = graphProjection(), graph = graphState(projection), receipt = { ...projection.revision, graphDigest: graph.digest };
			await persistExecutionGraph(f.stores[0], graph, emptyLivingGraph(), receipt);
			const before = await f.snapshot();
			for (const database of [f.left, f.right]) {
				await verifyDatabaseMigrations(database.pool, root);
				const columns = (await database.pool.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,column_name")).rows;
				for (const [table, column] of retiredColumns) {
					expect(columns).not.toContainEqual({ table_name: table, column_name: column });
					await expect(database.pool.query(`SELECT "${column}" FROM "${table}" LIMIT 0`)).rejects.toMatchObject({ code: '42703' });
					expect(await f.snapshot()).toEqual(before);
				}
				for (const table of retiredTables) {
					expect((await database.pool.query('SELECT to_regclass($1) AS name', [`public.${table}`])).rows).toEqual([{ name: null }]);
					await expect(database.pool.query(`SELECT * FROM "${table}" LIMIT 0`)).rejects.toMatchObject({ code: '42P01' });
					expect(await f.snapshot()).toEqual(before);
				}
				expect((await database.pool.query('SELECT * FROM treeseed_control_plane_schema_migrations ORDER BY name')).rows).toEqual(ledger);
			}
			await persistExecutionGraph(f.stores[1], graph, graph, receipt);
			for (const store of f.stores) expect(await createExecutionGraphService(store).show(f.principal, 'team', {})).toEqual(graph);
			expect(await f.snapshot()).toEqual(before);
			for (const source of sources) expect(readFileSync(resolve(root, source.name))).toEqual(source.bytes);
		} finally { await f.close(); }
	}, 30_000);
	it('serializes conflicting graph writers across independent connection pools with exact winning nodes and edges', async () => {
		const f = await postgresGraph();
		try {
			const initial = emptyLivingGraph(), source = graphSource(), moved = graphSource(); moved.proposalRevision = 2; moved.digest = `sha256:${'d'.repeat(64)}`;
			const projections = [graphProjection([source]), graphProjection([moved])], graphs = projections.map(projection => graphState(projection));
			const outcomes = await Promise.allSettled(graphs.map((graph, index) => persistExecutionGraph(f.stores[index], graph, initial, { ...projections[index]!.revision, graphDigest: graph.digest })));
			expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(1);
			expect(outcomes.filter(value => value.status === 'rejected')).toHaveLength(1);
			const winner = graphs[outcomes.findIndex(value => value.status === 'fulfilled')]!;
			const loserIndex = outcomes.findIndex(value => value.status === 'rejected'), loser = graphs[loserIndex]!;
			for (const store of f.stores) expect(await createExecutionGraphService(store).show(f.principal, 'team', {})).toEqual(winner);
			const snapshot = await f.snapshot(); expect(snapshot.revisions).toHaveLength(1);
			expect(snapshot.nodes).toHaveLength(winner.nodes.length); expect(snapshot.edges).toHaveLength(winner.edges.length);
			expect(snapshot.assignments).toEqual([]); expect(snapshot.reservations).toEqual([]);
			await expect(persistExecutionGraph(f.stores[loserIndex], loser, initial, { ...projections[loserIndex]!.revision, graphDigest: loser.digest }))
				.rejects.toMatchObject({ status: 409, code: 'execution_graph_revision_conflict' });
			expect(await f.snapshot()).toEqual(snapshot);
			await persistExecutionGraph(f.stores[1 - loserIndex], winner, winner, { ...projections[1 - loserIndex]!.revision, graphDigest: winner.digest });
			expect(await f.snapshot()).toEqual(snapshot);
		} finally { await f.close(); }
	}, 30_000);
	it('matching concurrent graph writes have one durable revision and repeated independent reads remain unchanged', async () => {
		const f = await postgresGraph();
		try {
			const projection = graphProjection(), graph = graphState(projection), receipt = { ...projection.revision, graphDigest: graph.digest };
			await Promise.all(f.stores.map(store => persistExecutionGraph(store, graph, emptyLivingGraph(), receipt)));
			const before = await f.snapshot(); expect(before.revisions).toHaveLength(1);
			for (const store of f.stores) expect(await createExecutionGraphService(store).show(f.principal, 'team', {})).toEqual(graph);
			expect(await f.snapshot()).toEqual(before);
		} finally { await f.close(); }
	}, 30_000);
	it('late native SQL interruption rolls back all graph records before another independent writer retries exact authority', async () => {
		const f = await postgresGraph();
		try {
			const projection = graphProjection(), graph = graphState(projection), before = await f.snapshot(), receipt = { ...projection.revision, graphDigest: graph.digest };
			await f.left.pool.query("CREATE FUNCTION reject_graph_edge() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated late graph interruption'; END $$; CREATE TRIGGER reject_graph_edge BEFORE INSERT ON execution_edges FOR EACH ROW EXECUTE FUNCTION reject_graph_edge();");
			await expect(persistExecutionGraph(f.stores[0], graph, emptyLivingGraph(), receipt)).rejects.toThrow('isolated late graph interruption');
			expect(await f.snapshot()).toEqual(before);
			await f.left.pool.query('DROP TRIGGER reject_graph_edge ON execution_edges; DROP FUNCTION reject_graph_edge();');
			await persistExecutionGraph(f.stores[1], graph, emptyLivingGraph(), receipt);
			expect(await f.reader.show(f.principal, 'team', {})).toEqual(graph);
			expect((await f.snapshot()).revisions).toHaveLength(1);
		} finally { await f.close(); }
	}, 30_000);
});
