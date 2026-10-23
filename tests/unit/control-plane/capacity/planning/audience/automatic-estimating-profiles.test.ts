import { expect, it } from 'vitest';
import { automaticEstimatingProfiles } from '../automatic-estimating-native.ts';
import { compileWorkdayAgentProfileSnapshot } from '../../../../../../src/api/capacity/services/capacity/workdays/policy/workday-agent-profile-policy.ts';
import { workdayParticipants } from '../../../../../../src/api/capacity/policy/execution/workday-participants.ts';

it('current native estimation inputs select every model subscriber in one allocation class including the model named reporter', () => {
	const groupIds = ['portfolio-runtime'], profiles = automaticEstimatingProfiles(groupIds), before = structuredClone(profiles);
	const snapshot = compileWorkdayAgentProfileSnapshot([{ id: 'one-allocation', slug: 'maintenance', handlerRefs: { agents: profiles } }], undefined, groupIds);
	const expected = ['native-renamed/engineer', 'native-renamed/reporter', 'native-renamed/reviewer'];
	expect(snapshot.agents.map(entry => entry.definition.id)).toEqual(expected);
	const base = { groupIds, agentProfilesByProjectId: { project: snapshot } };
	for (const selected of [false, true]) {
		const participants = workdayParticipants({ ...base, proposalsByProjectId: selected
			? { project: [{ schemaVersion: 'treeseed.proposal/v2', id: 'proposal', groupIds, status: 'discussing' }] } : {} });
		expect(participants.filter(entry => entry.activity === 'planning').map(entry => entry.definition.id)).toEqual(expected);
		expect(participants.filter(entry => entry.activity === 'estimating').map(entry => entry.definition.id)).toEqual(selected ? expected : []);
		expect(new Set(participants.map(entry => entry.definition.agentClass))).toEqual(new Set(['maintenance']));
	}
	expect(profiles).toEqual(before);
});
