import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataType, newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { MarketPostgresDatabase } from '../../src/api/market-postgres.ts';
import { MarketControlPlaneStore } from '../../src/api/store.ts';
import { createCapacityControlPlane } from '../../src/api/capacity/control-plane.ts';
import { installDecisionWorkGraphRoutes } from '../../src/api/capacity/routes/decision-work-graphs.ts';
import { serializeDecisionAssignmentGraphRow } from '../../src/api/capacity/repositories/decision-work-graph.ts';

const packageRoot = process.cwd();
const migrationRoot = existsSync(resolve(packageRoot, '../sdk/drizzle/market')) ? resolve(packageRoot, '../sdk/drizzle/market') : resolve(packageRoot, 'node_modules/@treeseed/sdk/drizzle/market');
function harness() {
	const memory = newDb();
	memory.public.registerFunction({ name: 'md5', args: [DataType.text], returns: DataType.text, implementation: (value: string) => `md5:${value}` });
	const pg = memory.adapters.createPg();
	const database = MarketPostgresDatabase.fromPool(new pg.Pool(), { migrationRoot });
	return { database, store: createCapacityControlPlane(new MarketControlPlaneStore({ repoRoot: packageRoot }, database)) };
}
async function seed(store: MarketControlPlaneStore) {
	const now = new Date().toISOString();
	await store.ensureInitialized();
	await store.run(`INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES ('team-a', 'team-a', 'Team A', ?, ?)`, [now, now]);
	await store.run(`INSERT INTO projects (id, team_id, slug, name, created_at, updated_at) VALUES ('project-a', 'team-a', 'project-a', 'Project A', ?, ?)`, [now, now]);
}
async function acceptedEstimate(store: MarketControlPlaneStore, id = 'estimate-a') {
	return store.createStructuredAgentEstimate('decision-a', {
		id, projectId: 'project-a', status: 'accepted', agentClass: 'engineer', minCredits: 1, expectedCredits: 2, maxCredits: 3,
		dependencies: [{ id: 'test-proof', type: 'artifact', requiredBefore: 'start', deliverableType: 'test-proof', agentClass: 'tester', summary: 'A failing regression test' }],
		expectedOutputs: [{ outputType: 'implementation', required: true }], acceptanceCriteria: ['tests pass'],
	});
}

describe('decision work graph service', () => {
	it('atomically creates a versioned graph and graph-owned deliverable contract', async () => {
		const { database, store } = harness();
		try {
			await seed(store); await acceptedEstimate(store);
			const graph = await store.createDecisionAssignmentGraph('decision-a', { projectId: 'project-a' });
			expect(graph).toMatchObject({ version: 1, status: 'compiled', active: false, estimateIds: ['estimate-a'] });
			const contractId = graph!.deliverableContracts[0]!.id;
			expect(contractId).toMatch(/:v1$/);
			expect(await store.getDeliverableContract(contractId)).toMatchObject({ id: contractId, status: 'required', projectId: 'project-a' });
		} finally { await database.close(); }
	});

	it('creates the canonical engineering test-first graph without synthetic estimates', async () => {
		const { database, store } = harness();
		try {
			await seed(store);
			const graph = await store.createDecisionAssignmentGraph('decision-a', {
				projectId: 'project-a', workflowKind: 'engineering-test-first', exactBaseRef: '0123456789abcdef',
				roles: { tester: 'tester', engineer: 'engineer', reviewer: 'reviewer', technicalWriter: 'technical-writer', releaser: 'releaser' },
			});
			expect(graph).toMatchObject({ version: 1, status: 'compiled', active: false, estimateIds: [], metadata: { workflowKind: 'engineering-test-first', exactBaseRef: '0123456789abcdef' } });
			expect(graph!.nodes.map((node) => node.metadata?.stage)).toEqual(['test', 'implementation', 'verification', 'review', 'documentation', 'release']);
			expect(graph!.nodes[1]).toMatchObject({ targetAgentClass: 'engineer', requiredDeliverableContractIds: [graph!.deliverableContracts[0]!.id], metadata: { testMutationForbidden: true } });
			expect(graph!.nodes[0]).toMatchObject({ status: 'ready', metadata: { implementationMutationForbidden: true } });
			expect(graph!.deliverableContracts.every((contract) => contract.id.endsWith(':v1'))).toBe(true);
		} finally { await database.close(); }
	});

	it('rejects incomplete engineering graph provenance and role configuration', async () => {
		const { database, store } = harness();
		try {
			await seed(store);
			const roles = { tester: 'tester', engineer: 'engineer', reviewer: 'reviewer', technicalWriter: 'technical-writer', releaser: 'releaser' };
			await expect(store.createDecisionAssignmentGraph('decision-a', { projectId: 'project-a', workflowKind: 'engineering-test-first', roles })).rejects.toMatchObject({ code: 'decision_assignment_graph_invalid' });
			await expect(store.createDecisionAssignmentGraph('decision-a', { projectId: 'project-a', workflowKind: 'engineering-test-first', exactBaseRef: 'abc', roles: { ...roles, tester: '' } })).rejects.toMatchObject({ code: 'engineering_assignment_graph_roles_required' });
		} finally { await database.close(); }
	});

	it('advances approved stages and creates durable revision work after review rejection', async () => {
		const { database, store } = harness();
		try {
			await seed(store);
			const graph = await store.createDecisionAssignmentGraph('decision-a', {
				projectId: 'project-a', workflowKind: 'engineering-test-first', exactBaseRef: 'abc123',
				roles: { tester: 'tester', engineer: 'engineer', reviewer: 'reviewer', technicalWriter: 'writer', releaser: 'releaser' },
			});
			await store.activateDecisionAssignmentGraphVersion(graph!.id);
			for (const deliverableType of ['failing_test_proof', 'implementation_change', 'passing_verification']) {
				const current = await store.getDecisionAssignmentGraph(graph!.id);
				const contract = current!.deliverableContracts.find((entry) => entry.deliverableType === deliverableType)!;
				await store.submitDeliverableManifest(contract.id, { producedRefs: [{ model: 'note', collection: 'notes', slug: deliverableType }], summary: `${deliverableType} complete`, readyForReview: true });
				await store.markDeliverableContractApproved(contract.id, { approvedBy: 'reviewer-a' });
			}
			let current = await store.getDecisionAssignmentGraph(graph!.id);
			expect(current!.nodes.find((node) => node.metadata?.stage === 'review')).toMatchObject({ status: 'ready' });
			const reviewContract = current!.deliverableContracts.find((entry) => entry.deliverableType === 'review_decision')!;
			await store.submitDeliverableManifest(reviewContract.id, { producedRefs: [{ model: 'note', collection: 'notes', slug: 'review' }], summary: 'Changes requested', readyForReview: true });
			await store.markDeliverableContractRejected(reviewContract.id, { reason: 'Handle the empty input edge case.' });

			current = await store.getDecisionAssignmentGraph(graph!.id);
			const revisions = current!.nodes.filter((node) => node.metadata?.revisionCycle === 1);
			expect(revisions.map((node) => [node.metadata?.stage, node.status])).toEqual([
				['implementation', 'ready'], ['verification', 'pending'], ['review', 'pending'],
			]);
			expect(await store.getDeliverableContract(String(revisions[0]!.metadata?.producesDeliverableContractId))).toMatchObject({ status: 'required', metadata: { graphId: graph!.id, revisionCycle: 1 } });
			expect(current!.nodes.find((node) => node.metadata?.stage === 'documentation')!.requiredDeliverableContractIds).toEqual([
				revisions[2]!.metadata?.producesDeliverableContractId,
			]);
		} finally { await database.close(); }
	});

	it('activates exactly one graph with planning readiness in the same batch', async () => {
		const { database, store } = harness();
		try {
			await seed(store); await acceptedEstimate(store);
			const first = await store.createDecisionAssignmentGraph('decision-a', { projectId: 'project-a' });
			await store.activateDecisionAssignmentGraphVersion(first!.id);
			const second = await store.createDecisionAssignmentGraph('decision-a', { projectId: 'project-a' });
			await store.activateDecisionAssignmentGraphVersion(second!.id);
			expect(await store.listDecisionAssignmentGraphsForDecision('decision-a', { active: true })).toEqual([expect.objectContaining({ id: second!.id, version: 2, status: 'ready' })]);
			expect(await store.getDecisionAssignmentGraph(first!.id)).toMatchObject({ active: false });
			expect(await store.getDecisionPlanningStatus('decision-a')).toMatchObject({ executionReadiness: 'ready', metadata: { activeGraphId: second!.id, activeGraphVersion: 2 } });
		} finally { await database.close(); }
	});

	it('submits and reviews one manifest through guarded contract transitions', async () => {
		const { database, store } = harness();
		try {
			await seed(store); await acceptedEstimate(store);
			const graph = await store.createDecisionAssignmentGraph('decision-a', { projectId: 'project-a' });
			await store.activateDecisionAssignmentGraphVersion(graph!.id);
			const contractId = graph!.deliverableContracts[0]!.id;
			const manifest = await store.submitDeliverableManifest(contractId, { id: 'manifest-a', producedRefs: [{ model: 'note', collection: 'notes', slug: 'test-proof' }], summary: 'Regression proof', readyForReview: true });
			expect(manifest).toMatchObject({ id: 'manifest-a', readyForReview: true });
			expect(await store.getDeliverableContract(contractId)).toMatchObject({ status: 'submitted' });
			expect(await store.markDeliverableContractApproved(contractId, { approvedBy: 'reviewer-a' })).toMatchObject({ status: 'approved' });
			await expect(store.markDeliverableContractRejected(contractId, {})).rejects.toMatchObject({ code: 'deliverable_contract_transition_conflict' });
		} finally { await database.close(); }
	});

	it('denies empty compilation, corrupt durable graphs, and unauthorized route mutation', async () => {
		const { database, store } = harness();
		try {
			await seed(store);
			await expect(store.createDecisionAssignmentGraph('decision-a', { projectId: 'project-a' })).rejects.toMatchObject({ code: 'decision_assignment_graph_estimates_required' });
			expect(() => serializeDecisionAssignmentGraphRow({ id: 'bad', graph_json: '{}', metadata_json: '{}', team_id: 'team-a', project_id: 'project-a', decision_id: 'decision-a', version: 1, status: 'compiled', active: 2, compiled_at: null, created_at: 'now', updated_at: 'now' })).toThrowError(/active/);
			await acceptedEstimate(store);
			const app = new Hono();
			installDecisionWorkGraphRoutes(app, { store, async requireProjectAccess(c) { return c.req.header('x-deny') === 'true' ? { response: c.json({ ok: false }, 403) } : {}; } });
			const denied = await app.request('/v1/decisions/decision-a/assignment-graphs/compile', { method: 'POST', headers: { 'content-type': 'application/json', 'x-deny': 'true' }, body: JSON.stringify({ projectId: 'project-a' }) });
			expect(denied.status).toBe(403);
			expect(await store.listDecisionAssignmentGraphsForDecision('decision-a')).toHaveLength(0);
		} finally { await database.close(); }
	});
});
