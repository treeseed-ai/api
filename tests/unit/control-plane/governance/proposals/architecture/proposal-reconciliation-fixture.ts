import assert from 'node:assert/strict';
export { verifyScopedInboxQuestionGates } from '../../../knowledge/inbox/question-gate-native-contract.ts';
import { graphRevisionSchema } from '@treeseed/sdk/agent-capacity';
import type { CapacityGovernanceDatabase } from '../../../../../../src/api/capacity/database.ts';
import { reconcileExecutionGraph } from '../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-service.ts';

/** Original native SQL and reconciliation; no seeded replacement revision receipt. */
export async function verifyNativeProposalReconciliation(store: CapacityGovernanceDatabase,
	peer: CapacityGovernanceDatabase, teamId: string, projectId: string): Promise<void> {
	const tables = ['execution_nodes', 'execution_edges', 'execution_graph_revisions', 'capacity_provider_assignments',
		'capacity_reservations', 'capacity_usage_actuals', 'capacity_ledger_entries'];
	const snapshot = async (database: CapacityGovernanceDatabase): Promise<Record<string, Record<string, unknown>[]>> => Object.fromEntries(await Promise.all(tables.map(async table =>
		[table, await database.all(`SELECT * FROM ${table} ORDER BY ${table === 'execution_graph_revisions' ? 'team_id,revision' : 'id'}`)])));
	const before = await snapshot(store); assert.deepEqual(await snapshot(peer), before);
	const retained = before.execution_graph_revisions!.filter(row => row.team_id === teamId).at(-1); assert.ok(retained);
	const receipt = graphRevisionSchema.parse({ schemaVersion: 'treeseed.graph-revision/v1', teamId: retained.team_id,
		revision: retained.revision, ruleRevision: retained.rule_revision,
		changedSourceRefs: JSON.parse(String(retained.changed_source_refs_json)), graphDigest: retained.graph_digest,
		changes: JSON.parse(String(retained.changes_json)), createdAt: retained.created_at });
	const plan = await reconcileExecutionGraph(store, teamId, { projectId, plan: true });
	assert.ok('baseRevision' in plan && 'desiredDigest' in plan && 'changes' in plan);
	assert.equal(plan.teamId, teamId); assert.equal(plan.baseRevision, receipt.revision); assert.equal(plan.desiredDigest, receipt.graphDigest);
	const changes = graphRevisionSchema.shape.changes.parse(plan.changes);
	assert.deepEqual(changes, plan.changes); assert.ok(Object.values(changes).every(ids => ids.length === 0));
	for (const actual of await Promise.all([reconcileExecutionGraph(store, teamId, { projectId }),
		reconcileExecutionGraph(peer, teamId, { projectId }), reconcileExecutionGraph(store, teamId, { projectId })])) assert.deepEqual(actual, receipt);
	assert.deepEqual(await reconcileExecutionGraph(peer, teamId, { projectId }), receipt);
	assert.deepEqual(await snapshot(store), before); assert.deepEqual(await snapshot(peer), before);
}
