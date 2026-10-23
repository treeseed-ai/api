import { describe, expect, it } from 'vitest';
import { validatePortableContentData } from '@treeseed/sdk/content-validation';
import { validateAgentDefinitionModel } from '@treeseed/sdk/agent-capacity';
import { graphProfiles } from '../../../capacity/execution/graph/architecture/living/living-graph-fixture.ts';
import { nativeSubscriberInputs } from './native-subscriber-inputs.ts';

describe('current native governance input contracts', () => {
	it.each([false, true])('supplies valid distinct group contributions and exact model profiles, canonical supply %s', canonicalSupply => {
		const input = nativeSubscriberInputs(graphProfiles(), 'project', 'proposal', canonicalSupply);
		expect(validatePortableContentData('proposal', input.declaration)).toMatchObject({ ok: true });
		for (const { definition } of input.profileInputs) expect(validateAgentDefinitionModel(definition)).toMatchObject({ ok: true, diagnostics: [] });
		expect(input.subscribers.map(profile => profile.definition.groupIds)).toEqual([['portfolio-runtime'], ['portfolio-runtime']]);
		expect(input.declaration.executionPlan.workItems.map(item => item.estimateRef.id)).toEqual(['controlled-estimate-proposal-0', 'controlled-estimate-proposal-1']);
		for (const item of input.declaration.executionPlan.workItems) expect(item).not.toHaveProperty('agentClass');
	});
});
