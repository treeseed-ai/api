import { describe, expect, it, vi } from 'vitest';

const exactProposal = vi.hoisted(() => vi.fn());
vi.mock('../../../../../../src/api/governance/executable-proposal.ts', async (importOriginal) => ({
	...await importOriginal<typeof import('../../../../../../src/api/governance/executable-proposal.ts')>(),
	readExactProposal: exactProposal,
}));

import { loadTeamExecutableProposalSources } from '../../../../../../src/api/capacity/services/capacity/execution/executable-proposal-source.ts';
import { loadProposalBlockingFeedback } from '../../../../../../src/api/capacity/services/capacity/execution/proposal-planning-source.ts';
import { reconcileExecutionGraph } from '../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-service.ts';

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
	it('freezes an already-materialized invalid accepted component with no ready work', async () => {
		const all = vi.fn(async (query: string) => query.includes('FROM execution_nodes') ? [{
			source_ref_json: { model: 'proposal', id: 'historical', digest: `sha256:${'a'.repeat(64)}` },
			status: 'blocked',
		}] : [{
			proposal_id: 'historical', project_id: 'project', active_version: 1,
			active_content_hash: 'a'.repeat(64), decision_id: 'decision', accepted_decision_id: 'decision',
			decision_record_json: { proposalRef: { id: 'historical' } },
		}]);
		exactProposal.mockRejectedValueOnce(Object.assign(new Error('Legacy proposal schema is invalid.'), {
			status: 422, code: 'proposal_execution_plan_invalid',
		}));
		const frozen: Array<{ id: string; digest: string }> = [];
		await expect(loadTeamExecutableProposalSources({ all }, 'team', undefined, (source) => frozen.push(source)))
			.resolves.toEqual([]);
		expect(frozen).toEqual([{ id: 'historical', digest: `sha256:${'a'.repeat(64)}` }]);
	});
	it('treats ready nodes from a cancelled simulation as non-admissible historical state', async () => {
		const row = { proposal_id: 'old', project_id: 'project', active_version: 1,
			active_content_hash: 'a'.repeat(64), accepted_decision_id: 'decision',
			decision_record_json: { proposalRef: { id: 'old' } } };
		const all = vi.fn(async (query: string) => query.includes('FROM execution_nodes') ? [{
			source_ref_json: { model: 'proposal', id: 'old', digest: `sha256:${'a'.repeat(64)}` },
			status: 'ready', workday_id: 'stopped', workday_status: 'cancelled',
		}] : [row]);
		exactProposal.mockRejectedValueOnce(Object.assign(new Error('Invalid old content.'), {
			status: 422, code: 'proposal_execution_plan_invalid',
		}));
		const frozen: string[] = [];
		await expect(loadTeamExecutableProposalSources({ all }, 'team', undefined, (source) => frozen.push(source.id)))
			.resolves.toEqual([]);
		expect(frozen).toEqual(['old']);
	});
	it('refuses to freeze invalid accepted content with an active ready assignment', async () => {
		const all = vi.fn(async (query: string) => query.includes('FROM execution_nodes') ? [{
			source_ref_json: { model: 'proposal', id: 'active', digest: `sha256:${'a'.repeat(64)}` },
			status: 'ready', workday_id: 'running', workday_status: 'running',
		}] : [{ proposal_id: 'active', project_id: 'project', active_version: 1,
			active_content_hash: 'a'.repeat(64), accepted_decision_id: 'decision',
			decision_record_json: { proposalRef: { id: 'active' } } }]);
		exactProposal.mockRejectedValueOnce(Object.assign(new Error('Invalid active content.'), {
			status: 422, code: 'proposal_execution_plan_invalid',
		}));
		await expect(loadTeamExecutableProposalSources({ all }, 'team', undefined, () => undefined))
			.rejects.toMatchObject({ code: 'proposal_execution_plan_invalid' });
	});
	it('retains a blocked historical component during ordinary team reconciliation', async () => {
		const source = { store: 'treedx', model: 'proposal', id: 'historical', revision: 1,
			digest: `sha256:${'a'.repeat(64)}`, repository: 'library', commit: 'b'.repeat(40), path: 'proposals/old.mdx' };
		const all = vi.fn(async (query: string) => {
			if (query.includes('FROM governance_proposals')) return [{ proposal_id: 'historical', project_id: 'project',
				active_version: 1, active_content_hash: 'a'.repeat(64), accepted_decision_id: 'decision',
				decision_record_json: { proposalRef: { id: 'historical' } } }];
			if (query.includes('FROM execution_nodes')) return [{ id: 'old-condition', team_id: 'team', project_id: 'project',
				kind: 'condition', pair_role: null, source_ref_json: source, authority_refs_json: [], rule_revision: 1,
				node_revision: 1, status: 'blocked', condition_json: { conditionType: 'authority', subjectRef: source,
					expectedState: 'accepted' }, graph_revision_created: 1, graph_revision_updated: 1 }];
			return [];
		});
		exactProposal.mockRejectedValueOnce(Object.assign(new Error('Legacy proposal schema is invalid.'), {
			status: 422, code: 'proposal_execution_plan_invalid',
		}));
		const store = { all, first: vi.fn(async () => ({ revision: 1, graph_digest: `sha256:${'b'.repeat(64)}` })) };
		const planned = await reconcileExecutionGraph(store, 'team', { plan: true });
		expect(planned).toMatchObject({ changes: { stale: [], added: [] } });
		expect(all).toHaveBeenCalledWith(expect.stringContaining('FROM governance_proposals'), ['team']);
	});
});
