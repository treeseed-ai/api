import { describe, expect, it, vi } from 'vitest';

const exactProposal = vi.hoisted(() => vi.fn());
vi.mock('../../../../../../src/api/governance/executable-proposal.ts', async (importOriginal) => ({
	...await importOriginal<typeof import('../../../../../../src/api/governance/executable-proposal.ts')>(),
	readExactProposal: exactProposal,
}));

import { loadTeamExecutableProposalSources } from '../../../../../../src/api/capacity/services/capacity/execution/executable-proposal-source.ts';
import { loadProposalBlockingFeedback } from '../../../../../../src/api/capacity/services/capacity/execution/proposal-planning-source.ts';

const questionRef = { store: 'treedx', model: 'question', id: 'question', revision: 1,
	digest: `sha256:${'c'.repeat(64)}`, repository: 'repository', commit: 'b'.repeat(40), path: 'questions/question.mdx' };

describe('executable proposal source selection', () => {
	it('does not clear a graph blocker from a database-only resolution', async () => {
		const all = vi.fn(async () => [
			{ id: 'question', evidence_json: { kind: 'question', questionRef, feedbackStatus: 'open' } },
			{ id: 'answer', evidence_json: { kind: 'response', resolvesEventId: 'question', feedbackStatus: 'resolved' } },
		]);
		await expect(loadProposalBlockingFeedback({ all }, 'proposal')).resolves.toMatchObject([
			{ id: 'question', resolved: false },
		]);
	});
	it('refuses a blocking question with no exact TreeDX source', async () => {
		const all = vi.fn(async () => [{ id: 'question', evidence_json: { kind: 'question' } }]);
		await expect(loadProposalBlockingFeedback({ all }, 'proposal')).rejects.toMatchObject({
			code: 'proposal_feedback_source_ref_missing', feedbackId: 'question',
		});
	});
	it('clears a graph blocker only from an exact TreeDX resolution reference', async () => {
		const all = vi.fn(async () => [
			{ id: 'question', evidence_json: { kind: 'question', questionRef, feedbackStatus: 'open' } },
			{ id: 'answer', evidence_json: { kind: 'response', resolvesEventId: 'question', resolutionRef: {
				store: 'treedx', model: 'discussion-message', id: 'answer', revision: 1, repository: 'repository',
				path: 'discussion-messages/answer.mdx', commit: 'b'.repeat(40), digest: `sha256:${'c'.repeat(64)}`,
			} } },
		]);
		await expect(loadProposalBlockingFeedback({ all }, 'proposal')).resolves.toMatchObject([
			{ id: 'question', resolved: true },
		]);
	});
	it('includes a complete draft and preserves governed feedback transitions', async () => {
		const all = vi.fn(async (query: string) => query.includes('FROM governance_events') ? [{
			id: 'question-1', message: 'Resolve the boundary.', evidence_json: { kind: 'question', questionRef, feedbackStatus: 'open' },
		}] : [{ proposal_id: 'proposal', project_id: 'project', active_version: 1,
			active_content_hash: 'a'.repeat(64), metadata_json: {}, decision_id: null }]);
		exactProposal.mockResolvedValueOnce({ ref: { repository: 'treeseed-ai/sdk', path: 'proposals/one.md',
			commit: 'b'.repeat(40), digest: `sha256:${'a'.repeat(64)}` }, definition: {
			status: 'draft', executionPlan: { workItems: [{ estimate: { minimumSeconds: 10 },
				review: 'required', reviewEstimate: { minimumSeconds: 5 } }] },
		} });
		const sources = await loadTeamExecutableProposalSources({ all }, 'team', 'project');
		expect(sources).toHaveLength(1);
		expect(sources[0]).toMatchObject({ decision: null, feedback: [{ id: 'question-1', resolved: false }] });
	});

	it('keeps an incomplete draft in planning rather than executable graph demand', async () => {
		const all = vi.fn(async () => [{ proposal_id: 'proposal', project_id: 'project', active_version: 1,
			active_content_hash: 'a'.repeat(64), metadata_json: {}, decision_id: null }]);
		exactProposal.mockResolvedValueOnce({ ref: {}, definition: { status: 'draft', executionPlan: { workItems: [{ review: 'required' }] } } });
		await expect(loadTeamExecutableProposalSources({ all }, 'team', 'project')).resolves.toEqual([]);
	});
	it('keeps pre-cutover accepted decisions as history without reading them as demand', async () => {
		const all = vi.fn(async () => [{
			proposal_id: 'legacy-proposal', project_id: 'project', active_version: 1,
			active_content_hash: 'a'.repeat(64), metadata_json: {}, decision_id: 'legacy-decision',
			accepted_decision_id: 'legacy-decision', decision_record_json: {},
		}]);
		await expect(loadTeamExecutableProposalSources({ all }, 'team', 'project')).resolves.toEqual([]);
		expect(all).toHaveBeenCalledWith(expect.stringContaining('AND p.project_id = ?'), ['team', 'project']);
		expect(all).toHaveBeenCalledWith(expect.stringContaining("p.status IN ('draft','submitted','open','voting')"), ['team', 'project']);
	});
	it('keeps a terminal exact accepted revision as history without reloading obsolete content', async () => {
		const exactReadsBefore = exactProposal.mock.calls.length;
		const all = vi.fn(async (query: string) => query.includes('FROM execution_nodes') ? [{
			source_ref_json: { model: 'proposal', id: 'settled-proposal', digest: `sha256:${'a'.repeat(64)}` },
			status: 'completed',
		}] : [{
			proposal_id: 'settled-proposal', project_id: 'project', active_version: 4,
			active_content_hash: 'a'.repeat(64), metadata_json: {}, decision_id: 'decision',
			accepted_decision_id: 'decision', proposal_version: 4,
			decision_record_json: { proposalRef: { id: 'settled-proposal' } },
		}]);
		await expect(loadTeamExecutableProposalSources({ all }, 'team', 'project')).resolves.toEqual([]);
		expect(exactProposal.mock.calls).toHaveLength(exactReadsBefore);
	});

	it('keeps a failed accepted revision in the living graph for bounded revision', async () => {
		const proposalRef = { id: 'revision-proposal', repository: 'treeseed-ai/sdk', path: 'proposals/revision.md',
			commit: 'b'.repeat(40), digest: `sha256:${'a'.repeat(64)}` };
		const all = vi.fn(async (query: string) => query.includes('FROM execution_nodes') ? [{
			source_ref_json: { model: 'proposal', id: proposalRef.id, digest: proposalRef.digest }, status: 'failed',
		}] : query.includes('FROM governance_events') ? [] : [{
			proposal_id: proposalRef.id, project_id: 'project', active_version: 2,
			active_content_hash: 'a'.repeat(64), metadata_json: {}, decision_id: 'decision',
			accepted_decision_id: 'decision', proposal_version: 2,
			decision_record_json: { proposalRef },
		}]);
		exactProposal.mockResolvedValueOnce({ ref: proposalRef, definition: {
			status: 'accepted', executionPlan: { workItems: [{ estimate: { minimumSeconds: 10 },
				review: 'required', reviewEstimate: { minimumSeconds: 5 } }] },
		} });
		await expect(loadTeamExecutableProposalSources({ all }, 'team', 'project')).resolves.toMatchObject([{
			projectId: 'project', decision: { id: 'decision' },
		}]);
	});

	it('fails closed on an invalid accepted execution plan without mutating its graph', async () => {
		const all = vi.fn(async (query: string) => query.includes('FROM execution_nodes') ? [{
			source_ref_json: { model: 'proposal', id: 'invalid-proposal', digest: `sha256:${'a'.repeat(64)}` },
			status: 'ready',
		}] : [{
			proposal_id: 'invalid-proposal', project_id: 'project', active_version: 2,
			active_content_hash: 'a'.repeat(64), metadata_json: {}, decision_id: 'decision',
			accepted_decision_id: 'decision', proposal_version: 2,
			decision_record_json: { proposalRef: { id: 'invalid-proposal' } },
		}]);
		exactProposal.mockRejectedValueOnce(Object.assign(new Error('Invalid executable plan.'), {
			status: 422, code: 'proposal_execution_plan_invalid', diagnostics: [{ path: 'executionPlan' }],
		}));
		await expect(loadTeamExecutableProposalSources({ all }, 'team', 'project')).rejects.toMatchObject({
			code: 'proposal_execution_plan_invalid', diagnostics: [{ path: 'executionPlan' }],
		});
	});
});
