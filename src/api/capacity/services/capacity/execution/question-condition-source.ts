type Row = Record<string, unknown>;
function record(value: unknown): Row {
	if (value && typeof value === 'object' && !Array.isArray(value)) return value as Row;
	if (typeof value === 'string') try { return record(JSON.parse(value)); } catch { return {}; }
	return {};
}
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function strings(...values: unknown[]): string[] {
	return [...new Set(values.flatMap((value) => Array.isArray(value) ? value.map(text).filter(Boolean) : []))].sort();
}

export interface QuestionConditionSource {
	teamId: string;
	projectId: string;
	id: string;
	revision: number;
	digest: string;
	status: 'open' | 'answered' | 'closed';
	severity: 'blocking' | 'advisory';
	title: string;
	repositoryId: string;
	path: string;
	commit: string;
	relatedProposalIds: string[];
	relatedDecisionIds: string[];
	relatedWorkItemIds: string[];
	answerRef: { model: 'discussion_message'; id: string; revision: number; digest: string; repositoryId: string; path: string; commit: string } | null;
}

/** Read the indexed current question lifecycle while retaining exact TreeDX
 * provenance. Question and answer bytes remain in TreeDX. */
export async function loadTeamQuestionConditionSources(store: any, teamId: string): Promise<QuestionConditionSource[]> {
	const rows = await store.all(`SELECT id,team_id,project_id,status,title,version,repository_id,content_path,commit_sha,digest,metadata_json
		FROM inbox_items WHERE team_id=? AND kind='question' AND status IN ('outstanding','answered','closed') ORDER BY project_id,id`, [teamId]);
	return rows.flatMap((row: Row) => {
		const metadata = record(row.metadata_json), answer = record(metadata.answerProvenance);
		const repositoryId = text(row.repository_id), path = text(row.content_path), commit = text(row.commit_sha), digest = text(row.digest);
		if (!repositoryId || !path || !/^[a-f0-9]{40}$/u.test(commit) || !digest) return [];
		const answerCommit = text(answer.commit), answerPath = text(answer.path), answerDigest = text(answer.digest);
		const answerRef = /^[a-f0-9]{40}$/u.test(answerCommit) && answerPath && answerDigest ? {
			model: 'discussion_message' as const, id: text(answer.id) || answerPath, revision: Math.max(1, Number(answer.revision) || 1),
			digest: answerDigest, repositoryId: text(answer.repositoryId) || repositoryId, path: answerPath, commit: answerCommit,
		} : null;
		return [{ teamId: text(row.team_id), projectId: text(row.project_id), id: text(row.id), revision: Math.max(1, Number(row.version) || 1),
			digest, status: row.status === 'answered' ? 'answered' as const : row.status === 'closed' ? 'closed' as const : 'open' as const,
			severity: text(metadata.severity) === 'advisory' ? 'advisory' as const : 'blocking' as const, title: text(row.title), repositoryId, path, commit,
			relatedProposalIds: strings(metadata.related_proposals, metadata.relatedProposals),
			relatedDecisionIds: strings(metadata.related_decisions, metadata.relatedDecisions),
			relatedWorkItemIds: strings(metadata.related_work_items, metadata.relatedWorkItems), answerRef }];
	});
}
