import type { GovernanceProposalReadiness } from '../../../../../governance/proposal-readiness.ts';

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
		const feedbackRows = await store.all(`SELECT id,message,evidence_json FROM governance_events
			WHERE proposal_id = ? AND event_type = 'proposal.discussion' ORDER BY created_at ASC LIMIT 500`, [text(row.id)]);
		const resolved = new Set(feedbackRows.map((event: Row) => text(record(event.evidence_json).resolvesEventId)).filter(Boolean));
		const openBlockingFeedback = feedbackRows.flatMap((event: Row) => {
			const evidence = record(event.evidence_json), kind = text(evidence.kind);
			if (!['concern','question'].includes(kind) || text(evidence.feedbackSeverity) === 'advisory'
				|| ['resolved','withdrawn'].includes(text(evidence.feedbackStatus)) || resolved.has(text(event.id))) return [];
			const contentPath = text(evidence.contentPath), feedbackCommit = text(evidence.commitSha), feedbackDigest = text(evidence.digest);
			if (!contentPath || !/^[a-f0-9]{40}$/u.test(feedbackCommit) || !feedbackDigest) return [];
			return [{ id: text(event.id), kind: kind as 'concern' | 'question', message: text(event.message),
				contentPath, commit: feedbackCommit, digest: feedbackDigest }];
		});
		sources.push({ teamId: text(row.team_id), projectId: text(row.project_id), id: text(row.id), revision: Number(row.active_version),
			digest: text(row.active_content_hash), status: text(row.status), title: text(row.title), summary: text(row.summary), body: text(row.body),
			repositoryId, path, commit, contentDigest, createdById: text(row.created_by_id) || null,
			proposalTypes: strings(metadata.proposalTypes), requiredParticipantIds: strings(metadata.requiredParticipantIds),
			requiredReviewerClasses: strings(metadata.requiredReviewerClasses), readiness, openBlockingFeedback });
	}
	return sources;
}
