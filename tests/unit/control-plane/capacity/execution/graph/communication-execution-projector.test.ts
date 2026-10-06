import { describe, expect, it, vi } from 'vitest';
import { calculateAssignmentAllocation } from '@treeseed/sdk/agent-capacity';
import { projectCommunicationInvocations } from '../../../../../../src/api/capacity/policy/execution/communication-execution-projector.ts';
import { reconcileCommunicationExecutionGraph } from '../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-service.ts';

const definition = {
	schemaVersion: 'treeseed.agent/v1' as const, id: 'sdk/architect', name: 'SDK Architect', agentClass: 'architect',
	purpose: 'Explain and guide SDK architecture.', responsibilities: ['Answer bounded SDK questions.'],
	capabilities: ['reasoning'], context: { include: ['project-objectives'] },
	activityProfiles: { chat: { handler: 'writer', permissions: {
		content: { read: ['discussion'], write: ['discussion'] }, tools: ['discussion'],
	}, prompt: { system: 'Research the authorized context and answer with evidence.' } } },
};

describe('communication living-graph projection', () => {
	it('projects chat in the one team graph without validating unrelated accepted proposal content', async () => {
		const acceptedRef = { store: 'treedx', model: 'proposal', id: 'legacy-accepted', revision: 1,
			digest: `sha256:${'b'.repeat(64)}`, repository: 'treeseed-ai/sdk-library', commit: 'a'.repeat(40), path: 'proposals/legacy.mdx' };
		const all = vi.fn(async (sql: string) => {
			if (sql.includes('governance_proposals')) throw new Error('Unrelated accepted proposal is not executable');
			if (sql.includes('FROM execution_nodes')) return [{ id: 'accepted-condition', team_id: 'team', project_id: 'sdk',
				kind: 'condition', pair_role: null, source_ref_json: acceptedRef, authority_refs_json: [], rule_revision: 1,
				node_revision: 1, status: 'blocked', condition_json: { conditionType: 'authority', subjectRef: acceptedRef,
					expectedState: 'accepted' }, graph_revision_created: 1, graph_revision_updated: 1 }];
			if (sql.includes('FROM project_agent_classes')) return [{ project_id: 'sdk', handler_refs_json: { agents: [definition] } }];
			if (sql.includes('FROM agent_invocation_requests')) return [{ id: 'invocation', team_id: 'team', project_id: 'sdk',
				agent_id: 'architect', execution_id: 'conversation-invocation', repository_id: 'treeseed-ai/sdk-library',
				metadata_json: { sourceMessagePath: 'discussion-messages/smoke/request.mdx', sourceCommit: 'a'.repeat(40),
					productiveSeconds: 180 }, content_refs_json: [] }];
			return [];
		});
		const store = { all, first: vi.fn(async () => ({ revision: 1, graph_digest: `sha256:${'c'.repeat(64)}` })) };
		const planned = await reconcileCommunicationExecutionGraph(store, 'team', { plan: true });
		expect(planned).toMatchObject({ baseRevision: 1, changes: { added: ['communication:invocation:conversation-invocation'],
			stale: [], completed: [] } });
		expect(all.mock.calls.some(([sql]) => sql.includes('governance_proposals'))).toBe(false);
		expect(all.mock.calls.some(([sql]) => sql.includes('FROM capacity_workday_runs') && !sql.includes('agent_invocation_requests'))).toBe(false);
	});
	it('projects an addressed message as one ready read-only chat assignment source', () => {
		const projected = projectCommunicationInvocations({ teamId: 'team', revision: 3,
			profiles: { 'sdk:architect': definition }, sources: [{
				id: 'invocation', teamId: 'team', projectId: 'sdk', workdayId: 'conversation-invocation',
				agentId: 'architect', repository: 'treeseed-ai/sdk-library', commit: 'a'.repeat(40),
				path: 'discussions/test/messages/request.mdx', durationSeconds: 300,
			}] });
		expect(projected.nodes).toEqual([expect.objectContaining({
			id: 'communication:invocation:conversation-invocation', kind: 'communication', status: 'ready', agentClass: 'architect',
			workspace: 'treedx', workdayId: 'conversation-invocation',
			estimate: { expectedSeconds: 300, maximumSeconds: 300 },
			requiredCapabilities: ['treeseed.coordination.conversation'],
			sourceRef: expect.objectContaining({ model: 'discussion', path: 'discussions/test/messages/request.mdx' }),
		})]);
		expect(projected.changedSourceRefs).toEqual([projected.nodes[0]!.sourceRef]);
		expect(calculateAssignmentAllocation({ estimate: projected.nodes[0]!.estimate!, measurements: [],
			constraints: [{ id: 'utc-day-window', remainingSeconds: 11 }] })).toEqual(expect.objectContaining({
			admitted: true, allocatedSeconds: 11, limitingConstraint: 'utc-day-window',
		}));
	});

	it('keeps the viable minimum within a shorter requested duration', () => {
		const projected = projectCommunicationInvocations({ teamId: 'team', revision: 3,
			profiles: { 'sdk:architect': definition }, sources: [{
				id: 'invocation', teamId: 'team', projectId: 'sdk', workdayId: 'conversation-invocation',
				agentId: 'architect', repository: 'treeseed-ai/sdk-library', commit: 'a'.repeat(40),
				path: 'discussions/test/messages/request.mdx', durationSeconds: 30,
			}] });
		expect(projected.nodes[0]?.estimate).toEqual({ expectedSeconds: 30, maximumSeconds: 30 });
	});

	it('uses the conversation workday in node identity so a retry cannot inherit a terminal prior run', () => {
		const project = (workdayId: string) => projectCommunicationInvocations({ teamId: 'team', revision: 3,
			profiles: { 'sdk:architect': definition }, sources: [{
				id: 'invocation', teamId: 'team', projectId: 'sdk', workdayId,
				agentId: 'architect', repository: 'treeseed-ai/sdk-library', commit: 'a'.repeat(40),
				path: 'discussions/test/messages/request.mdx', durationSeconds: 300,
			}] }).nodes[0]!;
		expect(project('conversation-invocation').id).not.toBe(project('conversation-invocation-retry-1').id);
	});

	it('fails closed when the addressed agent does not enable chat', () => {
		const noChat = { ...definition, activityProfiles: {} };
		expect(() => projectCommunicationInvocations({ teamId: 'team', revision: 1,
			profiles: { 'sdk:architect': noChat as never }, sources: [{ id: 'invocation', teamId: 'team', projectId: 'sdk',
				workdayId: 'conversation', agentId: 'architect', repository: 'library', commit: 'a'.repeat(40),
				path: 'message.mdx', durationSeconds: 60 }] })).toThrow(/does not enable chat/u);
	});
});
