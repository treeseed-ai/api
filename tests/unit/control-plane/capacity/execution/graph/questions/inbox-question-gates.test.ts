import { expect, it } from 'vitest';
import { graphProfiles, graphSource, emptyLivingGraph } from '../architecture/living/living-graph-fixture.ts';
import { projectTeamExecutionGraph } from '../../../../../../../src/api/capacity/policy/execution/execution-graph-projector.ts';
import { applyOperationalState } from '../../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-state.ts';
import { loadTeamQuestionConditionSources } from '../../../../../../../src/api/capacity/services/capacity/execution/question-condition-source.ts';
import { inboxQuestionReference } from '../../../../../../../src/api/control-plane/inbox/question-content.ts';

const answerRef = { store: 'treedx' as const, model: 'discussion-message', id: 'answer', revision: 1,
	digest: `sha256:${'c'.repeat(64)}`, repository: 'project-library', commit: 'c'.repeat(40), path: 'discussion-messages/runtime/answer.mdx' };
const question = () => ({ teamId: 'team', projectId: 'project', id: 'runtime-handoff', revision: 1,
	digest: `sha256:${'d'.repeat(64)}`, status: 'open' as const, severity: 'blocking' as const, title: 'Adopt reviewed transport',
	repositoryId: 'project-library', path: 'questions/runtime-handoff.mdx', commit: 'd'.repeat(40),
	relatedProposalIds: ['project-proposal'], relatedDecisionIds: ['project-decision'], relatedWorkItemIds: ['next'], answerRef: null });
const project = (questions: Array<ReturnType<typeof question> | Omit<ReturnType<typeof question>, 'status' | 'answerRef'> & { status: 'answered' | 'closed'; answerRef: typeof answerRef | null }>) => {
	const graph = projectTeamExecutionGraph({ teamId: 'team', revision: 1, sources: [graphSource()], profiles: graphProfiles(), questionSources: questions });
	return applyOperationalState(emptyLivingGraph(), { ...graph, teamId: 'team', revision: 1, digest: graph.revision.graphDigest }, 1);
};

it('holds only the named contribution while unrelated work retains accepted authority', () => {
	const graph = project([question()]), gate = graph.nodes.find(node => node.condition?.subjectRef.model === 'question');
	expect(gate).toMatchObject({ status: 'blocked', condition: { conditionType: 'question', subjectRef: { id: 'runtime-handoff' } } });
	const targets = graph.edges.filter(edge => edge.fromNodeId === gate!.id).map(edge => graph.nodes.find(node => node.id === edge.toNodeId));
	expect(targets).toMatchObject([{ workItemId: 'next', pairRole: 'actor' }]);
	expect(graph.nodes.find(node => node.workItemId === 'first' && node.pairRole === 'actor')?.status).toBe('ready');
	expect(graph.nodes.find(node => node.condition?.conditionType === 'authority')?.status).toBe('completed');
});

it.each(['answered-without-proof', 'closed-with-proof', 'answered-with-proof'] as const)('requires an answered question and exact answer authority: %s', mode => {
	const graph = project([{ ...question(), status: mode === 'closed-with-proof' ? 'closed' : 'answered',
		answerRef: mode === 'answered-without-proof' ? null : answerRef }]);
	expect(graph.nodes.find(node => node.condition?.subjectRef.model === 'question')).toMatchObject({
		status: mode === 'answered-with-proof' ? 'completed' : 'blocked',
		authorityRefs: mode === 'answered-with-proof' ? [answerRef] : [],
	});
});

it.each([
	{ teamId: 'other' }, { projectId: 'other' }, { severity: 'advisory' }, { relatedProposalIds: [] },
	{ relatedProposalIds: ['other'] }, { relatedDecisionIds: ['other'] }, { relatedWorkItemIds: [] }, { relatedWorkItemIds: ['absent'] },
])('does not attach an unrelated or advisory question: %j', patch => {
	const graph = project([{ ...question(), ...patch } as ReturnType<typeof question>]);
	expect(graph.nodes.filter(node => node.condition?.subjectRef.model === 'question')).toEqual([]);
});

it('indexes only canonical exact discussion-message answer provenance and preserves source input', async () => {
	const base = question(), row = { id: base.id, team_id: base.teamId, project_id: base.projectId, status: 'answered',
		title: base.title, version: 1, repository_id: base.repositoryId, content_path: base.path, commit_sha: base.commit,
		digest: 'd'.repeat(64), metadata_json: { relatedProposals: base.relatedProposalIds, relatedWorkItems: ['next'], answerProvenance: answerRef } };
	for (const reference of [answerRef, { ...answerRef, model: 'discussion_message' }, { ...answerRef, digest: 'body-only-digest' },
		{ ...answerRef, repository: 'foreign' }, { ...answerRef, commit: 'moved' }]) {
		const supplied = { ...row, metadata_json: { ...row.metadata_json, answerProvenance: reference } }, held = structuredClone(supplied);
		const event = { item_id: row.id, event_type: 'question.answered', payload_json: { answerRef: reference, questionRef: inboxQuestionReference(row) } };
		const loaded = await loadTeamQuestionConditionSources({ all: async (sql: string) => sql.includes('FROM inbox_events') ? [event] : [supplied] }, 'team');
		expect(loaded[0]?.answerRef).toEqual(reference === answerRef ? answerRef : null);
		expect(loaded[0]?.digest).toBe(`sha256:${row.digest}`); expect(supplied).toEqual(held);
	}
});

it.each(['no-event', 'reopened', 'changed-question'] as const)('does not trust source metadata or reuse superseded answer proof: %s', mode => {
	const base = question(), row = { id: base.id, team_id: base.teamId, project_id: base.projectId, status: 'answered',
		title: base.title, version: 1, repository_id: base.repositoryId, content_path: base.path, commit_sha: base.commit,
		digest: 'd'.repeat(64), metadata_json: { relatedProposals: base.relatedProposalIds, relatedWorkItems: ['next'], answerProvenance: answerRef } };
	const event = { item_id: row.id, event_type: mode === 'reopened' ? 'question.reopened' : 'question.answered',
		payload_json: { answerRef, questionRef: { ...inboxQuestionReference(row), ...(mode === 'changed-question' ? { commit: 'e'.repeat(40) } : {}) } } };
	return loadTeamQuestionConditionSources({ all: async (sql: string) => sql.includes('FROM inbox_events') ? mode === 'no-event' ? [] : [event] : [row] }, 'team')
		.then(loaded => expect(loaded[0]?.answerRef).toBeNull());
});
