import { describe, expect, it, vi } from 'vitest';
import type { ExecutionNode } from '@treeseed/sdk/agent-capacity';
import { reconcileExecutionGraph } from '../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-service.ts';

const { projectWorkdays } = vi.hoisted(() => ({ projectWorkdays: vi.fn() }));
vi.mock('../../../../../../src/api/capacity/policy/execution/workday-execution-projector.ts', () => ({ projectActiveWorkdays: projectWorkdays }));

describe('project-scoped reconciliation during another project workday', () => {
	it('identifies the owning persisted class and profile when malformed authority blocks live reconciliation', async () => {
		const store = { all: async (sql: string) => sql.includes('FROM project_agent_classes') ? [{
			project_id: 'agent-project', id: 'retained-planning-class', status: 'active', handler_refs_json: {
				agents: [{ id: 'agent/retained-planner', schemaVersion: 'retired' }],
			},
		}] : [], first: async () => null };
		await expect(reconcileExecutionGraph(store, 'team', { plan: true })).rejects.toMatchObject({
			code: 'agent_profile_invalid', message: expect.stringContaining('agent-project/retained-planning-class'),
		});
		await expect(reconcileExecutionGraph(store, 'team', { plan: true })).rejects.toMatchObject({
			message: expect.stringContaining('agent/retained-planner'),
		});
	});
	it('indexes every configured subscriber by identity and refuses duplicate identities without a class winner', async () => {
		const definition = (name: string) => ({ schemaVersion: 'treeseed.agent/v1', id: `sdk/${name}`, name,
			agentClass: 'maintenance', purpose: 'Contribute bounded portfolio work.', responsibilities: ['Respond to governed work.'],
			capabilities: ['reasoning'], context: { include: ['project'] }, groupIds: ['portfolio'], activityProfiles: {
				chat: { handler: 'writer', permissions: { content: { read: ['discussion'], write: ['discussion'] }, tools: [] },
					prompt: { system: `Answer the governed portfolio request as ${name}.` } },
			} });
		const first = definition('technical-writer'), second = definition('tester');
		projectWorkdays.mockReturnValue({ nodes: [], edges: [], changedSourceRefs: [] });
		for (const agents of [[first, second], [first, first]]) {
			const store = { all: async (sql: string) => sql.includes('FROM project_agent_classes')
				? [{ project_id: 'sdk', handler_refs_json: { agents } }]
				: sql.includes('FROM capacity_workday_runs') ? [{ id: 'workday', team_id: 'team', parameters_json: { appliedPlan: {} } }] : [],
				first: async () => null };
			const pending = reconcileExecutionGraph(store, 'team', { plan: true });
			if (agents[0] === agents[1]) await expect(pending).rejects.toMatchObject({ code: 'agent_profile_conflict' });
			else {
				await pending;
				expect(projectWorkdays).toHaveBeenLastCalledWith(expect.objectContaining({ profiles: {
					'sdk:sdk/technical-writer': first, 'sdk:sdk/tester': second,
				} }));
			}
		}
	});
	it('keeps workday projection authoritative even when its source is a proposal', async () => {
		const sourceRef = { store: 'treedx' as const, model: 'proposal', id: 'golden-sdk', revision: 1,
			digest: `sha256:${'a'.repeat(64)}`, repository: 'sdk-library', commit: 'b'.repeat(40), path: 'proposals/golden.mdx' };
		const node: ExecutionNode = { schemaVersion: 'treeseed.execution-node/v1', id: 'planning:sdk:architect',
			teamId: 'team', projectId: 'sdk', workdayId: 'workday', kind: 'planning', pairRole: null,
			sourceRef, authorityRefs: [], ruleRevision: 2, nodeRevision: 1, status: 'completed', agentClass: 'architect',
			estimate: { expectedSeconds: 180, maximumSeconds: 180 }, requiredCapabilities: ['planning'],
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
