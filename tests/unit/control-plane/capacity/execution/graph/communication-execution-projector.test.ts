import { describe, expect, it } from 'vitest';
import { calculateAssignmentAllocation } from '@treeseed/sdk/agent-capacity';
import { projectCommunicationInvocations } from '../../../../../../src/api/capacity/policy/execution/communication-execution-projector.ts';

const definition = {
	schemaVersion: 'treeseed.agent/v1' as const, id: 'sdk/architect', name: 'SDK Architect', agentClass: 'architect',
	purpose: 'Explain and guide SDK architecture.', responsibilities: ['Answer bounded SDK questions.'],
	capabilities: ['reasoning'], context: { include: ['project-objectives'] },
	activityProfiles: { chat: { handler: 'writer', permissions: {
		content: { read: ['discussion'], write: ['discussion'] }, tools: ['discussion'],
	}, prompt: { system: 'Research the authorized context and answer with evidence.' } } },
};

describe('communication living-graph projection', () => {
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
			estimate: { minimumSeconds: 90, expectedSeconds: 300, maximumSeconds: 300 },
			requiredCapabilities: ['treeseed.coordination.conversation'],
			sourceRef: expect.objectContaining({ model: 'discussion', path: 'discussions/test/messages/request.mdx' }),
		})]);
		expect(projected.changedSourceRefs).toEqual([projected.nodes[0]!.sourceRef]);
		expect(calculateAssignmentAllocation({ estimate: projected.nodes[0]!.estimate!, measurements: [],
			constraints: [{ id: 'utc-day-window', remainingSeconds: 11 }] })).toEqual(expect.objectContaining({
			admitted: false, minimumSeconds: 90, allocatedSeconds: 0, limitingConstraint: 'utc-day-window',
		}));
	});

	it('keeps the viable minimum within a shorter requested duration', () => {
		const projected = projectCommunicationInvocations({ teamId: 'team', revision: 3,
			profiles: { 'sdk:architect': definition }, sources: [{
				id: 'invocation', teamId: 'team', projectId: 'sdk', workdayId: 'conversation-invocation',
				agentId: 'architect', repository: 'treeseed-ai/sdk-library', commit: 'a'.repeat(40),
				path: 'discussions/test/messages/request.mdx', durationSeconds: 30,
			}] });
		expect(projected.nodes[0]?.estimate).toEqual({ minimumSeconds: 30, expectedSeconds: 30, maximumSeconds: 30 });
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
