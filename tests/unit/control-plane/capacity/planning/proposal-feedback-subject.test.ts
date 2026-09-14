import { describe, expect, it, vi } from 'vitest';
import { resolveProposalFeedbackSubject, reviewedProposalVersion } from '../../../../../src/api/capacity/services/capacity/assignments/planning/feedback/subject.ts';
import { assignmentActivityInput } from '../../../../../src/api/capacity/services/capacity/assignments/planning/assignment-planning-output-service.ts';
import { governanceProposalReadinessMethod } from '../../../../../src/api/store/governance/policy/contracts/governance-proposal-readiness.ts';
import type { ControlPlaneStore } from '../../../../../src/api/persistence/store.ts';
import type { DurableProviderAssignment } from '../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';

const assignment = { id: 'assignment-1', teamId: 'team-1', projectId: 'project-1' };
function fixture(id = '48d5429f-4882-4e89-824e-1866e70e7adb') {
	const proposal = { id, teamId: assignment.teamId, projectId: assignment.projectId, activeVersion: 4 };
	const store = { getGovernanceProposal: vi.fn(async (key: string) => key === id ? proposal : null),
		all: vi.fn(async () => [{ id }]) };
	return { proposal, store };
}

describe('planning assignment envelope custody', () => {
	it('binds living-graph output to the inner immutable activity input', () => {
		const durable = {
			decisionInput: { input: { decisionInput: { input: {
				executionNodeId: 'node-1',
				proposalRef: { id: 'proposal-1', revision: 3, digest: 'd'.repeat(64) },
			} } } },
		} as unknown as DurableProviderAssignment;
		expect(assignmentActivityInput(durable)).toMatchObject({
			executionNodeId: 'node-1',
			proposalRef: { id: 'proposal-1', revision: 3, digest: 'd'.repeat(64) },
		});
	});

	it('keeps direct planning inputs intact', () => {
		const durable = { decisionInput: { input: { planningInputRequestId: 'request-1' } } } as unknown as DurableProviderAssignment;
		expect(assignmentActivityInput(durable)).toEqual({ planningInputRequestId: 'request-1' });
	});
});

describe('planning feedback subject custody', () => {
	it.each(['48d5429f-4882-4e89-824e-1866e70e7adb', 'proposal:project-1:document-workspace'])('preserves exact existing ID %s', async id => {
		const { proposal, store } = fixture(id);
		expect(await resolveProposalFeedbackSubject(store, assignment, id)).toBe(proposal);
		expect(store.all).not.toHaveBeenCalled();
	});
	it.each(['document-workspace', 'proposal:document-workspace', 'proposals/governance/document-workspace.mdx'])('resolves scoped content subject %s without a synthetic ID', async subject => {
		const { proposal, store } = fixture();
		expect(await resolveProposalFeedbackSubject(store, assignment, subject)).toBe(proposal);
		expect(store.all).toHaveBeenCalledWith(expect.stringContaining('team_id = ? AND project_id = ?'), ['team-1', 'project-1', 'document-workspace']);
	});
	it.each(['teamId', 'projectId'] as const)('denies exact ID from another %s without falling back', async field => {
		const { proposal, store } = fixture(); proposal[field] = 'foreign';
		await expect(resolveProposalFeedbackSubject(store, assignment, proposal.id)).rejects.toMatchObject({ code: 'assignment_proposal_feedback_scope_invalid' });
		expect(store.all).not.toHaveBeenCalled();
	});
	it.each([0, 2])('rejects %i matching slugs', async count => {
		const { store } = fixture(); store.all.mockResolvedValue(Array.from({ length: count }, (_, i) => ({ id: `proposal-${i}` })));
		await expect(resolveProposalFeedbackSubject(store, assignment, 'document-workspace')).rejects.toMatchObject({ code: 'assignment_proposal_feedback_scope_invalid' });
	});
	it('rechecks custody after slug resolution', async () => {
		const { proposal, store } = fixture(); proposal.teamId = 'foreign';
		await expect(resolveProposalFeedbackSubject(store, assignment, 'document-workspace')).rejects.toMatchObject({ code: 'assignment_proposal_feedback_scope_invalid' });
	});
	it('rejects empty subjects without querying', async () => {
		const { store } = fixture();
		await expect(resolveProposalFeedbackSubject(store, assignment, ' ')).rejects.toMatchObject({ code: 'assignment_proposal_feedback_scope_invalid' });
		expect(store.getGovernanceProposal).not.toHaveBeenCalled(); expect(store.all).not.toHaveBeenCalled();
	});
});

describe('feedback revision custody', () => {
	const path = 'proposals/governance/task.mdx', commitSha = 'a'.repeat(40);
	const proposal = { activeVersion: 4, metadata: { contentProvenance: { contentPath: path, commitSha } } };
	const artifact = { model: 'proposal', contentPath: path, commitSha };
	it('records the reviewed version from exact assigned evidence', () => {
		expect(reviewedProposalVersion({ ...assignment, decisionInput: { input: { intent: { relatedArtifact: artifact } } } }, proposal)).toBe(4);
	});
	it('accepts unchanged proposal bytes after unrelated library commits', () => {
		const digest = 'b'.repeat(64);
		expect(reviewedProposalVersion({ ...assignment, decisionInput: { input: { intent: { relatedArtifact: { ...artifact, commitSha: 'c'.repeat(40), digest } } } } },
			{ ...proposal, metadata: { contentProvenance: { contentPath: path, commitSha, digest } } })).toBe(4);
	});
	it.each([undefined, { ...artifact, commitSha: 'b'.repeat(40) }, { ...artifact, contentPath: 'proposals/other.mdx' }, { ...artifact, model: 'objective' }])('rejects stale, absent or unrelated evidence', relatedArtifact => {
		expect(() => reviewedProposalVersion({ ...assignment, decisionInput: { input: { intent: { relatedArtifact } } } }, proposal)).toThrow('current immutable proposal revision');
	});
});

describe('human proposal review freshness', () => {
	it.each([undefined, 3, 4])('counts only current review version %s even without an agent participation snapshot', async proposalVersion => {
		const store = { getGovernanceProposal: async () => ({ id: 'human-proposal', projectId: 'project-1', activeVersion: 4, createdById: 'author', metadata: {} }),
			first: async () => null,
			all: async (query: string) => query.includes('FROM governance_events') ? [{ id: 'review-1', actor_id: 'independent-reviewer', event_type: 'proposal.discussion', evidence_json: { kind: 'support', proposalVersion } }] : [] };
		const readiness = await governanceProposalReadinessMethod.call(store as unknown as ControlPlaneStore, 'human-proposal');
		expect(readiness?.independentReviewCount).toBe(proposalVersion === 4 ? 1 : 0);
	});
	it('does not treat retired proposal signals as review authority', async () => {
		const store = { getGovernanceProposal: async () => ({ id: 'human-proposal', projectId: 'project-1', activeVersion: 4, createdById: 'author', metadata: {} }),
			first: async () => null,
			all: async () => [] };
		const readiness = await governanceProposalReadinessMethod.call(store as unknown as ControlPlaneStore, 'human-proposal');
		expect(readiness?.independentReviewCount).toBe(0);
	});
	it('accepts only an accepted graph plan bound to the current proposal revision and digest', async () => {
		const digest = 'd'.repeat(64);
		const store = {
			getGovernanceProposal: async () => ({ id: 'human-proposal', teamId: 'team-1', projectId: 'project-1', activeVersion: 4,
				activeContentHash: digest, createdById: 'author', metadata: {} }),
			all: async () => [],
			first: async () => ({ node_json: { proposalRef: { revision: 4, digest } } }),
		};
		const readiness = await governanceProposalReadinessMethod.call(store as unknown as ControlPlaneStore, 'human-proposal');
		expect(readiness?.missingVoting).not.toContain('exact accepted execution plan');
	});
});
