import { describe,expect,it } from 'vitest';
import { agentLabAuthorityScope } from '../../../../src/operations-runner/agent-lab/simulation-executor.ts';

describe('Agent Lab operation authority handoff', () => {
	it('preserves exact API-owned team and project identifiers', () => {
		expect(agentLabAuthorityScope({ teamId: ' team-1 ', projectId: ' project-1 ' }))
			.toEqual({ teamId: 'team-1', projectId: 'project-1' });
	});

	it('fails closed when either authoritative identifier is absent', () => {
		expect(() => agentLabAuthorityScope({ teamId: 'team-1' })).toThrow(/authoritative team and project scope/u);
		expect(() => agentLabAuthorityScope({ projectId: 'project-1' })).toThrow(/authoritative team and project scope/u);
	});
});
