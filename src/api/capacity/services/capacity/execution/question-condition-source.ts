import { exactEntityReferenceSchema, type ExactEntityReference } from '@treeseed/sdk/agent-capacity';
import { isDeepStrictEqual } from 'node:util';
import { inboxQuestionReference } from '../../../../control-plane/inbox/question-content.ts';
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
	answerRef: ExactEntityReference | null;
}

/** Question and answer bytes remain in TreeDX. Only the owning readback's
 * existing lifecycle event can prove an answer; author-supplied MDX metadata
 * cannot assert verification or reuse proof after scope edits or reopen. */
export async function loadTeamQuestionConditionSources(store: any, teamId: string): Promise<QuestionConditionSource[]> {
	const rows = await store.all(`SELECT id,team_id,project_id,status,title,version,repository_id,content_path,commit_sha,digest,metadata_json
		FROM inbox_items WHERE team_id=? AND kind='question' AND status IN ('outstanding','answered','closed') ORDER BY project_id,id`, [teamId]);
	if (!rows.length) return [];
	const lifecycle = await store.all(`SELECT DISTINCT ON (item_id) item_id,event_type,payload_json FROM inbox_events WHERE team_id=?
		AND event_type IN ('question.answered','question.reopened') ORDER BY item_id,sequence DESC`, [teamId]);
	const latest = new Map<string, Row>();
	for (const event of lifecycle) if (!latest.has(text(event.item_id))) latest.set(text(event.item_id), event);
	return rows.flatMap((row: Row) => {
		const metadata = record(row.metadata_json), event = latest.get(text(row.id)), proof = record(event?.payload_json);
		const relatedProposalIds = strings(metadata.related_proposals, metadata.relatedProposals), relatedWorkItemIds = strings(metadata.related_work_items, metadata.relatedWorkItems);
		if (text(metadata.severity) === 'advisory' || !relatedProposalIds.length || !relatedWorkItemIds.length) return [];
		const repositoryId = text(row.repository_id), path = text(row.content_path), commit = text(row.commit_sha), digest = text(row.digest);
		if (!repositoryId || !path || !/^[a-f0-9]{40}$/u.test(commit) || !digest) throw Object.assign(new Error('A scoped blocking question lacks exact TreeDX authority.'), { code: 'inbox_question_provenance_invalid' });
		const questionRef = inboxQuestionReference(row), parsedQuestion = exactEntityReferenceSchema.safeParse(proof.questionRef);
		const parsedAnswer = exactEntityReferenceSchema.safeParse(proof.answerRef);
		const answerRef = event?.event_type === 'question.answered' && parsedQuestion.success && isDeepStrictEqual(parsedQuestion.data, questionRef)
			&& parsedAnswer.success && parsedAnswer.data.store === 'treedx'
			&& parsedAnswer.data.model === 'discussion-message' && parsedAnswer.data.repository === repositoryId ? parsedAnswer.data : null;
		return [{ teamId: text(row.team_id), projectId: text(row.project_id), id: text(row.id), revision: Math.max(1, Number(row.version) || 1),
			digest: digest.startsWith('sha256:') ? digest : `sha256:${digest}`, status: row.status === 'answered' ? 'answered' as const : row.status === 'closed' ? 'closed' as const : 'open' as const,
			severity: text(metadata.severity) === 'advisory' ? 'advisory' as const : 'blocking' as const, title: text(row.title), repositoryId, path, commit,
			relatedProposalIds,
			relatedDecisionIds: strings(metadata.related_decisions, metadata.relatedDecisions),
			relatedWorkItemIds, answerRef }];
	});
}
