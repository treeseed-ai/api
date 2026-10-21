import type{PoolClient}from'pg';
import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import { isolatedPostgres } from '../../../../../fixtures/isolated-postgres.ts';
import { parse } from 'yaml';
import { validateAgentDefinitionModel, type AgentDefinition } from '@treeseed/sdk/agent-capacity';
import { readyProposal, readyWorkItem } from '../../../../../governance/proposals/architecture/ready-proposal-fixture.ts';
import { projectTeamExecutionGraph, type ExecutableProposalSource } from '../../../../../../../../src/api/capacity/policy/execution/execution-graph-projector.ts';
import { applyOperationalState, type TeamGraph } from '../../../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-state.ts';
import { createExecutionGraphService, persistExecutionGraph } from '../../../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-service.ts';
import { splitPostgresSqlStatements } from '../../../../../../../../src/api/persistence/postgres-sql-statements.ts';

// Governed inputs only: actual projector, state transition, SQL writer and read
// service are exercised. This does not claim API authentication or live TreeDX.
export function graphProfile(agentClass: string, predecessor?: string): AgentDefinition {
	const activity = agentClass === 'reviewer' ? 'reviewing' : 'acting';
	const result = validateAgentDefinitionModel(parse(`
schemaVersion: treeseed.agent/v1
id: configured/${agentClass}
name: Arbitrary ${agentClass}
agentClass: ${agentClass}
purpose: Independently complete the exact governed assignment.
responsibilities: [Preserve immutable authority and return exact evidence.]
capabilities: [verification]
context: { include: [assignment-subject] }
activityProfiles:
  ${activity}:
    handler: writer
    prompt: { system: Independently verify the exact governed work item. }
    permissions: { content: { read: [proposal], write: [] }, tools: [] }
    ${predecessor ? `dependsOn: { agents: [${predecessor}] }` : ''}
`));
	if (!result.ok || !result.data) throw new Error(JSON.stringify(result.diagnostics));
	return result.data;
}
export function graphSource(projectId = 'project'): ExecutableProposalSource {
	const first = { ...readyWorkItem(), id: 'first' };
	const next = { ...readyWorkItem(), id: 'next', agentClass: 'boundary-verifier', dependsOn: ['first'] };
	return { teamId: 'team', projectId, repository: `${projectId}-library`, path: 'proposals/proposal.mdx',
		commit: 'a'.repeat(40), digest: `sha256:${'b'.repeat(64)}`, proposalRevision: 1,
		// Complete controlled authority INPUT for projector/state unit boundaries;
		// not a native Decision publication or independent content readback.
		decision: { id: `${projectId}-decision`, revision: 1, digest: `sha256:${'c'.repeat(64)}`, current: true,
			repository: `${projectId}-library`, commit: 'd'.repeat(40), path: `decisions/${projectId}-decision.mdx` },
		frontmatter: { ...readyProposal(), id: `${projectId}-proposal`, projectId, status: 'decided',
			executionPlan: { workItems: [first, next] } } };
}
export function graphProfiles(projectIds = ['project']): Record<string, AgentDefinition> {
	return Object.fromEntries(projectIds.flatMap(projectId => [
		[`${projectId}:boundary-author`, graphProfile('boundary-author')],
		[`${projectId}:boundary-verifier`, graphProfile('boundary-verifier', 'boundary-author')],
		[`${projectId}:reviewer`, graphProfile('reviewer')],
	]));
}
export const emptyLivingGraph = (): TeamGraph => ({ teamId: 'team', revision: 0, digest: '', nodes: [], edges: [] });
export function authoredGraphFixture() {
	const source = graphSource();
	const workItems = Array.from({ length: 6 }, (_, index) => {
		const workspace = index % 2 ? 'git' : 'treedx';
		return { ...readyWorkItem(), id: `authored-${index}`, agentClass: index % 2 ? 'boundary-verifier' : 'boundary-author',
			workspace, contextRefs: [{ store: workspace, model: 'repository', id: source.projectId,
				repository: workspace === 'git' ? `${source.projectId}-source` : source.repository, commit: source.commit }],
			estimate: { expectedSeconds: 120 + index, maximumSeconds: 240 + index },
			reviewEstimate: { expectedSeconds: 60 + index, maximumSeconds: 120 + index } };
	});
	source.frontmatter.executionPlan = { workItems };
	return { source, workItems };
}
export function expectAuthoredGraphPairs(graph: Pick<TeamGraph, 'nodes' | 'edges'>, fixture: ReturnType<typeof authoredGraphFixture>) {
	const { source, workItems } = fixture, decision = source.decision;
	if (!decision) throw new Error('Exact controlled Decision input required.');
	const sourceRef = { store: 'treedx', model: 'proposal', id: source.frontmatter.id, revision: source.proposalRevision,
		digest: source.digest, repository: source.repository, commit: source.commit, path: source.path };
	const authorityRefs = [{ store: 'treedx', model: 'decision', id: decision.id, revision: decision.revision,
		digest: decision.digest, repository: decision.repository, commit: decision.commit, path: decision.path }];
	const nodes = graph.nodes.filter(node => node.projectId === source.projectId && node.pairRole);
	expect(nodes).toHaveLength(12); expect(new Set(nodes.map(node => node.id)).size).toBe(12);
	for (const item of workItems) {
		const actors = nodes.filter(node => node.workItemId === item.id && node.pairRole === 'actor');
		const reviewers = nodes.filter(node => node.workItemId === item.id && node.pairRole === 'reviewer');
		expect(actors).toHaveLength(1); expect(reviewers).toHaveLength(1);
		const exact = { teamId: source.teamId, projectId: source.projectId, workItemId: item.id,
			sourceRef, authorityRefs, maximumReviewCycles: item.maximumReviewCycles };
		expect(actors[0]).toMatchObject({ ...exact, kind: 'acting', agentClass: item.agentClass, workspace: item.workspace, estimate: item.estimate });
		expect(reviewers[0]).toMatchObject({ ...exact, kind: 'reviewing', agentClass: 'reviewer', workspace: 'treedx', estimate: item.reviewEstimate });
		const pairs = graph.edges.filter(edge => edge.fromNodeId === actors[0]!.id && edge.toNodeId === reviewers[0]!.id && edge.provenance === 'review-pair');
		expect(pairs).toHaveLength(1); expect(pairs[0]).toMatchObject({ teamId: source.teamId, sourceRef });
	}
}
export function graphProjection(sources = [graphSource()], revision = 1, profiles = graphProfiles(sources.map(source => source.projectId))) {
	return projectTeamExecutionGraph({ teamId: 'team', revision, sources, profiles, createdAt: '2026-10-03T00:00:00.000Z' });
}
export function graphState(projection: ReturnType<typeof graphProjection>, current = emptyLivingGraph(), active = new Set<string>()): TeamGraph {
	return applyOperationalState(current, { teamId: 'team', revision: projection.revision.revision,
		digest: projection.revision.graphDigest, nodes: projection.nodes, edges: projection.edges }, projection.revision.revision, active);
}
export function graphNode(graph: TeamGraph, workItemId: string, pairRole: 'actor' | 'reviewer', projectId = 'project') {
	const node = graph.nodes.find(value => value.projectId === projectId && value.workItemId === workItemId && value.pairRole === pairRole);
	if (!node) throw new Error(`Missing ${projectId}/${workItemId}/${pairRole}`);
	return node;
}
export async function livingGraphDatabase() {
	const db = await isolatedPostgres();
	try {
		// Minimal team/assignment host tables; original owning graph migrations.
		await db.exec("CREATE TABLE teams (id text PRIMARY KEY); INSERT INTO teams VALUES ('team'),('other-team'); CREATE TABLE capacity_provider_assignments (id text PRIMARY KEY, team_id text, status text);");
		for (const file of ['0023_living_execution_graph.sql', '0032_execution_graph_revision_integrity.sql', '0041_execution_content_output_authority.sql', '0044_execution_priority_dependency_provenance.sql', '0045_remove_retired_execution_output_selector.sql']) {
			for (const sql of splitPostgresSqlStatements(readFileSync(`drizzle/control-plane/${file}`, 'utf8'))) await db.exec(sql);
		}
		const query = (sql: string, params: unknown[] = []) => {
			let index = 0; return db.query<Record<string, unknown>>(sql.replace(/\?/gu, () => `$${++index}`), params);
		};
		const store = {
			db:{transaction:<T>(apply:(client:PoolClient)=>Promise<T>)=>db.transaction(transaction=>apply(transaction as unknown as PoolClient))},
			all: async (sql: string, params: unknown[] = []) => (await query(sql, params)).rows,
			first: async (sql: string, params: unknown[] = []) => (await query(sql, params)).rows[0] ?? null,
			batch: (operations: Array<{ query: string; params: unknown[] }>) => db.transaction(async transaction => {
				for (const operation of operations) { let index = 0; await transaction.query(operation.query.replace(/\?/gu, () => `$${++index}`), operation.params); }
			}),
		};
		const snapshot = async () => ({
			nodes: await store.all('SELECT * FROM execution_nodes ORDER BY id'),
			edges: await store.all('SELECT * FROM execution_edges ORDER BY id'),
			revisions: await store.all('SELECT * FROM execution_graph_revisions ORDER BY team_id,revision'),
			assignments: await store.all('SELECT * FROM capacity_provider_assignments ORDER BY id'),
		});
		const persist = (next: TeamGraph, current: TeamGraph, receipt: ReturnType<typeof graphProjection>['revision']) =>
			persistExecutionGraph(store, next, current, { ...receipt, graphDigest: next.digest });
		return { db, query, store, snapshot, persist, service: createExecutionGraphService(store), principal: { id: 'operator', roles: ['admin'] } };
	} catch (error) { await db.close(); throw error; }
}
