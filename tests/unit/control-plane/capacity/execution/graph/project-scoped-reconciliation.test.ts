import { describe, expect, it, vi } from 'vitest';
import type { ExecutionNode } from '@treeseed/sdk/agent-capacity';
import { reconcileExecutionGraph } from '../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-service.ts';

const { projectWorkdays } = vi.hoisted(() => ({ projectWorkdays: vi.fn() }));
vi.mock('../../../../../../src/api/capacity/policy/execution/workday-execution-projector.ts', () => ({ projectActiveWorkdays: projectWorkdays }));

describe('project-scoped reconciliation during another project workday', () => {
	it('keeps workday projection authoritative even when its source is a proposal', async () => {
		const sourceRef = { store: 'treedx' as const, model: 'proposal', id: 'golden-sdk', revision: 1,
			digest: `sha256:${'a'.repeat(64)}`, repository: 'sdk-library', commit: 'b'.repeat(40), path: 'proposals/golden.mdx' };
		const node: ExecutionNode = { schemaVersion: 'treeseed.execution-node/v1', id: 'planning:sdk:architect',
			teamId: 'team', projectId: 'sdk', workdayId: 'workday', kind: 'planning', pairRole: null,
			sourceRef, authorityRefs: [], ruleRevision: 2, nodeRevision: 1, status: 'completed', agentClass: 'architect',
			estimate: { minimumSeconds: 1, expectedSeconds: 180, maximumSeconds: 180 }, requiredCapabilities: ['planning'],
			requestedPermissions: { content: { read: ['proposal'], write: [] }, tools: [] }, workspace: 'read-only',
			acceptanceCriteria: ['Publish a contribution.'], graphRevisionCreated: 1, graphRevisionUpdated: 1 };
		projectWorkdays.mockReturnValue({ nodes: [node], edges: [], changedSourceRefs: [sourceRef] });
		const row = { id: node.id, team_id: 'team', project_id: 'sdk', workday_id: 'workday', kind: 'planning',
			pair_role: null, source_ref_json: JSON.stringify(sourceRef), authority_refs_json: '[]', rule_revision: 2,
			node_revision: 1, status: 'completed', agent_class: 'architect', estimate_json: JSON.stringify(node.estimate),
			required_capabilities_json: JSON.stringify(node.requiredCapabilities), requested_permissions_json: JSON.stringify(node.requestedPermissions),
			workspace: 'read-only', acceptance_criteria_json: JSON.stringify(node.acceptanceCriteria), graph_revision_created: 1, graph_revision_updated: 1 };
		const batch = vi.fn(async () => {});
		const store = { all: async (sql: string) => sql.includes('FROM execution_nodes') ? [row]
			: sql.includes('FROM capacity_workday_runs') ? [{ id: 'workday', team_id: 'team', parameters_json: { appliedPlan: {} } }] : [],
			first: async () => ({ revision: 1, graph_digest: `sha256:${'c'.repeat(64)}` }), batch };
		const result = await reconcileExecutionGraph(store, 'team', { projectId: 'api', plan: true });
		expect(result).toMatchObject({ teamId: 'team', baseRevision: 1 });
		expect(batch).not.toHaveBeenCalled();
		expect(projectWorkdays).toHaveBeenCalledWith(expect.objectContaining({ sources: [expect.objectContaining({ id: 'workday' })] }));
	});
});
