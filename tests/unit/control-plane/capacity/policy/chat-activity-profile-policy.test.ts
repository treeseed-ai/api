import { describe, expect, it } from 'vitest';
import { capacityWorkdayAgentsFromClasses } from '../../../../../src/api/capacity/services/capacity/workdays/policy/workday-agent-policy.ts';
import { compileDefaultChatActivityProfile } from '../../../../../src/api/capacity/policy/workdays/chat-activity-profile.ts';
import { compileAgentAuthoritySnapshot } from '../../../../../src/api/capacity/policy/authority/agent-authority-presets.ts';

describe('chat activity profile policy', () => {
	it('never grants retired TreeDX assignment content or operational tools', () => {
		const profile = compileDefaultChatActivityProfile('sdk/architect');
		const authority = compileAgentAuthoritySnapshot('chat', profile);
		const retired = /assignment_(?:plan|status|summary)/u;
		expect(Object.keys(profile.permissions?.content ?? {})).not.toEqual(expect.arrayContaining([
			'assignment_plan', 'assignment_status', 'assignment_summary',
		]));
		expect(profile.tools?.allowed?.filter((tool) => retired.test(tool))).toEqual([]);
		expect(authority.tools.allowed.filter((tool) => retired.test(tool))).toEqual([]);
	});

	it('preserves provider-neutral execution and capability settings from the agent profile', () => {
		const capabilities = [{ capabilityId: 'treeseed.coordination.conversation', versionRange: '^1.0.0', requirement: 'required' }];
		const agents = capacityWorkdayAgentsFromClasses([{
			status: 'active',
			handlerRefs: { agents: [{
				schemaVersion: 'treeseed.agent/v1', id: 'sdk/architect', name: 'Architect', agentClass: 'architect',
				purpose: 'Inspect exact project sources.', responsibilities: ['Return evidence-backed answers.'],
				capabilities: ['architecture-analysis'], context: { include: ['project-objectives'] },
				activityProfiles: { chat: {
					handler: 'writer',
					permissions: { content: { read: ['knowledge'], write: ['discussion'] }, tools: ['source.read'] },
					prompt: { system: 'Inspect the exact project sources.' },
					parameters: {
						task: 'Inspect the exact project sources.', capabilityRequirements: capabilities,
						execution: { reasoningEffort: 'medium', maxRuntimeSeconds: 180, maxTotalTokens: 32_000,
							warningTokens: 24_000, maxCostAmount: 5, costCurrency: 'USD' },
					},
				} },
			}] },
		}]);
		const chat = agents.find((agent) => agent.activityType === 'chat');
		expect(chat?.promptTask).toBe('Inspect the exact project sources.');
		expect(chat?.execution).toMatchObject({
			reasoningEffort: 'medium', maxRuntimeSeconds: 180, maxTotalTokens: 32_000,
			warningTokens: 24_000, maxCostAmount: 5, costCurrency: 'USD',
		});
		expect(chat?.capabilityRequirements).toEqual(capabilities);
	});
});
