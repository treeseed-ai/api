import { describe, expect, it, vi } from 'vitest';

const exactProposal = vi.hoisted(() => vi.fn());
vi.mock('../../../../../src/api/governance/executable-proposal.ts', () => ({ readExactProposal: exactProposal }));

import { loadTeamExecutableProposalSources } from '../../../../../src/api/capacity/services/capacity/execution/executable-proposal-source.ts';

describe('executable proposal source selection', () => {
	it('keeps pre-cutover accepted decisions as history without reading them as demand', async () => {
		const all = vi.fn(async () => [{
			proposal_id: 'legacy-proposal', project_id: 'project', active_version: 1,
			active_content_hash: 'a'.repeat(64), metadata_json: {}, decision_id: 'legacy-decision',
			accepted_decision_id: 'legacy-decision', decision_record_json: {},
		}]);
		await expect(loadTeamExecutableProposalSources({ all }, 'team', 'project')).resolves.toEqual([]);
		expect(all).toHaveBeenCalledWith(expect.stringContaining('AND p.project_id = ?'), ['team', 'project']);
	});

	it('quarantines an invalid accepted execution plan without admitting demand', async () => {
		const all = vi.fn(async () => [{
			proposal_id: 'invalid-proposal', project_id: 'project', active_version: 2,
			active_content_hash: 'a'.repeat(64), metadata_json: {}, decision_id: 'decision',
			accepted_decision_id: 'decision', proposal_version: 2,
			decision_record_json: { proposalRef: { id: 'invalid-proposal' } },
		}]);
		exactProposal.mockRejectedValueOnce(Object.assign(new Error('Invalid executable plan.'), {
			status: 422, code: 'proposal_execution_plan_invalid', diagnostics: [{ path: 'executionPlan' }],
		}));
		await expect(loadTeamExecutableProposalSources({ all }, 'team', 'project')).resolves.toEqual([]);
	});
});
