import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { relationAuthoringDatabase, object } from '../../../knowledge/workspaces/architecture/relation-authoring-fixture.ts';
import { createCommunicationService } from '../../../../../../src/api/control-plane/repositories/capacity/communication-service.ts';
import { createDiscussionService } from '../../../../../../src/api/discussions/discussion-service.ts';
import { createGovernanceService } from '../../../../../../src/api/control-plane/governance/governance-service.ts';
import { SessionEventService } from '../../../../../../src/api/realtime/session-events.ts';
import { loadDiscussions } from '../../../../../../src/api/discussions/content.ts';
import { readExactProposal } from '../../../../../../src/api/governance/executable-proposal.ts';

describe('native communication proposal recovery', () => {
	it('keeps the original context and one invocation after real proposal authoring, concurrent retries and interrupted admission', async () => {
		// Original owning services, PostgreSQL pools and disposable signed TreeDX.
		// The principal/profile/proposal are controlled inputs, not agent results,
		// OAuth, provider execution or a full objective workflow acceptance claim.
		const f = await relationAuthoringDatabase(true);
		try {
			const projectId = f.sources[0]!.projectId, repository = f.sources[0]!.repository;
			const now = new Date().toISOString();
			const agent = { schemaVersion: 'treeseed.agent/v1', id: `${projectId}/researcher`, name: 'Researcher', agentClass: 'researcher',
				purpose: 'Inspect the retry boundary.', responsibilities: ['Inspect the retry boundary.'], capabilities: ['repository-analysis'], context: { include: ['project-objectives'] },
				activityProfiles: { chat: { handler: 'writer', permissions: { content: { read: ['knowledge', 'discussion'], write: ['discussion'] }, tools: ['discussion', 'source.read'] }, prompt: { system: 'Answer with exact source evidence.' } } } };
			await f.query(`INSERT INTO project_agent_classes (id,team_id,project_id,slug,name,handler_refs_json,metadata_json,created_at,updated_at)
				VALUES (?,?,?,?,?,?,?,?,?)`, ['recovery-researcher', 'team', projectId, 'researcher', 'Researcher', JSON.stringify({ agents: [agent] }), '{}', now, now]);
			const declaration = { schemaVersion: 'treeseed.proposal/v1', id: 'recover-mcp', projectId, title: 'Recover meaningful MCP work',
				request: 'Keep the original invocation when retrying project work after proposal edits.', summary: 'Repair the observed retry-context drift.', status: 'draft' };
			const path = 'proposals/governance/recover-mcp.mdx', source = `---\n${stringify(declaration)}---\n`;
			const refs = object(await f.client.repositories.refs(repository)); assert.ok(Array.isArray(refs.refs));
			const staging = refs.refs.map(object).find(ref => ref.name === 'refs/heads/staging'); assert.ok(staging);
			const workspace = object(await f.client.workspaces.create(repository, { baseRef: String(staging.target ?? staging.sha), branchName: 'refs/heads/staging', mode: 'writable', allowedPaths: [path] }));
			const workspaceId = String(workspace.workspaceId); let commit: string;
			try {
				await f.client.files.write(workspaceId, { path, content: source });
				commit = String(object(await f.client.files.commit(workspaceId, { message: 'Controlled recovery proposal input', author: { name: 'Native input', email: 'native@example.invalid' } })).commitSha);
			} finally { await f.client.workspaces.close(workspaceId); }
			const digest = createHash('sha256').update(source).digest('hex');
			const proposal = await f.store.createGovernanceProposal(f.principal, { id: declaration.id, teamId: 'team', projectId, title: declaration.title,
				summary: declaration.summary, request: declaration.request, contentProvenance: { repositoryId: repository, contentPath: path, commitSha: commit, digest } }); assert.ok(proposal);
			await f.query('UPDATE governance_proposals SET active_content_hash=? WHERE id=?', [digest, declaration.id]);
			await f.query('UPDATE governance_proposal_versions SET content_hash=? WHERE proposal_id=?', [digest, declaration.id]);
			await f.query('UPDATE treedx_project_libraries SET content_repository_ref=? WHERE project_id=?', [commit, projectId]);
			await f.store.openGovernanceProposal(f.principal, declaration.id, { expectedProposalVersion: 1 });
			const discussion = createDiscussionService({ store: f.store, capacity: f.store, sessionEvents: new SessionEventService(f.store) });
			const communication = createCommunicationService(f.store, discussion);
			const governance = createGovernanceService(f.store, discussion);
			const body = { message: `@${projectId}/researcher Trace the MCP retry-context boundary.`, proposalId: declaration.id };
			const send = (key = 'same-project-work', input = body) => communication.send(f.principal, 'team', 'mcp-recovery', input, key);
			const first = await send(); expect(first.targets).toHaveLength(1);
			const snapshots = async () => ({ invocations: await f.store.all('SELECT * FROM agent_invocation_requests ORDER BY id'),
				assignments: await f.store.all('SELECT * FROM capacity_provider_assignments ORDER BY id'), ledger: await f.store.all('SELECT * FROM capacity_ledger_entries ORDER BY id'),
				events: await f.store.all('SELECT * FROM communication_topic_events ORDER BY sequence') });
			const before = await snapshots(); expect(before.invocations).toHaveLength(1); expect(before.assignments).toHaveLength(0);
			const originalRefs = before.invocations[0]!.content_refs_json;
			await governance.updateProposal(f.principal, projectId, declaration.id, { summary: 'Retain frozen context after the real proposal changes.', changeReason: 'Reproduce the observed unchanged-send recovery failure.' }, '1');
			const edited = await f.store.getGovernanceProposal(declaration.id); assert.ok(edited); expect(edited.activeVersion).toBe(2); expect(edited.activeContentHash).not.toBe(digest);
			const editedState = await snapshots();
			for (const replay of await Promise.all([send(), send()])) {
				expect(replay.replayed).toBe(true); expect(replay.sendId).toBe(first.sendId);
				expect(replay.targets.map(target => target.invocationId)).toEqual(first.targets.map(target => target.invocationId));
			}
			expect(await snapshots()).toEqual(editedState);
			expect((await snapshots()).invocations[0]!.content_refs_json).toEqual(originalRefs);
			for (const changed of [{ ...body, message: `${body.message} Changed request.` }, { ...body, proposalId: 'different-proposal' }, { message: body.message }]) {
				await expect(send('same-project-work', changed as typeof body)).rejects.toMatchObject({ status: 409, code: 'discussion_idempotency_conflict' });
				expect(await snapshots()).toEqual(editedState);
			}
			// A real database interruption after the native message commit leaves no
			// invocation. Recovery must still use that message's original context.
			await f.db.exec(`CREATE FUNCTION reject_recovery_admission() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'controlled admission interruption'; END; $$ LANGUAGE plpgsql;
				CREATE TRIGGER reject_recovery_admission BEFORE INSERT ON agent_invocation_requests FOR EACH ROW EXECUTE FUNCTION reject_recovery_admission();`);
			try { await expect(send('interrupted-project-work')).rejects.toMatchObject({ status: 409, code: 'P0001' }); }
			finally { await f.db.exec('DROP TRIGGER reject_recovery_admission ON agent_invocation_requests; DROP FUNCTION reject_recovery_admission();'); }
			const interrupted = await loadDiscussions({ store: f.store, projectId, discussionId: 'mcp-recovery', collection: 'messages' });
			const frozen = interrupted.messages.find(message => message.id !== first.projectStreams[0]!.messageRef.split('/').at(-1)?.replace('.mdx','')); assert.ok(frozen);
			await governance.updateProposal(f.principal, projectId, declaration.id, { summary: 'Recover the interrupted admission against its original proposal.', changeReason: 'Exercise the observed authoring-before-admission interruption.' }, '2');
			const moved = await f.store.getGovernanceProposal(declaration.id); assert.ok(moved);
			const exact = await readExactProposal(f.store, moved), interruptedState = await snapshots();
			// This is the state a racing caller reaches after its first lookup missed
			// the message but another writer committed before its own create call.
			await expect(discussion.create(f.principal, { teamId: 'team', projectId, discussionId: 'mcp-recovery', body: body.message,
				contextRefs: [{ kind: 'proposal', id: declaration.id, projectId, immutableRef: exact.ref.commit, path: exact.ref.path, digest: exact.ref.digest }],
				recipients: ['researcher'] }, `interrupted-project-work:${projectId}`))
				.rejects.toMatchObject({ status: 409, code: 'discussion_idempotency_conflict' });
			expect(await snapshots()).toEqual(interruptedState);
			const recovered = await send('interrupted-project-work'); expect(recovered.replayed).toBe(true);
			const rows = await f.store.all('SELECT * FROM agent_invocation_requests ORDER BY id'); expect(rows).toHaveLength(2);
			const newRow = rows.find(row => row.id !== before.invocations[0]!.id); assert.ok(newRow);
			const persisted = typeof newRow.content_refs_json === 'string' ? JSON.parse(newRow.content_refs_json) : newRow.content_refs_json;
			expect(persisted.slice(1)).toEqual(frozen.frontmatter.contextRefs);
			expect((await snapshots()).assignments).toHaveLength(0); expect((await snapshots()).ledger).toHaveLength(0);
		} finally { await f.close(); }
	}, 60_000);
});
