import type { GovernanceProposalReadiness } from '../../../../../governance/proposal-readiness.ts';
import { exactEntityReferenceSchema, type ExactEntityReference } from '@treeseed/sdk/agent-capacity';

type Row = Record<string, unknown>;

function record(value: unknown): Row {
	if (value && typeof value === 'object' && !Array.isArray(value)) return value as Row;
	if (typeof value === 'string') try { return record(JSON.parse(value)); } catch { return {}; }
	return {};
}

function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }

export interface ProposalPlanningSource {
	teamId: string;
	projectId: string;
	id: string;
	revision: number;
	digest: string;
	status: string;
	title: string;
	summary: string;
	body: string;
	repositoryId: string;
	path: string;
	commit: string;
	contentDigest: string;
	createdById: string | null;
	proposalTypes: string[];
	requiredParticipantIds: string[];
	requiredReviewerClasses: string[];
	readiness: GovernanceProposalReadiness;
	openBlockingFeedback: Array<{
		id: string;
		kind: 'concern' | 'question';
		message: string;
		contentPath: string;
		commit: string;
		digest: string;
	}>;
}

export interface BlockingProposalFeedback {
	id: string;
	kind: 'concern' | 'question';
	sourceRef: ExactEntityReference;
	message: string;
	contentPath: string;
	commit: string;
	digest: string;
	resolved: boolean;
}

/** Governance events index the current state of exact TreeDX feedback; they are
 * not a second content store. Keep resolved entries so graph conditions can
 * transition to completed instead of silently disappearing. */
export async function loadProposalBlockingFeedback(store: any, proposalId: string): Promise<BlockingProposalFeedback[]> {
	const feedbackRows = await store.all(`SELECT id,message,evidence_json FROM governance_events
		WHERE proposal_id = ? AND event_type = 'proposal.discussion' ORDER BY created_at ASC LIMIT 500`, [proposalId]);
	const resolved = new Set(feedbackRows.flatMap((event: Row) => {
		const evidence = record(event.evidence_json), ref = record(evidence.resolutionRef);
		const valid = exactEntityReferenceSchema.safeParse(ref);
		return text(evidence.resolvesEventId) && valid.success && valid.data.store === 'treedx'
			&& valid.data.model === 'discussion-message' ? [text(evidence.resolvesEventId)] : [];
	}));
	return feedbackRows.flatMap((event: Row) => {
		const evidence = record(event.evidence_json), kind = text(evidence.kind);
		if (!['concern', 'question'].includes(kind) || text(evidence.feedbackSeverity) === 'advisory') return [];
		const parsed = exactEntityReferenceSchema.safeParse(evidence.questionRef ?? evidence.decisionRef);
		if (!parsed.success || parsed.data.store !== 'treedx' || !['question', 'decision'].includes(parsed.data.model)) {
			throw Object.assign(new Error(`Proposal ${proposalId} blocking feedback ${text(event.id)} lacks exact TreeDX content authority.`), {
				status: 409, code: 'proposal_feedback_source_ref_missing', feedbackId: text(event.id),
			});
		}
		return [{ id: text(event.id), kind: kind as BlockingProposalFeedback['kind'], message: text(event.message),
			sourceRef: parsed.data,
			contentPath: text(evidence.contentPath), commit: text(evidence.commitSha), digest: text(evidence.digest),
			resolved: resolved.has(text(event.id)) }];
	});
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? [...new Set(value.map(text).filter(Boolean))].sort() : [];
}

/** Load proposal projections that still need planning activity. Proposal bytes remain
 * authoritative in TreeDX; PostgreSQL supplies only their current indexed projection. */
export async function loadTeamProposalPlanningSources(store: any, teamId: string, projectId?: string): Promise<ProposalPlanningSource[]> {
	const rows = await store.all(`SELECT id,team_id,project_id,status,title,summary,body,active_version,active_content_hash,created_by_id,metadata_json
		FROM governance_proposals WHERE team_id = ? AND status IN ('draft','submitted','open','voting')
		${projectId ? 'AND project_id = ?' : ''} ORDER BY project_id,id`, projectId ? [teamId, projectId] : [teamId]);
	const sources: ProposalPlanningSource[] = [];
	for (const row of rows) {
		const metadata = record(row.metadata_json), provenance = record(metadata.contentProvenance);
		const repositoryId = text(provenance.repositoryId), path = text(provenance.contentPath), commit = text(provenance.commitSha), contentDigest = text(provenance.digest);
		if (!repositoryId || !path || !/^[a-f0-9]{40}$/u.test(commit) || !contentDigest) continue;
		const readiness = await store.governanceProposalReadiness(text(row.id));
		if (!readiness) continue;
		const openBlockingFeedback = (await loadProposalBlockingFeedback(store, text(row.id)))
			.filter((feedback) => !feedback.resolved && feedback.contentPath && /^[a-f0-9]{40}$/u.test(feedback.commit) && feedback.digest);
		sources.push({ teamId: text(row.team_id), projectId: text(row.project_id), id: text(row.id), revision: Number(row.active_version),
			digest: text(row.active_content_hash), status: text(row.status), title: text(row.title), summary: text(row.summary), body: text(row.body),
			repositoryId, path, commit, contentDigest, createdById: text(row.created_by_id) || null,
			proposalTypes: strings(metadata.proposalTypes), requiredParticipantIds: strings(metadata.requiredParticipantIds),
			requiredReviewerClasses: strings(metadata.requiredReviewerClasses), readiness, openBlockingFeedback });
	}
	return sources;
}
