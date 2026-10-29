import { randomUUID } from 'node:crypto';
import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import assert from 'node:assert/strict';
import { assignmentAttemptSchema, assignmentResultSchema } from '@treeseed/sdk/agent-capacity';
import { assignment as original } from '../../../capacity/execution/fixtures/assignment.ts';
import { relationAuthoringDatabase, object } from '../../../knowledge/workspaces/architecture/relation-authoring-fixture.ts';
import { recordAssignmentContentIntegration, verifyAssignmentContent } from '../../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-content-readback.ts';
import { readExactProposal } from '../../../../../../src/api/governance/executable-proposal.ts';
import { createAssignmentService } from '../../../../../../src/api/control-plane/repositories/capacity/assignment-service.ts';

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
			// A second subscribed identity revises the admitted shared proposal;
			// original creation and source stay independently readable.
			const collaboratorId = `${projectId}/integration-planner`, collaboratorPath = 'agents/integration-planner.mdx';
			const collaborator = { ...agent, id: collaboratorId, name: 'Integration Planner' };
			const revised = { ...definition, title: 'Retrieve and integrate reviewed original Git products through MCP' };
			const revisionWorkspace = object(await f.client.workspaces.create(repository, { baseRef: commit,
				branchName: `refs/heads/${id}-revision`, mode: 'writable', allowedPaths: [path, collaboratorPath] }));
			workspaceId = String(revisionWorkspace.workspaceId);
			for (const [file, value] of [[path, revised], [collaboratorPath, collaborator]] as const) {
				await f.client.files.write(workspaceId, { path: file, content: `---\n${stringify(value)}---\n` });
			}
			const revisionCommit = object(await f.client.files.commit(workspaceId, { message: 'Controlled shared planning revision',
				author: { name: collaborator.name, email: 'planning-fixture@example.invalid' } }));
			await f.client.workspaces.close(workspaceId);
			expect(await f.client.workspaces.get(workspaceId)).toMatchObject({ status: 'closed' });
			const revisionRef = { ...profileRef, id: collaboratorId, path: collaboratorPath, commit: String(revisionCommit.commitSha) };
			const revisionAttempt = assignmentAttemptSchema.parse({ ...attempt, id: `assignment-${id}-revision`, sourceRef: exact.ref,
				effectiveProfile: { ...attempt.effectiveProfile, profileRef: revisionRef },
				workspace: { ...attempt.workspace, workspaceId, baseCommit: commit },
				grant: { ...attempt.grant, contentRead: [revisionRef, exact.ref], contentWrite: [exact.ref] } });
			const revisionResult = assignmentResultSchema.parse({ ...result, id: `result-${id}-revision`, assignmentId: revisionAttempt.id,
				references: [{ kind: 'treedx', projectId, repository, commit: String(revisionCommit.commitSha), path, workspaceId }] });
			await f.query(`INSERT INTO capacity_provider_assignments
				(id,membership_id,team_id,project_id,capacity_provider_id,project_agent_class_id,mode,status,agent_id,
				assignment_attempt_json,assignment_result_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
				[revisionAttempt.id, 'controlled-member', 'team', projectId, attempt.provider.providerId, agent.agentClass, 'planning',
					'completed', collaboratorId, JSON.stringify(revisionAttempt), JSON.stringify(revisionResult), original.createdAt, original.createdAt]);
			const revisionScope = { ...scope, id: revisionAttempt.id, agentId: collaboratorId, assignmentAttempt: revisionAttempt };
			const revisionBefore = await f.snapshot(), revisionRefsBefore = await f.client.repositories.refs(repository);
			const revisionReferences = await verifyAssignmentContent(f.store, revisionScope, revisionResult);
			const concurrent = await Promise.allSettled([recordAssignmentContentIntegration(f.store, revisionScope, revisionResult, revisionReferences),
				recordAssignmentContentIntegration(f.peerStore, revisionScope, revisionResult, revisionReferences)]);
			expect(concurrent.some(value => value.status === 'fulfilled')).toBe(true);
			// A concurrent optimistic loser may require ordinary same-result
			// reconciliation. It must never generate a third proposal version.
			await recordAssignmentContentIntegration(f.peerStore, revisionScope, revisionResult, revisionReferences);
			const updated = await f.store.getGovernanceProposal(id); assert.ok(updated);
			expect(updated).toMatchObject({ activeVersion: 2, createdByType: 'agent', createdById: agentId });
			expect((await readExactProposal(f.store, updated)).definition).toEqual(revised);
			expect((await readExactProposal(f.store, updated, exact.ref)).definition).toEqual(definition);
			expect(await f.store.all('SELECT id FROM governance_proposal_versions')).toHaveLength(2);
			expect(await f.store.all("SELECT id FROM governance_events WHERE event_type='proposal.created'")).toHaveLength(1);
			expect(await f.store.all("SELECT actor_id FROM governance_events WHERE event_type='proposal.version_published'"))
				.toEqual([{ actor_id: collaboratorId }]);
			expect(await f.store.all("SELECT id FROM audit_events WHERE event_type='assignment.content.integrated'")).toHaveLength(2);
			await f.query('DELETE FROM audit_events WHERE target_id=?', [revisionAttempt.id]);
			await recordAssignmentContentIntegration(f.peerStore, revisionScope, revisionResult, revisionReferences);
			expect(await f.store.all("SELECT id FROM audit_events WHERE event_type='assignment.content.integrated'")).toHaveLength(2);
			expect(await f.store.all('SELECT id FROM governance_proposal_versions')).toHaveLength(2);
			expect(await f.client.repositories.refs(repository)).toEqual(revisionRefsBefore);
			expect((await f.snapshot()).ledger).toEqual(revisionBefore.ledger);
			// A peer's independently delivered candidate used the original frozen
			// source. Retain it without adopting it or blocking content closeout.
			const staleWorkspace = object(await f.client.workspaces.create(repository, { baseRef: commit,
				branchName: `refs/heads/${id}-stale`, mode: 'writable', allowedPaths: [path] }));
			workspaceId = String(staleWorkspace.workspaceId);
			await f.client.files.write(workspaceId, { path, content: `---\n${stringify({ ...definition,
				summary: 'Independent implementation scope, not the current consolidated plan.' })}---\n` });
			const staleCommit = object(await f.client.files.commit(workspaceId, { message: 'Controlled stale planning product',
				author: { name: agent.name, email: 'planning-fixture@example.invalid' } }));
			await f.client.workspaces.close(workspaceId);
			expect(await f.client.workspaces.get(workspaceId)).toMatchObject({ status: 'closed' });
			const staleAttempt = assignmentAttemptSchema.parse({ ...attempt, id: `assignment-${id}-stale`, sourceRef: exact.ref,
				workspace: { ...attempt.workspace, workspaceId, baseCommit: commit },
				grant: { ...attempt.grant, contentRead: [profileRef, exact.ref], contentWrite: [exact.ref] } });
			const staleResult = assignmentResultSchema.parse({ ...result, id: `result-${id}-stale`, assignmentId: staleAttempt.id,
				references: [{ kind: 'treedx', projectId, repository, commit: String(staleCommit.commitSha), path, workspaceId }] });
			await f.query(`INSERT INTO capacity_provider_assignments
				(id,membership_id,team_id,project_id,capacity_provider_id,project_agent_class_id,mode,status,agent_id,
				assignment_attempt_json,assignment_result_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
				[staleAttempt.id, 'controlled-member', 'team', projectId, attempt.provider.providerId, agent.agentClass, 'planning',
					'completed', agentId, JSON.stringify(staleAttempt), JSON.stringify(staleResult), original.createdAt, original.createdAt]);
			const staleScope = { ...scope, id: staleAttempt.id, assignmentAttempt: staleAttempt };
			const staleBefore = await f.snapshot(), staleRefsBefore = await f.client.repositories.refs(repository);
			const staleReferences = await verifyAssignmentContent(f.store, staleScope, staleResult);
			const canonicalBefore = await f.store.getGovernanceProposal(id);
			await Promise.all([recordAssignmentContentIntegration(f.store, staleScope, staleResult, staleReferences),
				recordAssignmentContentIntegration(f.peerStore, staleScope, staleResult, staleReferences)]);
			const audits = await f.store.all('SELECT data_json FROM audit_events WHERE target_id=?', [staleAttempt.id]);
			expect(audits).toHaveLength(1);
			const admission = typeof audits[0]!.data_json === 'string' ? JSON.parse(audits[0]!.data_json) : audits[0]!.data_json;
			expect(admission).toMatchObject({ resultId: staleResult.id, publication: false, references: staleReferences,
				planningAdmissions: [{ proposalId: id, disposition: 'not_adopted', reason: 'source_advanced',
					sourceRef: exact.ref, currentRef: (await readExactProposal(f.store, updated)).ref, productRef: staleReferences[0] }] });
			expect(await f.store.getGovernanceProposal(id)).toEqual(canonicalBefore);
			expect(await f.store.all('SELECT id FROM governance_proposal_versions')).toHaveLength(2);
			const assignments = createAssignmentService(f.store);
			await expect(assignments.explain(undefined, 'team', staleAttempt.id)).rejects.toMatchObject({ code: 'authentication_required' });
			expect((await assignments.explain({ id: 'operator', roles: ['admin'] }, 'team', staleAttempt.id)).metadata)
				.toMatchObject({ planningAdmissions: admission.planningAdmissions });
			await recordAssignmentContentIntegration(f.peerStore, staleScope, staleResult, staleReferences);
			expect(await f.store.all('SELECT data_json FROM audit_events WHERE target_id=?', [staleAttempt.id])).toEqual(audits);
			expect(await f.client.repositories.refs(repository)).toEqual(staleRefsBefore);
			expect((await f.snapshot()).ledger).toEqual(staleBefore.ledger);
		} finally {
			try { if (workspaceId) await f.client.workspaces.close(workspaceId); } finally { await f.close(); }
		}
	});
});
