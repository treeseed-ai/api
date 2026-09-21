import { describe, expect, it, vi } from 'vitest';
import { resolveProposalReviewDisposition, resolveReviewDisposition } from '../../../../../src/api/capacity/services/capacity/assignments/context/review-result.ts';

const digest = `sha256:${'a'.repeat(64)}`, candidateCommit = 'b'.repeat(40), decisionCommit = 'c'.repeat(40);
const result = {
	schemaVersion: 'treeseed.assignment-result/v1' as const, id: 'review-result', assignmentId: 'review-assignment',
	status: 'completed' as const, summary: 'Changes are required.',
	references: [{ kind: 'treedx' as const, projectId: 'project', repository: 'library', commit: decisionCommit,
		path: 'decisions/review-one.mdx', workspaceId: 'workspace' }], verification: [],
	usage: { elapsedSeconds: 1 }, diagnostics: [], completedAt: '2026-09-13T12:00:00.000Z',
};
const decision = {
	schemaVersion: 'treeseed.decision/v1', id: 'review-one', projectId: 'project', decisionClass: 'work-review',
	decisionMethod: 'authority', subjectRef: { store: 'git', model: 'source', id: 'candidate',
		repository: 'treeseed-ai/sdk', commit: candidateCommit }, disposition: 'request-changes',
	rationale: 'The focused test is missing.', authorityRefs: [{ store: 'treedx', model: 'proposal', id: 'proposal',
		revision: 1, digest }], decidedByRefs: [{ store: 'treedx', model: 'agent', id: 'sdk/reviewer', revision: 1, digest }],
	decidedAt: '2026-09-13T12:00:00.000Z',
};

describe('review result authority', () => {
	it('accepts only an exact classed decision bound to the actor candidate', async () => {
		const store = { first: vi.fn(async () => ({ pair_role: 'reviewer' })), all: vi.fn(async () => [{
			assignment_result_json: { ...result, id: 'actor-result', assignmentId: 'actor-assignment',
				references: [{ kind: 'git', repository: 'treeseed-ai/sdk', commit: candidateCommit }] },
		}]) };
		await expect(resolveReviewDisposition(store as never, { id: 'review-assignment', teamId: 'team', projectId: 'project',
			executionNodeId: 'reviewer', executionNodeRevision: 1 } as never, result, async () => decision))
			.resolves.toBe('request-changes');
		await expect(resolveReviewDisposition(store as never, { id: 'review-assignment', teamId: 'team', projectId: 'project',
			executionNodeId: 'reviewer', executionNodeRevision: 1 } as never, result, async () => ({ ...decision,
				subjectRef: { ...decision.subjectRef, commit: 'd'.repeat(40) } }))).rejects.toMatchObject({ code: 'review_decision_required' });
	});

	it('accepts the exact source only for a read-only actor with no produced candidate', async () => {
		const sourceRef = { store: 'git', model: 'repository', id: 'sdk-source', repository: 'treeseed-ai/sdk', commit: candidateCommit };
		const reviewed = { ...decision, disposition: 'approved', subjectRef: sourceRef };
		const assignment = { id: 'review-assignment', teamId: 'team', projectId: 'project',
			executionNodeId: 'reviewer', executionNodeRevision: 1 } as never;
		const readOnlyStore = { first: vi.fn(async () => ({ pair_role: 'reviewer' })), all: vi.fn(async () => [{
			assignment_result_json: { ...result, id: 'actor-result', assignmentId: 'actor-assignment', references: [] },
			workspace: 'read-only', source_ref_json: sourceRef,
		}]) };
		await expect(resolveReviewDisposition(readOnlyStore as never, assignment, result, async () => reviewed))
			.resolves.toBe('approved');

		const mutableStore = { ...readOnlyStore, all: vi.fn(async () => [{
			assignment_result_json: { ...result, id: 'actor-result', assignmentId: 'actor-assignment', references: [] },
			workspace: 'git', source_ref_json: sourceRef,
		}]) };
		await expect(resolveReviewDisposition(mutableStore as never, assignment, result, async () => reviewed))
			.rejects.toMatchObject({ code: 'review_candidate_reference_missing' });
	});

	it('accepts proposal review only when the decision binds the exact proposal source', async () => {
		const proposalRef = { store: 'treedx', model: 'proposal', id: 'proposal', revision: 2, digest,
			repository: 'library', commit: candidateCommit, path: 'proposals/proposal.mdx' };
		const store = { first: vi.fn(async () => ({ kind: 'reviewing', pair_role: null,
			source_ref_json: proposalRef })) };
		const proposalDecision = { ...decision, decisionClass: 'proposal', disposition: 'approved', subjectRef: proposalRef };
		await expect(resolveProposalReviewDisposition(store as never, { id: 'review-assignment', teamId: 'team',
			projectId: 'project', executionNodeId: 'reviewer', executionNodeRevision: 1 } as never,
			result, async () => ({ frontmatter: proposalDecision, source: 'exact decision bytes' }))).resolves.toMatchObject({
				disposition: 'approved', reference: result.references[0],
				sourceRef: { store: 'treedx', model: 'decision', id: proposalDecision.id,
					repository: result.references[0].repository, commit: result.references[0].commit },
			});
		await expect(resolveProposalReviewDisposition(store as never, { id: 'review-assignment', teamId: 'team',
			projectId: 'project', executionNodeId: 'reviewer', executionNodeRevision: 1 } as never,
			result, async () => ({ frontmatter: { ...proposalDecision, subjectRef: { ...proposalRef, revision: 1 } }, source: 'other bytes' })))
			.rejects.toMatchObject({ code: 'proposal_review_decision_required' });
	});
});
