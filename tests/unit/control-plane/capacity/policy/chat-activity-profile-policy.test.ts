import { describe, expect, it } from 'vitest';
import { capacityWorkdayAgentsFromClasses } from '../../../../../src/api/capacity/services/capacity/workdays/policy/workday-agent-policy.ts';

describe('chat activity profile policy', () => {
	it('preserves provider-neutral execution and capability settings from the agent profile', () => {
		const capabilities = [{ capabilityId: 'treeseed.coordination.conversation', versionRange: '^1.0.0', requirement: 'required' }];
		const agents = capacityWorkdayAgentsFromClasses([{
			status: 'active',
			handlerRefs: { agents: [{
				slug: 'architect',
				activities: { chat: {
					enabled: true,
					handler: 'writer',
					prompt: { task: 'Inspect the exact project sources.' },
					capabilityRequirements: capabilities,
					execution: {
						reasoningEffort: 'medium', maxRuntimeSeconds: 180, maxTotalTokens: 32_000,
						warningTokens: 24_000, maxCostAmount: 5, costCurrency: 'USD',
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
