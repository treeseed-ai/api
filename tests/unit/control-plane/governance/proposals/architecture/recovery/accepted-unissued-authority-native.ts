import assert from 'node:assert/strict';
import { expect } from 'vitest';
import type { relationAuthoringDatabase } from '../../../../knowledge/workspaces/architecture/relation-authoring-fixture.ts';
import { createExecutionGraphService, reconcileExecutionGraph } from '../../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-service.ts';
import { createCapacityControlPlane } from '../../../../../../../src/api/capacity/control-plane.ts';
import { createWorkdayService } from '../../../../../../../src/api/control-plane/repositories/capacity/workday-service.ts';

/** Controlled closed-estimation projection input in the disposable native DB.
 * Actual accepted TreeDX Decision, reconciler, SQL and public preflight; no
 * managed workday completion, productive execution or settlement is claimed. */
export async function verifyNativeUnissuedDecisionHandoff(f: Awaited<ReturnType<typeof relationAuthoringDatabase>>,
	projectId: string, proposalId: string, decisionId: string, providerId: string) {
	const service = createExecutionGraphService(f.store), graph = await service.show(f.principal, 'team', {});
	const actor = graph.nodes.find(node => node.sourceRef.id === proposalId && node.pairRole === 'actor' && node.status === 'ready');
	assert.ok(actor); assert.ok(actor.authorityRefs?.some(ref => ref.model === 'decision' && ref.id === decisionId));
	const assignments = await f.store.all('SELECT * FROM capacity_provider_assignments ORDER BY id');
	expect(assignments.some(row => row.execution_node_id === actor.id)).toBe(false);
	const retained = { assignments, decisions: await f.store.all('SELECT * FROM governance_decisions ORDER BY id'),
		usage: await f.store.all('SELECT * FROM capacity_usage_actuals ORDER BY id'),
		ledger: await f.store.all('SELECT * FROM capacity_ledger_entries ORDER BY id') };
	const withoutDecision = actor.authorityRefs!.filter(ref => ref.model !== 'decision');
	await f.query("UPDATE execution_nodes SET workday_id=?,status='stale',authority_refs_json=? WHERE id=?",
		[`closed-estimation-${proposalId}`, JSON.stringify(withoutDecision), actor.id]);
	const stale = await service.node(f.principal, 'team', actor.id);
	expect(stale.authorityRefs).toEqual(withoutDecision);
	const preview = await reconcileExecutionGraph(f.store, 'team', { plan: true });
	assert.ok('changes' in preview); expect(preview.changes.changed).toContain(actor.id);
	expect(await service.node(f.principal, 'team', actor.id)).toEqual(stale);
	await Promise.all([reconcileExecutionGraph(f.store, 'team'), reconcileExecutionGraph(f.peerStore!, 'team')]);
	const refreshed = await service.node(f.principal, 'team', actor.id);
	expect(refreshed).toEqual({ ...stale, authorityRefs: actor.authorityRefs, nodeRevision: stale.nodeRevision + 1,
		graphRevisionUpdated: expect.any(Number) });
	const before = await service.show(f.principal, 'team', {});
	await reconcileExecutionGraph(f.store, 'team'); expect(await service.show(f.principal, 'team', {})).toEqual(before);
	expect((await service.explain(f.principal, 'team', actor.id)).admission.eligible).toBe(false);
	const intent = { schemaVersion: 'treeseed.workday-intent/v1', teamId: 'team', profileId: 'default',
		projects: [projectId], executionMode: 'simulation', startsAt: new Date().toISOString(), durationSeconds: 60,
		planningOnly: false, decisionIds: [decisionId], operatorConstraints: { providerIds: [providerId], maxConcurrency: 1 } };
	const receipt = await createWorkdayService(createCapacityControlPlane(f.store)).preflight(f.principal, 'team', intent);
	expect(receipt.selectedDemands).toEqual([expect.objectContaining({ sourceType: 'execution-node', sourceId: actor.id,
		actingAuthority: expect.objectContaining({ decisionId, executionNodeId: actor.id, executionNodeRevision: refreshed.nodeRevision + 1 }) })]);
	expect(await service.show(f.principal, 'team', {})).toEqual(before);
	expect({ assignments: await f.store.all('SELECT * FROM capacity_provider_assignments ORDER BY id'),
		decisions: await f.store.all('SELECT * FROM governance_decisions ORDER BY id'),
		usage: await f.store.all('SELECT * FROM capacity_usage_actuals ORDER BY id'),
		ledger: await f.store.all('SELECT * FROM capacity_ledger_entries ORDER BY id') }).toEqual(retained);
}
