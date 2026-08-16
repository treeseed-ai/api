import { Hono } from 'hono';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataType,newDb } from 'pg-mem';
import { describe,expect,it } from 'vitest';
import { createCapacityControlPlane } from '../../../../../src/api/capacity/control-plane.ts';
import { serializeDecisionAssignmentGraphRow } from '../../../../../src/api/capacity/repositories/treedx/graph/decision-work-graph.ts';
import { installDecisionWorkGraphRoutes } from '../../../../../src/api/capacity/routes/treedx/graph/decision-work-graphs.ts';
import { MarketControlPlaneStore } from '../../../../../src/api/persistence/store.ts';
import { MarketPostgresDatabase } from '../../../../../src/api/support/market-postgres.ts';

const packageRoot = process.cwd();
const migrationRoot = existsSync(resolve(packageRoot, '../sdk/drizzle/market')) ? resolve(packageRoot, '../sdk/drizzle/market') : resolve(packageRoot, 'node_modules/@treeseed/sdk/drizzle/market');
function harness() {
	const memory = newDb();
	memory.public.registerFunction({ name: "replace", args: [DataType.text, DataType.text, DataType.text], returns: DataType.text, implementation: (value: string, search: string, replacement: string) => value.split(search).join(replacement) });
	memory.public.registerFunction({ name: 'md5', args: [DataType.text], returns: DataType.text, implementation: (value: string) => `md5:${value}` });
	const pg = memory.adapters.createPg();
	const database = MarketPostgresDatabase.fromPool(new pg.Pool(), { migrationRoot });
	return { database, store: createCapacityControlPlane(new MarketControlPlaneStore({ repoRoot: packageRoot }, database)) };
}
async function seed(store: ReturnType<typeof harness>['store']) {
	const now = new Date().toISOString();
	await store.ensureInitialized();
	await store.run(`INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES ('team-a', 'team-a', 'Team A', ?, ?)`, [now, now]);
	await store.run(`INSERT INTO projects (id, team_id, slug, name, created_at, updated_at) VALUES ('project-a', 'team-a', 'project-a', 'Project A', ?, ?)`, [now, now]);
	await seedAcceptedDecision(store, { decisionId: 'decision-a', projectId: 'project-a', proposalId: 'proposal-a', now });
}
async function seedAcceptedDecision(store: ReturnType<typeof harness>['store'], input: { decisionId: string; projectId: string; proposalId: string; now?: string; dependencies?: unknown[] }) {
	const now = input.now ?? new Date().toISOString();
	const hash = `hash:${input.proposalId}`;
	await store.run(`INSERT INTO governance_proposals (id, team_id, project_id, scope, status, title, summary, body, proposal_type, proposal_types_json, active_version, active_content_hash, governance_provider_id, governance_provider_version, metadata_json, created_at, updated_at)
		VALUES (?, 'team-a', ?, 'project', 'accepted', ?, 'Accepted proposal summary', 'Accepted proposal body', 'implementation', '["implementation"]', 1, ?, 'admin_approval_v1', '1', '{}', ?, ?)`, [input.proposalId, input.projectId, input.proposalId, hash, now, now]);
	await store.run(`INSERT INTO governance_decisions (id, team_id, project_id, proposal_id, proposal_version, proposal_content_hash, status, title, summary, governance_provider_id, governance_rule_json, vote_result_json, voter_reasons_json, proposal_snapshot_json, decision_record_json, created_by_type, created_at, updated_at)
		VALUES (?, 'team-a', ?, ?, 1, ?, 'accepted', ?, 'Accepted decision summary', 'admin_approval_v1', '{}', '{}', '[]', '{}', ?, 'system', ?, ?)`, [input.decisionId, input.projectId, input.proposalId, hash, input.decisionId, JSON.stringify({ decisionDependencies: input.dependencies ?? [] }), now, now]);
}
async function acceptedEstimate(store: ReturnType<typeof harness>['store'], id = 'estimate-a') {
	return store.createStructuredAgentEstimate('decision-a', {
		id, projectId: 'project-a', status: 'accepted', agentClass: 'engineer', minSeconds: 1, expectedSeconds: 2, maxSeconds: 3,
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

	it('keeps assignments project-local while snapshotting accepted cross-project decisions', async () => {
		const { database, store } = harness();
		try {
			await seed(store);
			const now = new Date().toISOString();
			await store.run(`INSERT INTO projects (id, team_id, slug, name, created_at, updated_at) VALUES ('project-b', 'team-a', 'project-b', 'Project B', ?, ?)`, [now, now]);
			await seedAcceptedDecision(store, { decisionId: 'decision-b', projectId: 'project-b', proposalId: 'proposal-b', now });
			const dependency = { teamId: 'team-a', projectId: 'project-b', decisionId: 'decision-b', proposalId: 'proposal-b', proposalVersion: 1, proposalContentHash: 'hash:proposal-b' };
			await store.run(`UPDATE governance_decisions SET decision_record_json = ? WHERE id = 'decision-a'`, [JSON.stringify({ decisionDependencies: [dependency] })]);
			const graph = await store.createDecisionAssignmentGraph('decision-a', {
				projectId: 'project-a', workflowKind: 'engineering-test-first', exactBaseRef: '0123456789abcdef',
				roles: { tester: 'tester', engineer: 'engineer', reviewer: 'reviewer', technicalWriter: 'writer', releaser: 'releaser' },
				metadata: { decisionDependencies: [{ projectId: 'attacker', decisionId: 'forged' }], proposalVersion: 99 },
			});
			expect(graph!.metadata).toMatchObject({ proposalId: 'proposal-a', proposalVersion: 1, proposalContentHash: 'hash:proposal-a', decisionDependencies: [dependency] });
			expect(graph!.projectId).toBe('project-a');
			expect(graph!.nodes.every((node) => node.projectId === 'project-a')).toBe(true);
			expect(graph!.deliverableContracts.every((contract) => contract.projectId === 'project-a')).toBe(true);
			await expect(store.createDecisionAssignmentGraph('decision-b', {
				projectId: 'project-a', workflowKind: 'engineering-test-first', exactBaseRef: '0123456789abcdef',
				roles: { tester: 'tester', engineer: 'engineer', reviewer: 'reviewer', technicalWriter: 'writer', releaser: 'releaser' },
			})).rejects.toMatchObject({ code: 'governance_decision_project_mismatch' });
		} finally { await database.close(); }
	});

	it('rejects graph compilation when a dependency decision snapshot becomes stale', async () => {
		const { database, store } = harness();
		try {
			await seed(store);
			const now = new Date().toISOString();
			await store.run(`INSERT INTO projects (id, team_id, slug, name, created_at, updated_at) VALUES ('project-b', 'team-a', 'project-b', 'Project B', ?, ?)`, [now, now]);
			await seedAcceptedDecision(store, { decisionId: 'decision-b', projectId: 'project-b', proposalId: 'proposal-b', now });
			await store.run(`UPDATE governance_decisions SET decision_record_json = ? WHERE id = 'decision-a'`, [JSON.stringify({ decisionDependencies: [{ teamId: 'team-a', projectId: 'project-b', decisionId: 'decision-b', proposalId: 'proposal-b', proposalVersion: 1, proposalContentHash: 'hash:proposal-b' }] })]);
			await store.run(`UPDATE governance_proposals SET active_content_hash = 'changed' WHERE id = 'proposal-b'`);
			await expect(store.createDecisionAssignmentGraph('decision-a', {
				projectId: 'project-a', workflowKind: 'engineering-test-first', exactBaseRef: '0123456789abcdef',
				roles: { tester: 'tester', engineer: 'engineer', reviewer: 'reviewer', technicalWriter: 'writer', releaser: 'releaser' },
			})).rejects.toMatchObject({ code: 'governance_decision_proposal_stale' });
		} finally { await database.close(); }
	});

	it('revalidates execution authority receipts through the authenticated control-plane route', async () => {
		const { database, store } = harness();
		try {
			await seed(store);
			const app = new Hono();
			installDecisionWorkGraphRoutes(app, { store, async requireProjectAccess() { return {}; } });
			const authority = { authorityId: 'authority-a', teamId: 'team-a', projectId: 'project-a', decisionId: 'decision-a', proposalId: 'proposal-a', proposalVersion: 1, proposalContentHash: 'hash:proposal-a', decisionDependencies: [] };
			const valid = await (await app.request('/v1/governance/execution-authorities/validate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authorities: [authority] }) })).json() as any;
			expect(valid).toMatchObject({ ok: true, payload: [{ authorityId: 'authority-a', valid: true, code: null }] });
			await store.run(`UPDATE governance_decisions SET status = 'superseded', superseded_at = ? WHERE id = 'decision-a'`, [new Date().toISOString()]);
			const stale = await (await app.request('/v1/governance/execution-authorities/validate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authorities: [authority] }) })).json() as any;
			expect(stale).toMatchObject({ ok: true, payload: [{ authorityId: 'authority-a', valid: false, code: 'governance_decision_not_accepted' }] });
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
			const app = new Hono();
			installDecisionWorkGraphRoutes(app, { store, async requireProjectAccess(c) { return c.req.header('x-deny') === 'true' ? { response: c.json({ ok: false }, 403) } : {}; } });
			expect(await (await app.request('/v1/deliverable-manifests/manifest-a')).json()).toMatchObject({ ok: true, payload: { id: 'manifest-a', projectId: 'project-a' } });
			expect((await app.request('/v1/deliverable-manifests/manifest-a', { headers: { 'x-deny': 'true' } })).status).toBe(403);
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
