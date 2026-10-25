import { createHash } from 'node:crypto';
import { expect } from 'vitest';
import type { relationAuthoringDatabase } from '../workspaces/architecture/relation-authoring-fixture.ts';
import { createInboxService } from '../../../../../src/api/control-plane/inbox/inbox-service.ts';
import { createDiscussionService } from '../../../../../src/api/discussions/discussion-service.ts';
import { commitDiscussionMessage } from '../../../../../src/api/discussions/content.ts';
import { createGovernanceService } from '../../../../../src/api/control-plane/governance/governance-service.ts';
import { SessionEventService } from '../../../../../src/api/realtime/session-events.ts';
import { decodeExecutionNode, decodeExecutionEdge } from '../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-storage.ts';
import { resolveKnowledgeGatewayConnection } from '../../../../../src/api/knowledge/gateway-treedx-connection.ts';

/** Extends the existing native governance case AFTER original Decision creation
 * and replay checks. No accepted Decision, graph condition or answer receipt is
 * inserted by this helper. Controlled agent messages are not managed execution. */
export async function verifyScopedInboxQuestionGates(f: Awaited<ReturnType<typeof relationAuthoringDatabase>>, proposalId: string, decisionId: string) {
	const projectId = f.sources[0]!.projectId;
	const discussions = createDiscussionService({ store: f.store, capacity: f.store, sessionEvents: new SessionEventService(f.store) });
	const inbox = createInboxService({ store: f.store, discussions, governance: createGovernanceService(f.store, discussions),
		communications: { send: async () => { throw new Error('Coordinator prerequisite has no addressed recipients'); } } });
	const graph = async () => ({ nodes: (await f.store.all('SELECT * FROM execution_nodes WHERE team_id=? ORDER BY id', ['team'])).map(decodeExecutionNode),
		edges: (await f.store.all('SELECT * FROM execution_edges WHERE team_id=? ORDER BY id', ['team'])).map(decodeExecutionEdge) });
	const before = await graph(), originalAuthority = await f.store.all('SELECT * FROM governance_decisions ORDER BY id');
	const body = { projectId, title: 'Adopt reviewed transport before final integration', markdown: 'Record exact runtime adoption evidence.', severity: 'blocking',
		relatedProposals: [proposalId], relatedDecisions: [decisionId], relatedWorkItems: ['peer-contribution'] };
	const created = await inbox.createQuestion(f.principal, 'team', body, 'native-runtime-handoff');
	expect((await inbox.createQuestion(f.principal, 'team', body, 'native-runtime-handoff')).item.id).toBe(created.item.id);
	const gate = (await graph()).nodes.find(node => node.condition?.subjectRef.model === 'question' && node.condition.subjectRef.id === created.item.id);
	expect(gate).toMatchObject({ status: 'blocked', condition: { subjectRef: { model: 'question', commit: created.item.provenance.commitSha } } });
	const targets = (await graph()).edges.filter(edge => edge.fromNodeId === gate!.id).map(edge => (before.nodes).find(node => node.id === edge.toNodeId));
	expect(targets).toMatchObject([{ workItemId: 'peer-contribution', pairRole: 'actor' }]);
	const unrelated = before.nodes.find(node => node.sourceRef.id === proposalId && node.pairRole === 'actor' && node.workItemId !== 'peer-contribution')!;
	expect((await graph()).nodes.find(node => node.id === unrelated.id)?.status).toBe(unrelated.status);
	const commented = await inbox.action(f.principal, 'team', created.item.id, { action: 'comment', markdown: 'Transport adoption is still in progress.' }, 'native-handoff-comment', created.item.etag);
	const message = await commitDiscussionMessage({ store: f.store, teamId: 'team', projectId, discussionId: commented.item.discussionId!,
		principal: { id: 'controlled-agent' }, authorType: 'agent', intent: 'discuss', inboxIntent: 'comment', body: 'Investigating the runtime.', messageId: 'agent-comment' });
	expect(message.commitSha).toMatch(/^[a-f0-9]{40}$/u);
	expect((await inbox.show(f.principal, 'team', created.item.id)).status).toBe('outstanding');
	const answered = await inbox.action(f.principal, 'team', created.item.id, { action: 'answer', markdown: 'The exact reviewed transport is adopted; native origin readback is recorded.' }, 'native-handoff-answer', commented.item.etag);
	expect(answered.item.status).toBe('answered');
	const row = await f.store.first('SELECT metadata_json FROM inbox_items WHERE id=?', [created.item.id]);
	const metadata = typeof row!.metadata_json === 'string' ? JSON.parse(row!.metadata_json) : row!.metadata_json;
	const ref = metadata.answerProvenance;
	expect(ref).toMatchObject({ store: 'treedx', model: 'discussion-message', repository: f.sources[0]!.repository });
	const reader = await resolveKnowledgeGatewayConnection(f.store, { projectId, write: false, readRefs: [ref.commit], workspacePaths: [ref.path] });
	if (!reader) throw new Error('Native exact answer reader required');
	const read = await reader.client.readRepositoryFiles({ repoId: ref.repository, ref: ref.commit, paths: [ref.path], encoding: 'utf8', parseFrontmatter: false, allowProtected: true });
	expect(read.resolvedRef).toBe(ref.commit); expect(`sha256:${createHash('sha256').update(read.files[0].content).digest('hex')}`).toBe(ref.digest);
	expect((await graph()).nodes.find(node => node.id === gate!.id)).toMatchObject({ status: 'completed', authorityRefs: [ref] });
	const reopened = await inbox.action(f.principal, 'team', created.item.id, { action: 'reopen' }, 'native-handoff-reopen', answered.item.etag);
	expect(reopened.item.status).toBe('outstanding');
	expect((await graph()).nodes.find(node => node.id === gate!.id)).toMatchObject({ status: 'blocked', authorityRefs: [] });
	const reread = await inbox.show(f.principal, 'team', created.item.id); expect(reread.status).toBe('outstanding');
	await commitDiscussionMessage({ store: f.store, teamId: 'team', projectId, discussionId: commented.item.discussionId!,
		principal: { id: 'controlled-agent' }, authorType: 'agent', intent: 'discuss', inboxIntent: 'answer',
		body: 'Controlled explicit answer for native lifecycle coverage; no managed execution claimed.', messageId: 'agent-answer' });
	const agentAnswered = await inbox.show(f.principal, 'team', created.item.id); expect(agentAnswered.status).toBe('answered');
	expect((await graph()).nodes.find(node => node.id === gate!.id)?.status).toBe('completed');
	await inbox.action(f.principal, 'team', created.item.id, { action: 'reopen' }, 'native-handoff-reopen-again', agentAnswered.etag);
	expect((await inbox.show(f.principal, 'team', created.item.id)).status).toBe('outstanding');
	expect((await graph()).nodes.find(node => node.id === gate!.id)).toMatchObject({ status: 'blocked', authorityRefs: [] });
	expect(await f.store.all('SELECT * FROM governance_decisions ORDER BY id')).toEqual(originalAuthority);
}
