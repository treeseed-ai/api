import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { validateAgentDefinitionModel, type AgentDefinition } from '@treeseed/sdk/agent-capacity';
import { projectAgentActivityRefs } from '../../../../../src/api/capacity/services/projects/projects-core/project-agent-activity-refs.ts';

function configured(): AgentDefinition {
	return {
		schemaVersion: 'treeseed.agent/v1', id: 'configured/renamed-chat', name: 'Renamed chat', agentClass: 'renamed-chat',
		purpose: 'Inspect exact project sources.', responsibilities: ['Return evidence-backed answers.'],
		capabilities: ['architecture-analysis'], context: { include: ['project-objectives'] }, activityProfiles: { chat: {
			handler: 'writer',
			permissions: { content: { read: ['knowledge'], write: ['discussion'] }, tools: ['source.read'] },
			prompt: { system: 'Return the final reply; the provider publishes it under the assignment lease. Do not search for or invoke a discussion-write tool in the guest.' },
			parameters: {
				task: 'Inspect the exact project sources.',
				capabilityRequirements: [{ capabilityId: 'treeseed.coordination.conversation', versionRange: '^1.0.0', requirement: 'required' }],
				execution: { reasoningEffort: 'medium', maxRuntimeSeconds: 180, maxTotalTokens: 32_000,
					warningTokens: 24_000, maxCostAmount: 5, costCurrency: 'USD' },
			},
		} },
	};
}

describe('chat activity profile policy', () => {
	it('uses only governed canonical activity profiles rather than retired default prompts authority presets and assignment intent reconstruction', () => {
		for (const path of [
			'src/api/capacity/policy/workdays/chat-activity-profile.ts',
			'src/api/capacity/policy/authority/agent-authority-presets.ts',
			'src/api/capacity/services/capacity/workdays/policy/workday-agent-policy.ts',
		]) expect(existsSync(path), path).toBe(false);
		const remaining = readFileSync('src/api/capacity/services/capacity/workdays/assignments/workday-assignment-context-service.ts', 'utf8');
		expect(remaining).not.toContain('resolveCapacityWorkdayAssignmentIntent');
		expect(remaining).not.toContain('workday-agent-policy');
	});
	it('never grants retired TreeDX assignment content or operational tools', () => {
		const definition = configured(), before = structuredClone(definition);
		const parsed = validateAgentDefinitionModel(definition); expect(parsed.ok).toBe(true);
		const profile = parsed.data?.activityProfiles.chat; expect(profile).toBeDefined();
		if (!profile) throw new Error('Canonical configured chat profile required');
		const authority = projectAgentActivityRefs({ agents: [definition] }, 'chat');
		expect(authority).toHaveLength(1); expect(authority[0]!.profile).toEqual(profile);
		expect(profile.prompt.system).toContain('the provider publishes it under the assignment lease');
		expect(profile.prompt.system).toContain('Do not search for or invoke a discussion-write tool in the guest');
		const retired = /assignment_(?:plan|status|summary)/u;
		expect([...profile.permissions.content.read, ...profile.permissions.content.write]).not.toEqual(expect.arrayContaining([
			'assignment_plan', 'assignment_status', 'assignment_summary',
		]));
		expect(profile.permissions.tools.filter(tool => retired.test(tool))).toEqual([]);
		expect(authority[0]!.profile.permissions).toEqual(profile.permissions);
		expect(definition).toEqual(before);
	});
	it('preserves provider-neutral execution and capability settings from the agent profile', () => {
		const definition = configured(), before = structuredClone(definition);
		const agents = projectAgentActivityRefs({ agents: [definition] }, 'chat');
		expect(agents).toHaveLength(1);
		expect(agents[0]!.profile.parameters).toEqual({
			task: 'Inspect the exact project sources.',
			capabilityRequirements: [{ capabilityId: 'treeseed.coordination.conversation', versionRange: '^1.0.0', requirement: 'required' }],
			execution: { reasoningEffort: 'medium', maxRuntimeSeconds: 180, maxTotalTokens: 32_000,
				warningTokens: 24_000, maxCostAmount: 5, costCurrency: 'USD' },
		});
		expect(agents[0]!.handlerId).toBe('writer'); expect(agents[0]!.agentId).toBe('configured/renamed-chat');
		expect(definition).toEqual(before);
	});
});
