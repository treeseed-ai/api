import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { Hono } from 'hono';
import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { relationAuthoringDatabase, object } from '../../../knowledge/workspaces/architecture/relation-authoring-fixture.ts';
import { createCommunicationService } from '../../../../../../src/api/control-plane/repositories/capacity/communication-service.ts';
import { createDiscussionService } from '../../../../../../src/api/discussions/discussion-service.ts';
import { createGovernanceService } from '../../../../../../src/api/control-plane/governance/governance-service.ts';
import { SessionEventService } from '../../../../../../src/api/realtime/session-events.ts';
import { loadDiscussions } from '../../../../../../src/api/discussions/content.ts';
import { readExactProposal } from '../../../../../../src/api/governance/executable-proposal.ts';
import { createCommunicationOperations } from '../../../../../../src/api/control-plane/catalog/capacity/communications.ts';
import { OperationRegistry } from '../../../../../../src/api/control-plane/catalog/operation-registry.ts';
import { installControlPlaneProtocolRoutes } from '../../../../../../src/api/control-plane/http/protocol-routes.ts';

describe('native communication proposal recovery', () => {
	it.each([false, true])('keeps the original context and one invocation across project streams=%s after proposal edits and interrupted admission', async crossProject => {
		// Original owning services, PostgreSQL pools and disposable signed TreeDX.
		// The principal/profile/proposal are controlled inputs, not agent results,
		// OAuth, provider execution or a full objective workflow acceptance claim.
		const f = await relationAuthoringDatabase(true), owned = new Set<string>();
		try {
			const projectId = f.sources[0]!.projectId, repository = f.sources[0]!.repository;
			const discussionProjectId = f.sources[crossProject ? 1 : 0]!.projectId;
			const now = new Date().toISOString();
			const agent = { schemaVersion: 'treeseed.agent/v1', id: `${discussionProjectId}/researcher`, name: 'Researcher', agentClass: 'researcher',
				purpose: 'Inspect the retry boundary.', responsibilities: ['Inspect the retry boundary.'], capabilities: ['repository-analysis'], context: { include: ['project-objectives'] },
				activityProfiles: { chat: { handler: 'writer', permissions: { content: { read: ['knowledge', 'discussion'], write: ['discussion'] }, tools: ['discussion', 'source.read'] }, prompt: { system: 'Answer with exact source evidence.' } } } };
			await f.query(`INSERT INTO project_agent_classes (id,team_id,project_id,slug,name,handler_refs_json,metadata_json,created_at,updated_at)
				VALUES (?,?,?,?,?,?,?,?,?)`, ['recovery-researcher', 'team', discussionProjectId, 'researcher', 'Researcher', JSON.stringify({ agents: [agent] }), '{}', now, now]);
			const declaration = { schemaVersion: 'treeseed.proposal/v1', id: 'recover-mcp', projectId, title: 'Recover meaningful MCP work',
				request: 'Keep the original invocation when retrying project work after proposal edits.', summary: 'Repair the observed retry-context drift.', status: 'draft' };
			const path = 'proposals/governance/recover-mcp.mdx', source = `---\n${stringify(declaration)}---\n`;
			const typePath = '.treeseed/governance/proposal-types/implementation.yaml';
			const contract = { schemaVersion: 'treeseed.proposal-type/v1', id: 'implementation', label: 'Implementation', description: 'Bounded recovery verification.' };
			const refs = object(await f.client.repositories.refs(repository)); assert.ok(Array.isArray(refs.refs));
			const staging = refs.refs.map(object).find(ref => ref.name === 'refs/heads/staging'); assert.ok(staging);
			const workspace = object(await f.client.workspaces.create(repository, { baseRef: String(staging.target ?? staging.sha), branchName: 'refs/heads/staging', mode: 'writable', allowedPaths: [path, typePath] }));
			const workspaceId = String(workspace.workspaceId); let commit: string;
			try {
				await f.client.files.write(workspaceId, { path: typePath, content: JSON.stringify(contract), allowProtected: true });
				await f.client.files.write(workspaceId, { path, content: source });
				commit = String(object(await f.client.files.commit(workspaceId, { message: 'Controlled recovery proposal input', author: { name: 'Native input', email: 'native@example.invalid' } })).commitSha);
			} finally { await f.client.workspaces.close(workspaceId); }
			const digest = createHash('sha256').update(source).digest('hex');
			const proposal = await f.store.createGovernanceProposal(f.principal, { id: declaration.id, teamId: 'team', projectId, title: declaration.title,
				summary: declaration.summary, body: declaration.request, proposalTypes: ['implementation'], contentProvenance: { repositoryId: repository, contentPath: path, commitSha: commit, digest } }); assert.ok(proposal);
			await f.query('UPDATE governance_proposals SET active_content_hash=? WHERE id=?', [digest, declaration.id]);
			await f.query('UPDATE governance_proposal_versions SET content_hash=? WHERE proposal_id=?', [digest, declaration.id]);
			await f.query('UPDATE treedx_project_libraries SET content_repository_ref=? WHERE project_id=?', [commit, projectId]);
			await f.store.openGovernanceProposal(f.principal, declaration.id, { expectedProposalVersion: 1 });
			const discussion = createDiscussionService({ store: f.store, capacity: f.store, sessionEvents: new SessionEventService(f.store) });
			const communication = createCommunicationService(f.store, discussion);
			const governance = createGovernanceService(f.store, discussion);
			const edit = async (summary: string, changeReason: string, version: string) => {
				const result = await governance.updateProposal(f.principal, projectId, declaration.id, { summary, changeReason }, version);
				const id = String(result.authoringReceipt.changeset.workspaceId ?? ''); assert.ok(id); owned.add(id);
				await f.client.workspaces.close(id); expect(object(await f.client.workspaces.get(id)).status).toBe('closed'); owned.delete(id);
			};
			const body = { message: `@${discussionProjectId}/researcher Trace the MCP retry-context boundary.`, proposalId: declaration.id };
			const send = (key = 'same-project-work', input = body) => communication.send(f.principal, 'team', 'mcp-recovery', input, key);
			// The original official client must compile the actual receipt schema and
			// validate real owning-service output; no relaxed validator or fake receipt.
			const binding = CONTROL_PLANE_OPERATIONS.communications.send, app = new Hono();
			installControlPlaneProtocolRoutes(app, async () => ({ principal: { ...f.principal, scopes: binding.descriptor.oauthScopes },
				credential: { id: 'native-recovery-client' } }), undefined, new OperationRegistry(createCommunicationOperations({ communications: communication })));
			const client = new Client({ name: 'native-proposal-recovery', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
			let first: Awaited<ReturnType<typeof send>>;
			try {
				await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
					authProvider: { token: async () => 'controlled-native-principal' }, fetch: async (input, init) => {
						const request = input instanceof Request ? input : new Request(input, init), headers = new Headers(request.headers);
						headers.set('host', 'localhost'); return app.fetch(new Request(request, { headers }));
					},
				}));
				const result = await client.callTool({ name: binding.descriptor.operationId, arguments: {
					path: { teamId: 'team', channel: 'mcp-recovery' }, body, headers: { 'Idempotency-Key': 'same-project-work' } } });
				expect(result.isError).not.toBe(true); first = binding.schema.output.parse(result.structuredContent);
			} finally { await client.close(); }
			expect(first.targets).toHaveLength(1); expect(first.targets[0]!.projectId).toBe(discussionProjectId);
			if (crossProject) expect((await loadDiscussions({ store: f.store, projectId, discussionId: 'mcp-recovery', collection: 'messages' })).messages).toHaveLength(0);
			const snapshots = async () => ({ invocations: await f.store.all('SELECT * FROM agent_invocation_requests ORDER BY id'),
				assignments: await f.store.all('SELECT * FROM capacity_provider_assignments ORDER BY id'), ledger: await f.store.all('SELECT * FROM capacity_ledger_entries ORDER BY id'),
				events: await f.store.all('SELECT * FROM communication_topic_events ORDER BY sequence') });
			const before = await snapshots(); expect(before.invocations).toHaveLength(1); expect(before.assignments).toHaveLength(0);
			const originalRefs = before.invocations[0]!.content_refs_json;
			await edit('Retain frozen context after the real proposal changes.', 'Reproduce the observed unchanged-send recovery failure.', '1');
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
			const interrupted = await loadDiscussions({ store: f.store, projectId: discussionProjectId, discussionId: 'mcp-recovery', collection: 'messages' });
			const frozen = interrupted.messages.find(message => message.id !== first.projectStreams[0]!.messageRef.split('/').at(-1)?.replace('.mdx','')); assert.ok(frozen);
			await edit('Recover the interrupted admission against its original proposal.', 'Exercise the observed authoring-before-admission interruption.', '2');
			const moved = await f.store.getGovernanceProposal(declaration.id); assert.ok(moved);
			const exact = await readExactProposal(f.store, moved), interruptedState = await snapshots();
			// This is the state a racing caller reaches after its first lookup missed
			// the message but another writer committed before its own create call.
			await expect(discussion.create(f.principal, { teamId: 'team', projectId: discussionProjectId, discussionId: 'mcp-recovery', body: body.message,
				contextRefs: [{ kind: 'proposal', id: declaration.id, projectId, immutableRef: exact.ref.commit, path: exact.ref.path, digest: exact.ref.digest }],
				recipients: ['researcher'] }, `interrupted-project-work:${discussionProjectId}`))
				.rejects.toMatchObject({ status: 409, code: 'discussion_idempotency_conflict' });
			expect(await snapshots()).toEqual(interruptedState);
			const recovered = await send('interrupted-project-work'); expect(recovered.replayed).toBe(true);
			const rows = await f.store.all('SELECT * FROM agent_invocation_requests ORDER BY id'); expect(rows).toHaveLength(2);
			const newRow = rows.find(row => row.id !== before.invocations[0]!.id); assert.ok(newRow);
			const persisted = typeof newRow.content_refs_json === 'string' ? JSON.parse(newRow.content_refs_json) : newRow.content_refs_json;
			expect(persisted.slice(1)).toEqual(frozen.frontmatter.contextRefs);
			expect((await snapshots()).assignments).toHaveLength(0); expect((await snapshots()).ledger).toHaveLength(0);
		} finally { try { for (const id of owned) await f.client.workspaces.close(id); } finally { await f.close(); } }
	}, 60_000);
});
