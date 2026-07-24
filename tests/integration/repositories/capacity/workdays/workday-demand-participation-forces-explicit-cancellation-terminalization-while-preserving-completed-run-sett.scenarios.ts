import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataType, newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import { MarketPostgresDatabase } from '../../../../../src/api/support/market-postgres.ts';
import { MarketControlPlaneStore } from '../../../../../src/api/persistence/store.ts';
import { CapacityWorkdayDemandRepository } from '../../../../../src/api/capacity/repositories/capacity/workdays/workday-demand.ts';
import { CapacityWorkdayParticipationRepository } from '../../../../../src/api/capacity/repositories/capacity/workdays/workday-participation.ts';
import { createCapacityControlPlane } from '../../../../../src/api/capacity/control-plane.ts';
import { compileProviderWorkdayDemand } from '../../../../../src/api/capacity/services/build/demand-compiler.ts';
import { OperatorAssignmentService } from '../../../../../src/api/capacity/services/capacity/assignments/observability/operator-assignment-service.ts';
import { tickCapacityWorkdayRun } from '../../../../../src/api/capacity/services/capacity/workdays/scheduling/workday-tick-service.ts';
import { listTreeDxPlanningDemandSources } from '../../../../../src/api/capacity/services/capacity/workdays/content/workday-content-demand-source.ts';
import { assignNextCompiledDemand, resolveAssignmentContentBaseRef } from '../../../../../src/api/capacity/services/capacity/assignments/planning/assignment-function.ts';
import { evaluateProviderAssignmentLeaseAuthority } from '../../../../../src/api/capacity/services/accounts/lease-authority-service.ts';
import { listActingDemandSources } from '../../../../../src/api/capacity/services/support/acting-demand-source.ts';
import { resolveEngineeringNodeAuthority } from '../../../../../src/api/capacity/services/accounts/engineering-source-authority.ts';
import { CapacityAllocationService } from '../../../../../src/api/capacity/services/capacity/allocations/allocation-service.ts';
import { CapacityGrantService } from '../../../../../src/api/capacity/services/capacity/allocations/grant-service.ts';
import { evaluateDurableWorkdayContinuation } from '../../../../../src/api/capacity/services/capacity/workdays/lifecycle/workday-continuation-service.ts';
import { workdayTerminalizationPreserveUntil } from '../../../../../src/api/capacity/services/capacity/workdays/scheduling/workday-run-service.ts';
import { settleCapacityReservationExactlyOnce } from '../../../../../src/api/capacity/services/capacity/accounting/settlement-service.ts';
import { ProviderAssignmentLifecycleService } from '../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-lifecycle-service.ts';
import type { CapacityWorkdayRunRecord } from '@treeseed/sdk/agent-capacity';
const packageRoot = process.cwd();
const migrationRoot = existsSync(resolve(packageRoot, '../sdk/drizzle/market'))
    ? resolve(packageRoot, '../sdk/drizzle/market')
    : resolve(packageRoot, 'node_modules/@treeseed/sdk/drizzle/market');
function workdayRun(input: Partial<CapacityWorkdayRunRecord> = {}): CapacityWorkdayRunRecord {
    const now = '2026-07-18T12:00:00.000Z';
    return {
        id: 'run-a', teamId: 'team-a', scenarioId: 'acting', status: 'running', environment: 'local',
        capacityProviderId: 'provider-a', requestedById: null, parameters: {}, summary: {}, metrics: {},
        expected: {}, actual: {}, reportRefs: {}, error: {}, startedAt: now, completedAt: null,
        createdAt: now, updatedAt: now, ...input,
    };
}
function harness() {
    const memory = newDb();
    memory.public.registerFunction({ name: 'md5', args: [DataType.text], returns: DataType.text, implementation: (value: string) => `md5:${value}` });
    const pg = memory.adapters.createPg();
    const database = MarketPostgresDatabase.fromPool(new pg.Pool(), { migrationRoot });
    const store = new MarketControlPlaneStore({
        repoRoot: packageRoot, authSecret: 'demand-test-auth-secret', assertionSecret: 'demand-test-assertion-secret',
        serviceId: 'web', serviceSecret: 'demand-test-service-secret',
    }, database);
    return { database, store };
}
async function seed(database: MarketControlPlaneStore) {
    const now = '2026-07-18T12:00:00.000Z';
    await database.ensureInitialized();
    await database.run(`INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES ('team-a', 'team-a', 'Team A', ?, ?)`, [now, now]);
    await database.run(`INSERT INTO projects (id, team_id, slug, name, created_at, updated_at) VALUES ('project-a', 'team-a', 'project-a', 'Project A', ?, ?)`, [now, now]);
    await database.run(`INSERT INTO project_agent_classes (id, team_id, project_id, slug, name, allowed_modes_json, handler_refs_json, created_at, updated_at) VALUES ('class-a', 'team-a', 'project-a', 'planner', 'Planner', '["planning"]', ?, ?, ?)`, [JSON.stringify({ agents: [{ slug: 'architect', activities: { planning: { handler: 'writer', purpose: 'Plan the project architecture.', planningPriority: 1 } } }] }), now, now]);
    await database.run(`INSERT INTO capacity_workday_runs (id, team_id, capacity_provider_id, scenario_id, status, environment, parameters_json, started_at, created_at, updated_at) VALUES ('run-a', 'team-a', 'provider-a', 'real planning', 'running', 'local', '{"projects":["project-a"]}', ?, ?, ?)`, [now, now, now]);
    await database.run(`INSERT INTO workday_capacity_envelopes (id, team_id, project_id, workday_run_id, status, envelope_json, metadata_json, started_at, created_at, updated_at) VALUES ('workday-a', 'team-a', 'project-a', 'run-a', 'active', '{"availableCredits":10}', '{}', ?, ?, ?)`, [now, now, now]);
    return now;
}
async function seedAdmittedAssignment(database: MarketControlPlaneStore, status: 'pending' | 'leased' | 'failed' = 'pending') {
    const now = await seed(database);
    const leased = status === 'leased';
    await database.run(`INSERT INTO capacity_providers (id, fingerprint, public_jwk_json, display_name, identity_version, status, metadata_json, created_at, updated_at) VALUES ('provider-a', 'sha256:provider-a', '{}', 'Provider A', 1, 'active', '{}', ?, ?)`, [now, now]);
    await database.run(`INSERT INTO capacity_provider_team_memberships (id, team_id, capacity_provider_id, status, approved_at, approved_by_id, metadata_json, created_at, updated_at) VALUES ('membership-a', 'team-a', 'provider-a', 'approved', ?, 'owner', '{}', ?, ?)`, [now, now, now]);
    await database.run(`INSERT INTO capacity_allocation_sets (id, team_id, version, status, effective_from, reserve_policy_json, slices_json, borrowing_rules_json, metadata_json, created_at, updated_at) VALUES ('allocation-a', 'team-a', 1, 'active', ?, '{}', '[]', '[]', '{}', ?, ?)`, [now, now, now]);
    await database.run(`INSERT INTO capacity_grants (id, membership_id, capacity_provider_id, team_id, project_id, environment, status, capabilities_json, allowed_modes_json, daily_credit_limit, metadata_json, created_at, updated_at) VALUES ('grant-a', 'membership-a', 'provider-a', 'team-a', 'project-a', 'local', 'active', '[]', '["planning"]', 10, '{}', ?, ?)`, [now, now]);
    await database.run(`INSERT INTO capacity_reservations (id, idempotency_key, admission_token, membership_id, grant_id, capacity_provider_id, allocation_set_id, allocation_version, project_agent_class_id, assignment_id, mode, team_id, project_id, work_day_id, state, reserved_credits, created_at, updated_at) VALUES ('reservation-a', 'reservation-a', 'token-a', 'membership-a', 'grant-a', 'provider-a', 'allocation-a', 1, 'class-a', 'assignment-a', 'planning', 'team-a', 'project-a', 'workday-a', 'reserved', 1, ?, ?)`, [now, now]);
    await database.run(`INSERT INTO capacity_provider_assignments (id, membership_id, team_id, project_id, capacity_provider_id, project_agent_class_id, reservation_id, work_day_id, mode, status, lease_state, lease_token, lease_expires_at, state_version, capacity_envelope_json, decision_input_json, synthesized_from, created_at, updated_at) VALUES ('assignment-a', 'membership-a', 'team-a', 'project-a', 'provider-a', 'class-a', 'reservation-a', 'workday-a', 'planning', ?, ?, ?, ?, 2, '{"teamId":"team-a","projectId":"project-a","mode":"planning"}', '{"teamId":"team-a","projectId":"project-a","projectAgentClassId":"class-a","mode":"planning","input":{}}', 'workday_demand', ?, ?)`, [status, leased ? 'leased' : 'unleased', leased ? 'lease-a' : null, leased ? '2099-01-01T00:00:00.000Z' : null, now, now]);
    await database.run(`INSERT INTO capacity_workday_demands (id, team_id, project_id, workday_run_id, workday_id, source_type, source_id, mode, project_agent_class_id, agent_id, handler_id, activity_type, status, priority, requested_credits, idempotency_key, claim_token, assignment_id, payload_json, metadata_json, available_at, claimed_at, admitted_at, created_at, updated_at) VALUES ('demand-a', 'team-a', 'project-a', 'run-a', 'workday-a', 'idle-intent', 'architect', 'planning', 'class-a', 'architect', 'writer', 'planning', 'admitted', 1, 1, 'demand-a', 'claim-a', 'assignment-a', '{"repositoryId":"treeseed-project-a","contentRoot":"src/content","intent":{"objective":"Recover the admitted work."}}', '{"environment":"local"}', ?, ?, ?, ?, ?)`, [now, now, now, now, now]);
    return now;
}

describe('durable workday demand and participation', () => {
it('forces explicit cancellation terminalization while preserving completed-run settlement grace', () => {
    const now = '2026-07-18T12:00:00.000Z';
    expect(workdayTerminalizationPreserveUntil('cancelled', {}, now)).toBe(now);
    expect(workdayTerminalizationPreserveUntil('failed', {}, now)).toBe(now);
    expect(workdayTerminalizationPreserveUntil('completed', {}, now)).toBe('2026-07-18T12:05:00.000Z');
});

it('bases a content handoff workspace on the exact upstream artifact commit', () => {
    expect(resolveAssignmentContentBaseRef({
        contentBaseRef: 'refs/heads/main',
        intent: {
            relatedArtifact: {
                contentPath: 'src/content/proposals/release-channel.mdx',
                commitSha: '893c6d70a2b7ac0de4f0a8a90a47138df7ee1f00',
            },
        },
    })).toBe('893c6d70a2b7ac0de4f0a8a90a47138df7ee1f00');
    expect(resolveAssignmentContentBaseRef({ contentBaseRef: 'refs/heads/reviewed' }))
        .toBe('refs/heads/reviewed');
});

it('derives deterministic open objectives, questions, proposals, decisions, and knowledge gaps through TreeDX', async () => {
    const requests: Array<{
        authorization: string | null;
        body: Record<string, unknown>;
    }> = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        requests.push({ authorization: new Headers(init?.headers).get('authorization'), body });
        const path = String((body.paths as string[] | undefined)?.[0] ?? '');
        const directory = path.split('/').at(-2) ?? '';
        const singular = directory.replace(/s$/u, '');
        const frontmatter = directory === 'questions'
            ? { title: 'Missing evidence', status: 'open', question_type: 'knowledge-gap' }
            : { title: `Open ${singular}`, status: 'open' };
        return new Response(JSON.stringify({ ok: true, results: [{ path: `src/content/${directory}/${singular}-a.mdx`, frontmatter, body: `Body for ${singular}.` }] }), {
            status: 200, headers: { 'content-type': 'application/json' },
        });
    };
    const sources = await listTreeDxPlanningDemandSources({
        config: { TREESEED_API_BASE_URL: 'http://127.0.0.1:3000', fetchImpl },
        getProjectTreeDxLibrary: async () => ({ repositoryId: 'treeseed-project-a' }),
    }, workdayRun({
        scenarioId: 'research', parameters: { repositoryIdsByProjectId: { 'project-a': 'treeseed-project-a' } },
    }), { id: 'project-a', slug: 'project-a' });
    expect(sources.map((source) => source.sourceType)).toEqual(['objective', 'knowledge-gap', 'proposal', 'decision-review']);
    expect(requests).toHaveLength(4);
    expect(requests.every((request) => request.authorization?.startsWith('Bearer '))).toBe(true);
});

it('compiles acting demand only with approval, readiness, accepted capacity plan, and a ready graph node', async () => {
    const { database, store } = harness();
    try {
        const now = await seed(store);
        const run = workdayRun({ startedAt: now, createdAt: now, updatedAt: now });
        const workUnits = [{ id: 'plan-a:wu:1', workGraphNodeId: 'work-unit-a', decisionExecutionInputId: 'input-a', decisionId: 'decision-a', projectAgentClassId: 'class-a', mode: 'acting', agentId: 'architect', handlerId: 'actor', activityType: 'acting', expectedCredits: 1, highCredits: 2, requiredCapabilities: ['engineering'], blockers: [], decisionInput: { handlerId: 'actor', workGraphNodeId: 'work-unit-a' } }];
        await store.run(`INSERT INTO agent_capacity_plans (id, team_id, project_id, decision_id, status, scope_hash, expected_credits, high_credits, work_units_json, capability_needs_json, environment_needs_json, reserves_json, blockers_json, review_json, metadata_json, created_at, updated_at) VALUES ('plan-a', 'team-a', 'project-a', 'decision-a', 'accepted', 'scope-a', 1, 2, ?, '[]', '[]', '{}', '[]', '{}', '{}', ?, ?)`, [JSON.stringify(workUnits), now, now]);
        expect(await listActingDemandSources(store, run, { id: 'project-a' }, 'workday-a')).toEqual([]);
        await store.run(`INSERT INTO decision_planning_statuses (id, team_id, project_id, decision_id, human_approval_state, execution_readiness, planning_inputs_status, scope_hash, metadata_json, created_at, updated_at) VALUES ('readiness-a', 'team-a', 'project-a', 'decision-a', 'approved', 'ready', 'complete', 'scope-a', '{}', ?, ?)`, [now, now]);
        expect(await listActingDemandSources(store, run, { id: 'project-a' }, 'workday-a')).toEqual([]);
        await store.run(`INSERT INTO decision_assignment_graphs (id, team_id, project_id, decision_id, version, status, active, graph_json, metadata_json, created_at, updated_at) VALUES ('graph-a', 'team-a', 'project-a', 'decision-a', 1, 'ready', 1, ?, '{}', ?, ?)`, [JSON.stringify({ nodes: [{ id: 'work-unit-a', status: 'pending', targetAgentClass: 'class-a', activityType: 'acting', handler: 'actor', requiredDeliverableContractIds: [] }], edges: [] }), now, now]);
        await store.run(`UPDATE project_agent_classes SET allowed_modes_json = '["planning","acting"]', handler_refs_json = '{"agents":[{"slug":"architect","activities":{"acting":{"handler":"actor"}}}]}' WHERE id = 'class-a'`);
        expect(await listActingDemandSources(store, run, { id: 'project-a' }, 'workday-a')).toEqual([
            expect.objectContaining({ sourceType: 'capacity-plan', sourceId: 'plan-a:wu:1', decisionId: 'decision-a', capacityPlanId: 'plan-a', requestedCredits: 2, payload: expect.objectContaining({ graphId: 'graph-a', nodeId: 'work-unit-a', decisionInput: expect.objectContaining({ metadata: expect.objectContaining({ capacityPlanId: 'plan-a', capacityPlanStatus: 'accepted', readiness: { executionReadiness: 'ready', planningInputsStatus: 'complete' } }) }), capacityEnvelope: expect.objectContaining({ metadata: expect.objectContaining({ capacityPlanId: 'plan-a', capacityPlanStatus: 'accepted' }) }) }) }),
        ]);
        await store.run(`UPDATE decision_assignment_graphs SET graph_json = ? WHERE id = 'graph-a'`, [JSON.stringify({ nodes: [{ id: 'work-unit-a', status: 'pending', targetAgentClass: 'another-class', activityType: 'acting', handler: 'actor', requiredDeliverableContractIds: [] }], edges: [] })]);
        expect(await listActingDemandSources(store, run, { id: 'project-a' }, 'workday-a')).toEqual([]);
        await store.run(`UPDATE decision_planning_statuses SET human_approval_state = 'pending' WHERE id = 'readiness-a'`);
        expect(await listActingDemandSources(store, run, { id: 'project-a' }, 'workday-a')).toEqual([]);
    }
    finally {
        await database.close();
    }
});

it('promotes the approved predecessor checkpoint as downstream exact-ref authority', async () => {
    const { database, store } = harness();
    try {
        const now = await seed(store);
        const run = workdayRun({ startedAt: now, createdAt: now, updatedAt: now });
        const originalRef = '0123456789abcdef';
        const checkpointRef = 'fedcba9876543210';
        const decisionInput = { input: { exactBaseRef: originalRef }, handlerId: 'actor', workGraphNodeId: 'implementation-node' };
        const workUnits = [{ id: 'plan-a:implementation', workGraphNodeId: 'implementation-node', decisionExecutionInputId: 'input-a', decisionId: 'decision-a', projectAgentClassId: 'class-a', mode: 'acting', agentId: 'architect', handlerId: 'actor', activityType: 'acting', expectedCredits: 1, highCredits: 2, requiredCapabilities: ['engineering'], blockers: [], decisionInput }];
        await store.run(`INSERT INTO agent_capacity_plans (id, team_id, project_id, decision_id, status, scope_hash, expected_credits, high_credits, work_units_json, capability_needs_json, environment_needs_json, reserves_json, blockers_json, review_json, metadata_json, created_at, updated_at) VALUES ('plan-a', 'team-a', 'project-a', 'decision-a', 'accepted', 'scope-a', 1, 2, ?, '[]', '[]', '{}', '[]', '{}', '{}', ?, ?)`, [JSON.stringify(workUnits), now, now]);
        await store.run(`INSERT INTO decision_planning_statuses (id, team_id, project_id, decision_id, human_approval_state, execution_readiness, planning_inputs_status, scope_hash, metadata_json, created_at, updated_at) VALUES ('readiness-a', 'team-a', 'project-a', 'decision-a', 'approved', 'ready', 'complete', 'scope-a', '{}', ?, ?)`, [now, now]);
        await store.run(`UPDATE project_agent_classes SET allowed_modes_json = '["planning","acting"]', handler_refs_json = '{"agents":[{"slug":"architect","activities":{"acting":{"handler":"actor"}}}]}' WHERE id = 'class-a'`);
        const graph = {
            projectId: 'project-a', decisionId: 'decision-a', metadata: { workflowKind: 'engineering-test-first', exactBaseRef: originalRef },
            nodes: [
                { id: 'test-node', status: 'completed', targetAgentClass: 'class-a', activityType: 'acting', handler: 'actor', requiredDeliverableContractIds: [], metadata: { stage: 'test', producesDeliverableContractId: 'test-contract' } },
                { id: 'implementation-node', status: 'ready', targetAgentClass: 'class-a', activityType: 'acting', handler: 'actor', requiredDeliverableContractIds: ['test-contract'], metadata: { stage: 'implementation' } },
            ],
            edges: [{ fromNodeId: 'test-node', toNodeId: 'implementation-node', edgeType: 'blocks-start' }],
        };
        await store.run(`INSERT INTO decision_assignment_graphs (id, team_id, project_id, decision_id, version, status, active, graph_json, metadata_json, created_at, updated_at) VALUES ('graph-a', 'team-a', 'project-a', 'decision-a', 1, 'ready', 1, ?, '{}', ?, ?)`, [JSON.stringify(graph), now, now]);
        const contract = { id: 'test-contract', teamId: 'team-a', projectId: 'project-a', decisionId: 'decision-a', deliverableType: 'failing_test_proof', producerAgentClasses: ['class-a'], acceptanceCriteria: ['proof'], status: 'approved', metadata: { deliverableManifestId: 'test-manifest' }, createdAt: now, updatedAt: now };
        await store.run(`INSERT INTO deliverable_contracts (id, team_id, project_id, decision_id, deliverable_type, status, contract_json, metadata_json, created_at, updated_at) VALUES ('test-contract', 'team-a', 'project-a', 'decision-a', 'failing_test_proof', 'approved', ?, ?, ?, ?)`, [JSON.stringify(contract), JSON.stringify(contract.metadata), now, now]);
        const manifest = { id: 'test-manifest', deliverableContractId: 'test-contract', projectId: 'project-a', decisionId: 'decision-a', producedRefs: [{ model: 'note', collection: 'notes', slug: 'test-proof' }], summary: 'Failing test proof', readyForReview: true, sourceAuthority: { assignmentId: 'assignment-test', modeRunId: 'mode-test', baseRef: originalRef, effectiveRef: checkpointRef, checkpointCommit: checkpointRef }, createdAt: now };
        await store.run(`INSERT INTO deliverable_manifests (id, deliverable_contract_id, project_id, decision_id, ready_for_review, manifest_json, metadata_json, submitted_at, created_at) VALUES ('test-manifest', 'test-contract', 'project-a', 'decision-a', 1, ?, '{}', ?, ?)`, [JSON.stringify(manifest), now, now]);
        const sources = await listActingDemandSources(store, run, { id: 'project-a' }, 'workday-a');
        expect(sources).toHaveLength(1);
        expect(sources[0]?.payload.decisionInput).toMatchObject({ input: { exactBaseRef: checkpointRef } });
        await store.run(`UPDATE deliverable_contracts SET metadata_json = '{}' WHERE id = 'test-contract'`);
        await expect(listActingDemandSources(store, run, { id: 'project-a' }, 'workday-a')).rejects.toMatchObject({ code: 'engineering_source_manifest_missing' });
        await store.run(`UPDATE deliverable_contracts SET metadata_json = ? WHERE id = 'test-contract'`, [JSON.stringify(contract.metadata)]);
        const otherContract = { ...contract, id: 'other-contract', metadata: { deliverableManifestId: 'other-manifest' } };
        await store.run(`INSERT INTO deliverable_contracts (id, team_id, project_id, decision_id, deliverable_type, status, contract_json, metadata_json, created_at, updated_at) VALUES ('other-contract', 'team-a', 'project-a', 'decision-a', 'implementation_change', 'approved', ?, ?, ?, ?)`, [JSON.stringify(otherContract), JSON.stringify(otherContract.metadata), now, now]);
        const otherManifest = { ...manifest, id: 'other-manifest', deliverableContractId: 'other-contract', sourceAuthority: { ...manifest.sourceAuthority, effectiveRef: 'aaaaaaaaaaaaaaaa', checkpointCommit: 'aaaaaaaaaaaaaaaa' } };
        await store.run(`INSERT INTO deliverable_manifests (id, deliverable_contract_id, project_id, decision_id, ready_for_review, manifest_json, metadata_json, submitted_at, created_at) VALUES ('other-manifest', 'other-contract', 'project-a', 'decision-a', 1, ?, '{}', ?, ?)`, [JSON.stringify(otherManifest), now, now]);
        graph.nodes.splice(1, 0, { id: 'other-node', status: 'completed', targetAgentClass: 'class-a', activityType: 'acting', handler: 'actor', requiredDeliverableContractIds: [], metadata: { stage: 'implementation', producesDeliverableContractId: 'other-contract' } });
        graph.edges.push({ fromNodeId: 'other-node', toNodeId: 'implementation-node', edgeType: 'blocks-start' });
        await store.run(`UPDATE decision_assignment_graphs SET graph_json = ? WHERE id = 'graph-a'`, [JSON.stringify(graph)]);
        await expect(listActingDemandSources(store, run, { id: 'project-a' }, 'workday-a')).rejects.toMatchObject({ code: 'engineering_source_ref_ambiguous' });
    }
    finally {
        await database.close();
    }
});

it('projects authenticated transitive predecessor evidence only for engineering review', async () => {
    const now = '2026-07-18T12:00:00.000Z';
    const refs = ['1111111111111111', '2222222222222222', '3333333333333333'];
    const stages = ['test', 'implementation', 'verification'];
    const contracts = new Map(stages.map((stage, index) => [`contract-${stage}`, {
            status: 'approved',
            deliverable_type: `${stage}_evidence`,
            metadata_json: JSON.stringify({ deliverableManifestId: `manifest-${stage}` }),
        }]));
    const manifests = new Map(stages.map((stage, index) => [`manifest-${stage}`, {
            manifest_json: JSON.stringify({
                id: `manifest-${stage}`, deliverableContractId: `contract-${stage}`, projectId: 'project-a', decisionId: 'decision-a',
                producedRefs: [{ model: 'note', collection: 'notes', slug: stage }], summary: `${stage} evidence`, readyForReview: true,
                sourceAuthority: { assignmentId: `assignment-${stage}`, modeRunId: `mode-${stage}`, baseRef: index === 0 ? refs[0] : refs[index - 1], effectiveRef: refs[index], checkpointCommit: stage === 'verification' ? null : refs[index] },
                createdAt: now,
            }),
        }]));
    const modeRuns = new Map(stages.map((stage, index) => [`mode-${stage}`, {
            outputs_json: JSON.stringify({
                artifactManifest: {
                    schemaVersion: 1, assignmentId: `assignment-${stage}`, modeRunId: `mode-${stage}`, teamId: 'team-a', projectId: 'project-a',
                    providerId: 'provider-a', mode: 'acting', agentClassId: 'class-a', agentId: stage, handlerId: 'actor', activityType: 'acting',
                    status: 'completed', summary: `${stage} evidence`, toolEvents: [], contentReferences: [],
                    ...(stage === 'verification' ? { verification: [{ status: 'passed', commands: ['npm test'] }] } : { sourceWorktree: { changedPaths: [`src/${stage}.ts`] }, verification: [] }),
                    citations: [], signals: [], usage: [], diagnostics: [], createdAt: now,
                },
            }),
        }]));
    const database = {
        async first(sql: string, params: unknown[]) {
            if (sql.includes('FROM deliverable_contracts'))
                return contracts.get(String(params[0])) ?? null;
            if (sql.includes('FROM deliverable_manifests'))
                return manifests.get(String(params[0])) ?? null;
            if (sql.includes('FROM agent_mode_runs'))
                return modeRuns.get(String(params[0])) ?? null;
            return null;
        },
    };
    const graph = {
        projectId: 'project-a', decisionId: 'decision-a', metadata: { workflowKind: 'engineering-test-first', exactBaseRef: refs[0], requireRevisionCycle: true },
        nodes: [
            ...stages.map((stage) => ({ id: `node-${stage}`, status: 'completed', metadata: { stage, producesDeliverableContractId: `contract-${stage}` } })),
            { id: 'node-review', status: 'ready', metadata: { stage: 'review' } },
        ],
        edges: [
            { fromNodeId: 'node-test', toNodeId: 'node-implementation' },
            { fromNodeId: 'node-implementation', toNodeId: 'node-verification' },
            { fromNodeId: 'node-verification', toNodeId: 'node-review' },
        ],
    };
    const result = await resolveEngineeringNodeAuthority({ database: database as never, graphId: 'graph-a', graph, node: graph.nodes[3]! });
    expect(result.exactBaseRef).toBe(refs[2]);
    expect(result.predecessorEvidence.map((entry) => entry.stage)).toEqual(stages);
    expect(result.predecessorEvidence[2]?.artifactManifest.verification).toEqual([{ status: 'passed', commands: ['npm test'] }]);
    expect(result.reviewPolicy).toEqual({ requireRevisionCycle: true, completedRevisionCycles: 0, requiredDisposition: 'rejected' });
});

it('creates one idempotent positive demand and allows one concurrent claim', async () => {
    const { database, store } = harness();
    try {
        await seed(store);
        const now = new Date().toISOString();
        const repository = new CapacityWorkdayDemandRepository(store);
        const input = {
            id: 'demand-a', teamId: 'team-a', projectId: 'project-a', workdayRunId: 'run-a', workdayId: 'workday-a',
            sourceType: 'idle-intent' as const, sourceId: 'architect:1', mode: 'planning' as const,
            projectAgentClassId: 'class-a', agentId: 'architect', handlerId: 'writer', activityType: 'planning',
            priority: 10, requestedCredits: 1, idempotencyKey: 'run-a:project-a:1:architect', payload: { objective: 'Plan useful work.' },
            availableAt: now, now,
        };
        expect((await repository.create(input)).id).toBe('demand-a');
        expect((await repository.create({ ...input, id: 'demand-duplicate' })).id).toBe('demand-a');
        const claims = await Promise.all([
            repository.claimNext('team-a', 'provider-a', now),
            repository.claimNext('team-a', 'provider-a', now),
        ]);
        expect(claims.filter(Boolean)).toHaveLength(1);
        expect(claims.find(Boolean)).toMatchObject({ id: 'demand-a', status: 'claimed', claimToken: expect.any(String) });
        await expect(repository.create({ ...input, id: 'demand-zero', idempotencyKey: 'zero', requestedCredits: 0 }))
            .rejects.toThrow(/check constraint/iu);
    }
    finally {
        await database.close();
    }
});

it('enforces active, useful-work, deadline, budget, pause, and resume continuation gates', async () => {
    const { database, store } = harness();
    try {
        const now = await seed(store);
        const controlPlane = createCapacityControlPlane(store);
        const evaluate = (usefulEligibleWork = true) => evaluateDurableWorkdayContinuation(store, {
            teamId: 'team-a', workdayRunId: 'run-a', workdayId: 'workday-a', usefulEligibleWork, now,
        });
        await expect(evaluate()).resolves.toMatchObject({ continue: true, reason: 'within_duration_and_budget' });
        await expect(evaluate(false)).resolves.toMatchObject({ continue: false, reason: 'no_useful_eligible_work' });
        await store.run(`UPDATE capacity_workday_runs SET parameters_json = '{"deadlineAt":"2026-07-18T11:59:59.000Z"}' WHERE id = 'run-a'`);
        await expect(evaluate()).resolves.toMatchObject({ continue: false, reason: 'duration_bound_reached' });
        await store.run(`UPDATE capacity_workday_runs SET parameters_json = '{}' WHERE id = 'run-a'`);
        await store.run(`UPDATE workday_capacity_envelopes SET envelope_json = '{"availableCredits":0}' WHERE id = 'workday-a'`);
        await expect(evaluate()).resolves.toMatchObject({ continue: false, reason: 'budget_bound_reached' });
        await store.run(`UPDATE workday_capacity_envelopes SET envelope_json = '{"availableCredits":10}' WHERE id = 'workday-a'`);
        await expect(controlPlane.updateWorkdayCapacityEnvelopeState('workday-a', 'paused')).resolves.toMatchObject({ status: 'paused' });
        await expect(evaluate()).resolves.toMatchObject({ continue: false, reason: 'workday_not_active' });
        await expect(controlPlane.updateWorkdayCapacityEnvelopeState('workday-a', 'active')).resolves.toMatchObject({ status: 'active' });
        await expect(evaluate()).resolves.toMatchObject({ continue: true, reason: 'within_duration_and_budget' });
    }
    finally {
        await database.close();
    }
});

it('persists exclusions and cannot start a new cycle before every eligible agent is covered', async () => {
    const { database, store } = harness();
    try {
        const now = await seed(store);
        const repository = new CapacityWorkdayParticipationRepository(store);
        const agents = [
            { agentId: 'architect', projectAgentClassId: 'class-a', eligible: true },
            { agentId: 'reviewer', projectAgentClassId: 'class-a', eligible: false, reasonCode: 'grant_mode_denied' },
        ];
        const first = await repository.ensureOpenCycle({ teamId: 'team-a', projectId: 'project-a', workdayRunId: 'run-a', agents, now });
        expect(first.cycle).toMatchObject({ cycleNumber: 1, status: 'open' });
        expect(first.entries).toEqual([
            expect.objectContaining({ agentId: 'architect', status: 'pending' }),
            expect.objectContaining({ agentId: 'reviewer', status: 'excluded', reasonCode: 'grant_mode_denied' }),
        ]);
        expect((await repository.ensureOpenCycle({ teamId: 'team-a', projectId: 'project-a', workdayRunId: 'run-a', agents, now })).cycle.cycleNumber).toBe(1);
        await store.run(`UPDATE capacity_workday_participation_entries SET status = 'completed', covered_at = ? WHERE id = ?`, [now, first.entries[0]!.id]);
        const second = await repository.ensureOpenCycle({ teamId: 'team-a', projectId: 'project-a', workdayRunId: 'run-a', agents, now });
        expect(second.cycle).toMatchObject({ cycleNumber: 2, status: 'open' });
        expect(await store.first(`SELECT status FROM capacity_workday_participation_cycles WHERE id = ?`, [first.cycle.id])).toMatchObject({ status: 'closed' });
    }
    finally {
        await database.close();
    }
});

it('keeps one project-wide participation cycle across distinct agent classes', async () => {
    const { database, store } = harness();
    try {
        const now = await seed(store);
        await store.run(`INSERT INTO project_agent_classes (id, team_id, project_id, slug, name, allowed_modes_json, handler_refs_json, created_at, updated_at) VALUES ('class-engineering', 'team-a', 'project-a', 'engineering', 'Engineering', '["planning"]', '{}', ?, ?), ('class-review', 'team-a', 'project-a', 'review', 'Review', '["planning"]', '{}', ?, ?)`, [now, now, now, now]);
        const repository = new CapacityWorkdayParticipationRepository(store);
        const agents = [
            { agentId: 'architect', projectAgentClassId: 'class-a', eligible: true },
            { agentId: 'engineer', projectAgentClassId: 'class-engineering', eligible: true },
            { agentId: 'reviewer', projectAgentClassId: 'class-review', eligible: true },
        ];
        const first = await repository.ensureOpenCycle({ teamId: 'team-a', projectId: 'project-a', workdayRunId: 'run-a', agents, now });
        expect(first.cycle.cycleNumber).toBe(1);
        expect(first.entries.map((entry) => [entry.agentId, entry.projectAgentClassId, entry.status])).toEqual([
            ['architect', 'class-a', 'pending'],
            ['engineer', 'class-engineering', 'pending'],
            ['reviewer', 'class-review', 'pending'],
        ]);
        await store.run(`UPDATE capacity_workday_participation_entries SET status = 'completed', covered_at = ? WHERE id = ?`, [now, first.entries[0]!.id]);
        const stillFirst = await repository.ensureOpenCycle({ teamId: 'team-a', projectId: 'project-a', workdayRunId: 'run-a', agents, now });
        expect(stillFirst.cycle.cycleNumber).toBe(1);
        expect(stillFirst.entries.filter((entry) => entry.status === 'pending').map((entry) => entry.agentId)).toEqual(['engineer', 'reviewer']);
        await store.run(`UPDATE capacity_workday_participation_entries SET status = 'completed', covered_at = ? WHERE cycle_id = ?`, [now, first.cycle.id]);
        const second = await repository.ensureOpenCycle({ teamId: 'team-a', projectId: 'project-a', workdayRunId: 'run-a', agents, now });
        expect(second.cycle.cycleNumber).toBe(2);
        expect(second.entries).toHaveLength(3);
    }
    finally {
        await database.close();
    }
});

it('compiles configured planning into one durable demand instead of creating an assignment directly', async () => {
    const { database, store } = harness();
    try {
        const now = await seed(store);
        const controlPlane = createCapacityControlPlane(store);
        await expect(compileProviderWorkdayDemand(controlPlane, {
            teamId: 'team-a', capacityProviderId: 'provider-a', membershipId: 'membership-a',
        }, now)).resolves.toEqual({ consideredRuns: 1, compiledDemands: 1 });
        await expect(compileProviderWorkdayDemand(controlPlane, {
            teamId: 'team-a', capacityProviderId: 'provider-a', membershipId: 'membership-a',
        }, now)).resolves.toEqual({ consideredRuns: 1, compiledDemands: 0 });
        expect(await store.all(`SELECT source_type, mode, status, agent_id, requested_credits FROM capacity_workday_demands`)).toEqual([
            { source_type: 'idle-intent', mode: 'planning', status: 'pending', agent_id: 'architect', requested_credits: 1 },
        ]);
        expect(await store.all(`SELECT status, agent_id, demand_id FROM capacity_workday_participation_entries`)).toEqual([
            { status: 'assigned', agent_id: 'architect', demand_id: expect.any(String) },
        ]);
        expect(await store.all(`SELECT id FROM capacity_provider_assignments`)).toEqual([]);
    }
    finally {
        await database.close();
    }
});

it('stops new work without zero-settling a valid in-flight lease during its grace window', async () => {
    const { database, store } = harness();
    try {
        const now = await seed(store);
        const leaseExpiresAt = '2026-07-18T12:02:00.000Z';
        const graceUntil = '2026-07-18T12:05:00.000Z';
        await store.run(`INSERT INTO capacity_providers (id, fingerprint, public_jwk_json, display_name, identity_version, status, metadata_json, created_at, updated_at) VALUES ('provider-a', 'sha256:provider-a', '{}', 'Provider A', 1, 'active', '{}', ?, ?)`, [now, now]);
        await store.run(`INSERT INTO capacity_provider_team_memberships (id, team_id, capacity_provider_id, status, approved_at, approved_by_id, metadata_json, created_at, updated_at) VALUES ('membership-a', 'team-a', 'provider-a', 'approved', ?, 'owner', '{}', ?, ?)`, [now, now, now]);
        await store.run(`INSERT INTO capacity_allocation_sets (id, team_id, version, status, effective_from, reserve_policy_json, slices_json, borrowing_rules_json, metadata_json, created_at, updated_at) VALUES ('allocation-a', 'team-a', 1, 'active', ?, '{}', '[]', '[]', '{}', ?, ?)`, [now, now, now]);
        await store.run(`INSERT INTO capacity_grants (id, membership_id, capacity_provider_id, team_id, project_id, environment, status, capabilities_json, allowed_modes_json, daily_credit_limit, metadata_json, created_at, updated_at) VALUES ('grant-a', 'membership-a', 'provider-a', 'team-a', 'project-a', 'local', 'active', '[]', '["planning"]', 10, '{}', ?, ?)`, [now, now]);
        await store.run(`INSERT INTO capacity_reservations (id, idempotency_key, admission_token, membership_id, grant_id, capacity_provider_id, allocation_set_id, allocation_version, project_agent_class_id, assignment_id, mode, team_id, project_id, work_day_id, state, reserved_credits, created_at, updated_at) VALUES ('reservation-a', 'reservation-a', 'token-a', 'membership-a', 'grant-a', 'provider-a', 'allocation-a', 1, 'class-a', 'assignment-a', 'planning', 'team-a', 'project-a', 'workday-a', 'reserved', 1, ?, ?)`, [now, now]);
        await store.run(`INSERT INTO capacity_provider_assignments (id, membership_id, team_id, project_id, capacity_provider_id, project_agent_class_id, reservation_id, work_day_id, mode, status, lease_state, lease_token, lease_expires_at, state_version, capacity_envelope_json, decision_input_json, created_at, updated_at) VALUES ('assignment-a', 'membership-a', 'team-a', 'project-a', 'provider-a', 'class-a', 'reservation-a', 'workday-a', 'planning', 'leased', 'leased', 'lease-a', ?, 2, '{"teamId":"team-a","projectId":"project-a","mode":"planning"}', '{"teamId":"team-a","projectId":"project-a","projectAgentClassId":"class-a","mode":"planning","input":{}}', ?, ?)`, [leaseExpiresAt, now, now]);
        await store.run(`INSERT INTO capacity_workday_demands (id, team_id, project_id, workday_run_id, workday_id, source_type, source_id, mode, project_agent_class_id, agent_id, handler_id, activity_type, status, priority, requested_credits, idempotency_key, assignment_id, payload_json, metadata_json, available_at, admitted_at, created_at, updated_at) VALUES ('demand-a', 'team-a', 'project-a', 'run-a', 'workday-a', 'idle-intent', 'architect', 'planning', 'class-a', 'architect', 'writer', 'planning', 'admitted', 1, 1, 'demand-a', 'assignment-a', '{}', '{}', ?, ?, ?, ?)`, [now, now, now, now]);
        const preserved = await createCapacityControlPlane(store).terminalizeCapacityWorkdayAssignments('team-a', 'run-a', {
            now: '2026-07-18T12:01:00.000Z', preserveActiveLeasesUntil: graceUntil,
        });
        expect(preserved).toMatchObject({ unfinishedAssignmentCount: 1, deferredActiveAssignmentCount: 1 });
        expect(await store.first(`SELECT status, lease_token FROM capacity_provider_assignments WHERE id = 'assignment-a'`)).toEqual({ status: 'leased', lease_token: 'lease-a' });
        expect(await store.first(`SELECT state FROM capacity_reservations WHERE id = 'reservation-a'`)).toEqual({ state: 'reserved' });
        const fenced = await createCapacityControlPlane(store).terminalizeCapacityWorkdayAssignments('team-a', 'run-a', {
            now: '2026-07-18T12:06:00.000Z', preserveActiveLeasesUntil: graceUntil,
        });
        expect(fenced).toMatchObject({ unfinishedAssignmentCount: 0, failedAssignments: 1, deferredActiveAssignmentCount: 0 });
        expect(await store.first(`SELECT status, lease_token FROM capacity_provider_assignments WHERE id = 'assignment-a'`)).toEqual({ status: 'failed', lease_token: null });
        expect(await store.first(`SELECT state, consumed_credits FROM capacity_reservations WHERE id = 'reservation-a'`)).toEqual({ state: 'consumed', consumed_credits: 0 });
    }
    finally {
        await database.close();
    }
});
});
