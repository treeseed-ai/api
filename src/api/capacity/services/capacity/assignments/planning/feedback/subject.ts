import { CapacityGovernanceError } from '../../../../../database.ts';
import type { AssignmentPlanningOutputStore } from '../assignment-planning-output-service.ts';

type Scope = { id: string; teamId: string; projectId: string };
type Store = Pick<AssignmentPlanningOutputStore, 'getGovernanceProposal' | 'all'>;

function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

/** Feedback must refer to the proposal revision actually placed in the assignment context. */
export function reviewedProposalVersion(assignment: Scope & { decisionInput?: unknown }, proposal: Record<string, unknown>) {
	const intent = record(record(record(assignment.decisionInput).input).intent);
	const artifacts = [intent.relatedArtifact, ...(Array.isArray(intent.relatedArtifacts) ? intent.relatedArtifacts : [])].map(record);
	const provenance = record(record(proposal.metadata).contentProvenance);
	const version = Number(proposal.activeVersion);
	if (!Number.isSafeInteger(version) || version < 1 || typeof provenance.commitSha !== 'string'
		|| !/^[a-f0-9]{40}$/u.test(provenance.commitSha) || !artifacts.some(artifact => artifact.model === 'proposal'
			&& artifact.contentPath === provenance.contentPath && typeof artifact.commitSha === 'string' && /^[a-f0-9]{40}$/u.test(artifact.commitSha)
			&& (artifact.commitSha === provenance.commitSha || (typeof provenance.digest === 'string' && /^[a-f0-9]{64}$/u.test(provenance.digest) && artifact.digest === provenance.digest)))) {
		throw new CapacityGovernanceError('assignment_proposal_feedback_revision_stale',
			'Proposal feedback was not produced from the current immutable proposal revision.', 409, { assignmentId: assignment.id });
	}
	return version;
}

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
