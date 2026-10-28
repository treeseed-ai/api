import { randomUUID } from 'node:crypto';
import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import assert from 'node:assert/strict';
import { assignmentAttemptSchema, assignmentResultSchema } from '@treeseed/sdk/agent-capacity';
import { assignment as original } from '../../../capacity/execution/fixtures/assignment.ts';
import { relationAuthoringDatabase, object } from '../../../knowledge/workspaces/architecture/relation-authoring-fixture.ts';
import { recordAssignmentContentIntegration, verifyAssignmentContent } from '../../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-content-readback.ts';
import { readExactProposal } from '../../../../../../src/api/governance/executable-proposal.ts';

describe('native planning result projection', () => {
	it('concurrent completed-product integration creates one exact agent-owned draft through original PostgreSQL and signed TreeDX', async () => {
		// Controlled canonical assignment/result inputs, original services and
		// independent real PostgreSQL pools. This is not managed agent execution.
		const f = await relationAuthoringDatabase(true); assert.ok(f.peerStore);
		let workspaceId: string | undefined;
		try {
			const projectId = f.sources[0]!.projectId, repository = f.sources[0]!.repository, id = `planning-${randomUUID()}`;
			const agentId = `${projectId}/portfolio-planner`, path = `proposals/${id}.mdx`, profilePath = 'agents/portfolio-planner.mdx';
			const profile = { handler: 'writer', prompt: { system: 'Consolidate the discussed retained-product delivery proposal.' },
				permissions: { content: { read: ['objective'], write: ['proposal'] }, tools: [] } };
			const agent = { schemaVersion: 'treeseed.agent/v1', id: agentId, name: 'Portfolio Planner', agentClass: 'technical-writer',
				groupIds: ['portfolio-delivery'], purpose: 'Plan real source product delivery.', responsibilities: ['Consolidate group findings.'],
				capabilities: ['planning'], context: { include: ['project'] }, activityProfiles: { planning: profile } };
			const definition = { schemaVersion: 'treeseed.proposal/v2', id, projectId, groupIds: ['portfolio-delivery'],
				title: 'Retrieve reviewed original Git products through MCP', request: 'Route the existing exporter through the shared backend.',
				summary: 'Preserve source custody without private host exports.', status: 'discussing' };
			const refs = object(await f.client.repositories.refs(repository)); assert.ok(Array.isArray(refs.refs));
			const staging = refs.refs.map(object).find(ref => ref.name === 'refs/heads/staging'); assert.ok(staging);
			const workspace = object(await f.client.workspaces.create(repository, { baseRef: String(staging.target ?? staging.sha),
				branchName: `refs/heads/${id}`, mode: 'writable', allowedPaths: [path, profilePath] }));
			workspaceId = String(workspace.workspaceId);
			for (const [file, value] of [[path, definition], [profilePath, agent]] as const) {
				await f.client.files.write(workspaceId, { path: file, content: `---\n${stringify(value)}---\n` });
			}
			const committed = object(await f.client.files.commit(workspaceId, { message: 'Controlled original planning product',
				author: { name: agent.name, email: 'planning-fixture@example.invalid' } }));
			const commit = String(committed.commitSha); expect(commit).toMatch(/^[a-f0-9]{40}$/u);
			await f.client.workspaces.close(workspaceId);
			expect(await f.client.workspaces.get(workspaceId)).toMatchObject({ status: 'closed' });
			const profileRef = { store: 'treedx', model: 'agent', id: agentId, repository, commit, path: profilePath };
			const attempt = assignmentAttemptSchema.parse({ ...original, id: `assignment-${id}`, teamId: 'team', projectId,
				agentClass: agent.agentClass, status: 'completed', effectiveProfile: { handler: profile.handler, prompt: profile.prompt,
					permissionCeiling: profile.permissions, activity: 'planning', handlerOrigin: 'agent-package', profileRef },
				workspace: { mode: 'treedx', workspaceId, repository, baseCommit: String(workspace.baseCommitSha), writablePaths: [path] },
				grant: { contentRead: [profileRef], contentWrite: [{ store: 'treedx', model: 'proposal', id, repository, commit, path }],
					sourceRead: [], sourceWrite: [], tools: [] } });
			const result = assignmentResultSchema.parse({ schemaVersion: 'treeseed.assignment-result/v1', id: `result-${id}`,
				assignmentId: attempt.id, status: 'completed', summary: 'Controlled native product; not a live agent result.',
				references: [{ kind: 'treedx', projectId, repository, commit, path, workspaceId }], verification: [], diagnostics: [],
				usage: { elapsedSeconds: 0 }, completedAt: original.createdAt });
			// The original PostgreSQL migrations require actual custody parents.
			// These are controlled fixture inputs, not provider enrollment/admission.
			await f.query(`INSERT INTO project_agent_classes (id,team_id,project_id,slug,name,created_at,updated_at)
				VALUES (?,?,?,?,?,?,?)`, [agent.agentClass, 'team', projectId, agent.agentClass, agent.name, original.createdAt, original.createdAt]);
			await f.query(`INSERT INTO capacity_providers (id,fingerprint,public_jwk_json,display_name,created_at,updated_at)
				VALUES (?,?,?,?,?,?)`, [attempt.provider.providerId, 'controlled-planning-input', '{}', 'Controlled planning provider', original.createdAt, original.createdAt]);
			await f.query(`INSERT INTO capacity_provider_team_memberships
				(id,team_id,capacity_provider_id,approved_at,approved_by_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,
				['controlled-member', 'team', attempt.provider.providerId, original.createdAt, 'operator', original.createdAt, original.createdAt]);
			await f.query(`INSERT INTO capacity_provider_assignments
				(id,membership_id,team_id,project_id,capacity_provider_id,project_agent_class_id,mode,status,agent_id,
				assignment_attempt_json,assignment_result_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
				[attempt.id, 'controlled-member', 'team', projectId, attempt.provider.providerId, agent.agentClass, 'planning', 'completed', agentId,
					JSON.stringify(attempt), JSON.stringify(result), original.createdAt, original.createdAt]);
			const scope = { id: attempt.id, teamId: 'team', projectId, agentId, assignmentAttempt: attempt };
			const before = await f.snapshot(), refsBefore = await f.client.repositories.refs(repository);
			const references = await verifyAssignmentContent(f.store, scope, result);
			await Promise.all([recordAssignmentContentIntegration(f.store, scope, result, references),
				recordAssignmentContentIntegration(f.peerStore, scope, result, references)]);
			const proposal = await f.store.getGovernanceProposal(id); assert.ok(proposal);
			expect(proposal).toMatchObject({ status: 'draft', createdByType: 'agent', createdById: agentId, activeVersion: 1 });
			const exact = await readExactProposal(f.store, proposal); expect(exact.definition).toEqual(definition);
			expect(exact.ref).toMatchObject({ id, repository, commit, path });
			for (const table of ['governance_proposals', 'governance_proposal_versions']) expect(await f.store.all(`SELECT id FROM ${table}`)).toHaveLength(1);
			expect(await f.store.all("SELECT id FROM governance_events WHERE event_type='proposal.created'")).toHaveLength(1);
			expect(await f.store.all("SELECT id FROM audit_events WHERE event_type='assignment.content.integrated'")).toHaveLength(1);
			const retained = await f.store.all('SELECT * FROM governance_proposals');
			await recordAssignmentContentIntegration(f.peerStore, scope, result, references);
			expect(await f.store.all('SELECT * FROM governance_proposals')).toEqual(retained);
			expect(await f.client.repositories.refs(repository)).toEqual(refsBefore); expect((await f.snapshot()).ledger).toEqual(before.ledger);
		} finally {
			try { if (workspaceId) await f.client.workspaces.close(workspaceId); } finally { await f.close(); }
		}
	});
});
