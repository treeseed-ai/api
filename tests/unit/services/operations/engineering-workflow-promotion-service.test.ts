import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataType, newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import { MarketPostgresDatabase } from '../../../../src/api/support/market-postgres.ts';
import { MarketControlPlaneStore } from '../../../../src/api/persistence/store.ts';
import { createCapacityControlPlane } from '../../../../src/api/capacity/control-plane.ts';
import { promoteEngineeringWorkflows } from '../../../../src/api/capacity/services/operations/engineering-workflow-promotion-service.ts';
import { projectCompletedAssignmentDeliverable } from '../../../../src/api/capacity/services/capacity/assignments/context/assignment-deliverable-service.ts';
import { tickCapacityWorkdayRun } from '../../../../src/api/capacity/services/capacity/workdays/scheduling/workday-tick-service.ts';

const packageRoot = process.cwd();
const migrationRoot = existsSync(resolve(packageRoot, '../sdk/drizzle/market'))
	? resolve(packageRoot, '../sdk/drizzle/market')
	: resolve(packageRoot, 'node_modules/@treeseed/sdk/drizzle/market');

function harness() {
	const memory = newDb();
	memory.public.registerFunction({ name: 'md5', args: [DataType.text], returns: DataType.text, implementation: (value: string) => `md5:${value}` });
	const pg = memory.adapters.createPg();
	const database = MarketPostgresDatabase.fromPool(new pg.Pool(), { migrationRoot });
	return { database, store: createCapacityControlPlane(new MarketControlPlaneStore({ repoRoot: packageRoot }, database)) };
}

const roles = {
	tester: 'testing', engineer: 'engineering', reviewer: 'review', technicalWriter: 'technical-writing', releaser: 'release',
};

async function seed(store: ReturnType<typeof harness>['store']) {
	const now = '2026-07-18T12:00:00.000Z';
	await store.ensureInitialized();
	await store.run(`INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES ('team-a', 'team-a', 'Team A', ?, ?)`, [now, now]);
	await store.run(`INSERT INTO projects (id, team_id, slug, name, created_at, updated_at) VALUES ('project-a', 'team-a', 'project-a', 'Project A', ?, ?)`, [now, now]);
	for (const [slug, agent] of [['testing', 'tester'], ['engineering', 'engineer'], ['review', 'reviewer'], ['technical-writing', 'technical-writer'], ['release', 'releaser']] as const) {
		await store.run(`INSERT INTO project_agent_classes (id, team_id, project_id, slug, name, status, allowed_modes_json, required_capabilities_json, kernel_profile_json, kernel_policy_json, handler_refs_json, output_contracts_json, metadata_json, created_at, updated_at) VALUES (?, 'team-a', 'project-a', ?, ?, 'active', '["planning","acting"]', '[]', '{}', '{}', ?, '{}', '{}', ?, ?)`, [`project-a:${slug}`, slug, slug, JSON.stringify({ agents: [{ slug: agent, activities: { acting: { handler: 'actor' } } }] }), now, now]);
	}
	await store.run(`INSERT INTO capacity_workday_runs (id, team_id, scenario_id, status, environment, parameters_json, summary_json, metrics_json, expected_json, actual_json, report_refs_json, error_json, started_at, created_at, updated_at) VALUES ('run-a', 'team-a', 'engineering', 'running', 'local', '{}', '{}', '{}', '{}', '{}', '{}', '{}', ?, ?, ?)`, [now, now, now]);
	await store.createWorkdayCapacityEnvelope({ id: 'workday-a', workdayRunId: 'run-a', projectId: 'project-a', status: 'active', startedAt: now, availableCredits: 20 });
	await store.upsertDecisionPlanningStatus({ projectId: 'project-a', decisionId: 'decision-a', humanApprovalState: 'approved', executionReadiness: 'blocked', planningInputsStatus: 'complete', scopeHash: 'approved-decision-scope' });
	await store.createStructuredAgentEstimate('decision-a', {
		id: 'estimate-a', projectId: 'project-a', proposalId: 'proposal-a', status: 'accepted', agentClass: 'engineering', agentId: 'engineer',
		minCredits: 1, expectedCredits: 2, maxCredits: 3, expectedOutputs: [{ outputType: 'implementation', required: true }], acceptanceCriteria: ['tests pass'],
	});
	return {
		id: 'run-a', teamId: 'team-a', capacityProviderId: null, scenarioId: 'engineering', status: 'running' as const, environment: 'local', requestedById: null,
		parameters: { projects: ['project-a'], engineeringWorkflows: [{ schemaVersion: 1, id: 'engineering-a', projectId: 'project-a', decisionId: 'decision-a', objectiveId: 'objective-a', exactBaseRef: '0123456789abcdef', roles }] },
		summary: {}, metrics: {}, expected: {}, actual: {}, reportRefs: {}, error: {}, startedAt: now, completedAt: null, createdAt: now, updatedAt: now,
	};
}

describe('engineering workflow promotion service', () => {
	it('idempotently promotes an approved decision and linked estimate into graph-scoped inputs and one accepted plan', async () => {
		const { database, store } = harness();
		try {
			const run = await seed(store);
			const first = await promoteEngineeringWorkflows(store, run);
			expect(first).toEqual([expect.objectContaining({ status: 'promoted', decisionExecutionInputIds: expect.arrayContaining([]) })]);
			expect(first[0]!.decisionExecutionInputIds).toHaveLength(6);
			const graph = await store.getDecisionAssignmentGraph(first[0]!.graphId!);
			expect(graph).toMatchObject({ active: true, status: 'ready', metadata: { workflowPromotionId: 'engineering-a', exactBaseRef: '0123456789abcdef' } });
			const inputs = await store.listDecisionExecutionInputs('decision-a', { status: 'accepted' });
			expect(inputs).toHaveLength(6);
			expect(new Set(inputs.map((entry) => entry.workGraphNodeId)).size).toBe(6);
			expect(inputs.map((entry) => entry.input.input.artifactKind)).toEqual(expect.arrayContaining([
				'failing_test_proof', 'implementation_change', 'passing_verification', 'review_decision', 'documentation_update', 'release_readiness',
			]));
			const plan = await store.getAgentCapacityPlan(first[0]!.capacityPlanId!);
			expect(plan).toMatchObject({ status: 'accepted', workDayId: 'workday-a', metadata: { workflowPromotionId: 'engineering-a' } });
			expect(plan!.workUnits).toHaveLength(6);
			expect(plan!.workUnits.every((unit) => unit.workGraphNodeId && unit.id !== unit.workGraphNodeId)).toBe(true);

			const second = await promoteEngineeringWorkflows(store, run);
			expect(second).toEqual(first);
			expect(await store.listDecisionAssignmentGraphsForDecision('decision-a')).toHaveLength(1);
			expect(await store.listDecisionExecutionInputs('decision-a', { status: 'accepted' })).toHaveLength(6);
			expect(await store.listAgentCapacityPlans('decision-a')).toHaveLength(1);
		} finally {
			await database.close();
		}
	});

	it('waits without creating acting provenance until approval and a linked accepted estimate exist', async () => {
		const { database, store } = harness();
		try {
			const run = await seed(store);
			await store.upsertDecisionPlanningStatus({ projectId: 'project-a', decisionId: 'decision-a', humanApprovalState: 'pending', executionReadiness: 'blocked', planningInputsStatus: 'complete', scopeHash: 'pending' });
			expect(await promoteEngineeringWorkflows(store, run)).toEqual([expect.objectContaining({ status: 'awaiting-approval', graphId: null })]);
			expect(await store.listDecisionAssignmentGraphsForDecision('decision-a')).toEqual([]);
		} finally {
			await database.close();
		}
	});

	it('does not promote from an accepted estimate owned by another project with the same decision slug', async () => {
		const { database, store } = harness();
		try {
			const run = await seed(store);
			const now = run.startedAt!;
			await store.run(`INSERT INTO projects (id, team_id, slug, name, created_at, updated_at) VALUES ('project-b', 'team-a', 'project-b', 'Project B', ?, ?)`, [now, now]);
			await store.run(`UPDATE structured_agent_estimates SET project_id = 'project-b' WHERE id = 'estimate-a'`);
			expect(await promoteEngineeringWorkflows(store, run)).toEqual([
				expect.objectContaining({ status: 'awaiting-estimate', graphId: null, capacityPlanId: null }),
			]);
			expect(await store.listDecisionAssignmentGraphsForDecision('decision-a')).toEqual([]);
		} finally {
			await database.close();
		}
	});

	it('converges concurrent first promotion on one graph, one input per node, and one plan', async () => {
		const { database, store } = harness();
		try {
			const run = await seed(store);
			const [left, right] = await Promise.all([
				promoteEngineeringWorkflows(store, run),
				promoteEngineeringWorkflows(store, run),
			]);
			expect(left).toEqual(right);
			expect(await store.listDecisionAssignmentGraphsForDecision('decision-a')).toHaveLength(1);
			expect(await store.listDecisionExecutionInputs('decision-a', { status: 'accepted' })).toHaveLength(6);
			expect(await store.listAgentCapacityPlans('decision-a')).toHaveLength(1);
		} finally {
			await database.close();
		}
	});

	it('keeps readiness on a newer active plan when its predecessor is superseded', async () => {
		const { database, store } = harness();
		try {
			const [promotion] = await promoteEngineeringWorkflows(store, await seed(store));
			const predecessor = await store.getAgentCapacityPlan(promotion!.capacityPlanId!);
			const replacement = await store.createAgentCapacityPlan('decision-a', {
				id: 'replacement-plan', projectId: 'project-a', workDayId: predecessor!.workDayId, allocationSetId: predecessor!.allocationSetId,
				status: 'accepted', humanApprovalState: 'approved', decisionExecutionInputIds: promotion!.decisionExecutionInputIds,
			});
			await store.updateAgentCapacityPlanStatus(promotion!.capacityPlanId!, 'superseded', { metadata: { supersededByPlanId: replacement!.id } });
			expect(await store.getDecisionPlanningStatus('decision-a')).toMatchObject({
				executionReadiness: 'ready', metadata: { latestCapacityPlanId: 'replacement-plan', latestCapacityPlanStatus: 'accepted' },
			});
		} finally {
			await database.close();
		}
	});

	it('projects a validated assignment checkpoint into its deliverable and advances the graph idempotently', async () => {
		const { database, store } = harness();
		try {
			const [promotion] = await promoteEngineeringWorkflows(store, await seed(store));
			const graph = await store.getDecisionAssignmentGraph(promotion!.graphId!);
			const testNode = graph!.nodes.find((node) => node.metadata?.stage === 'test')!;
			const assignment = {
				id: 'assignment-test-stage', teamId: 'team-a', projectId: 'project-a', projectAgentClassId: testNode.targetAgentClass,
				mode: 'acting', agentId: 'tester', decisionInput: {
					workGraphNodeId: testNode.id, input: { workGraphId: graph!.id, workGraphNodeId: testNode.id, exactBaseRef: '0123456789abcdef' },
				},
			} as never;
			const artifactManifest = {
				schemaVersion: 1, assignmentId: 'assignment-test-stage', modeRunId: 'mode-run-test', teamId: 'team-a', projectId: 'project-a',
				providerId: 'provider-a', mode: 'acting', agentClassId: testNode.targetAgentClass, agentId: 'tester', handlerId: 'actor', activityType: 'acting',
				status: 'completed', summary: 'Created and proved the failing regression test.', toolEvents: [],
				contentReferences: [{ model: 'note', contentPath: 'notes/engineering/failing-test.mdx', receiptId: 'receipt-1', toolEventId: 'tool-1', subjectId: 'decision-a', subjectField: 'relatedDecisions', artifactKind: 'failing_test_proof' }],
				sourceWorktree: { branch: 'agent/tester/assignment-test-stage', baseRef: '0123456789abcdef', changedPaths: ['tests/release-channel.test.ts'] },
				commit: { sha: 'abcdef0123456789', ref: 'agent/tester/assignment-test-stage' }, verification: [{ status: 'failed', summary: 'Expected regression failure.' }],
				citations: [], signals: [], usage: [], diagnostics: [], createdAt: '2026-07-18T00:00:00.000Z',
			};
			await expect(Promise.all([
				projectCompletedAssignmentDeliverable(store, assignment, { output: { artifactManifest } }),
				projectCompletedAssignmentDeliverable(store, assignment, { output: { artifactManifest } }),
			])).resolves.toEqual([expect.objectContaining({ status: 'approved' }), expect.objectContaining({ status: 'approved' })]);
			await expect(projectCompletedAssignmentDeliverable(store, assignment, { output: { artifactManifest } })).resolves.toMatchObject({ status: 'approved' });
			const advanced = await store.getDecisionAssignmentGraph(graph!.id);
			expect(advanced!.nodes.find((node) => node.id === testNode.id)?.status).toBe('completed');
			expect(advanced!.nodes.find((node) => node.metadata?.stage === 'implementation')?.status).toBe('ready');
			const contractId = String(testNode.metadata?.producesDeliverableContractId);
			expect(await store.getDeliverableContract(contractId)).toMatchObject({ metadata: { deliverableManifestId: 'deliverable:assignment-test-stage' } });
			const manifest = await store.first(`SELECT manifest_json FROM deliverable_manifests WHERE id = 'deliverable:assignment-test-stage'`);
			expect(JSON.parse(String(manifest?.manifest_json))).toMatchObject({
				sourceAuthority: { assignmentId: 'assignment-test-stage', modeRunId: 'mode-run-test', baseRef: '0123456789abcdef', effectiveRef: 'abcdef0123456789', checkpointCommit: 'abcdef0123456789' },
			});
		} finally {
			await database.close();
		}
	});

	it('promotes through an idempotent workday tick before compiling the ready acting demand', async () => {
		const { database, store } = harness();
		try {
			const run = await seed(store);
			const now = run.startedAt!;
			await store.run(`INSERT INTO capacity_providers (id, fingerprint, public_jwk_json, display_name, identity_version, status, metadata_json, created_at, updated_at) VALUES ('provider-a', 'sha256:provider-a', '{}', 'Provider A', 1, 'active', '{}', ?, ?)`, [now, now]);
			await store.run(`INSERT INTO capacity_provider_team_memberships (id, team_id, capacity_provider_id, status, approved_at, approved_by_id, metadata_json, created_at, updated_at) VALUES ('membership-a', 'team-a', 'provider-a', 'approved', ?, 'owner', '{}', ?, ?)`, [now, now, now]);
			await store.run(`UPDATE capacity_workday_runs SET capacity_provider_id = 'provider-a', parameters_json = ? WHERE id = 'run-a'`, [JSON.stringify(run.parameters)]);
			const first = await tickCapacityWorkdayRun(store, 'team-a', 'run-a', now, 'engineering-tick-a');
			const replay = await tickCapacityWorkdayRun(store, 'team-a', 'run-a', '2026-07-18T12:01:00.000Z', 'engineering-tick-a');
			expect(first.engineeringWorkflowPromotions).toEqual([expect.objectContaining({ status: 'promoted' })]);
			expect(replay).toEqual(first);
			expect(await store.all(`SELECT mode, status, source_type FROM capacity_workday_demands WHERE source_type = 'capacity-plan'`)).toEqual([
				{ mode: 'acting', status: 'pending', source_type: 'capacity-plan' },
			]);
		} finally {
			await database.close();
		}
	});
});
