import { CapacityGovernanceError } from '../../../../../database.ts';
import type { AssignmentPlanningOutputStore } from '../assignment-planning-output-service.ts';

type Scope = { id: string; teamId: string; projectId: string };
type Store = Pick<AssignmentPlanningOutputStore, 'getGovernanceProposal' | 'all'>;

/** Resolve custody of an existing proposal; human and agent IDs are equally authoritative. */
export async function resolveProposalFeedbackSubject(store: Store, assignment: Scope, subject: string) {
	const invalid = () => new CapacityGovernanceError('assignment_proposal_feedback_scope_invalid',
		'Proposal feedback requires one existing proposal in the assignment team and project.', 409,
		{ assignmentId: assignment.id });
	if (!subject.trim()) throw invalid();
	let proposal = await store.getGovernanceProposal(subject.trim());
	if (!proposal) {
		const contentSlug = subject.trim().replace(/^proposal:/u, '').replace(/^.*\//u, '').replace(/\.(?:md|mdx)$/iu, '');
		const matches = await store.all(`SELECT id FROM governance_proposals WHERE team_id = ? AND project_id = ? AND content_proposal_slug = ? LIMIT 2`,
			[assignment.teamId, assignment.projectId, contentSlug]);
		if (matches.length !== 1) throw invalid();
		proposal = await store.getGovernanceProposal(String(matches[0].id));
	}
	if (!proposal || proposal.teamId !== assignment.teamId || proposal.projectId !== assignment.projectId) throw invalid();
	return proposal;
}
