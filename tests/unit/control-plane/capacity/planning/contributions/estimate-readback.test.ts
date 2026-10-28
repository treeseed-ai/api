import { describe, expect, it, vi } from 'vitest';
import { assignmentAttemptSchema, assignmentResultSchema } from '@treeseed/sdk/agent-capacity';
import { assignment as original } from '../../execution/fixtures/assignment.ts';
import { proposalNativeFixture } from '../../../governance/proposals/architecture/proposal-native-fixture.ts';
import { isCurrentSubscriberContribution, mergeAssignmentEstimate } from '../../../../../../src/api/capacity/services/capacity/assignments/planning/estimates/integration.ts';
import { readFileSync } from 'node:fs';
import { validatePortableContentData } from '@treeseed/sdk/content-validation';
import { splitPostgresSqlStatements } from '../../../../../../src/api/persistence/postgres-sql-statements.ts';
import { loadProposalGroupContributions } from '../../../../../../src/api/capacity/services/capacity/execution/proposal-contributions.ts';
import { projectTeamExecutionGraph } from '../../../../../../src/api/capacity/policy/execution/execution-graph-projector.ts';
import { effectiveProfile } from '../../../../../../src/api/capacity/services/build/execution-node-profile.ts';
import { hasCompleteExecutablePlan, readExactProposal } from '../../../../../../src/api/governance/executable-proposal.ts';
import { loadTeamExecutableProposalSources } from '../../../../../../src/api/capacity/services/capacity/execution/executable-proposal-source.ts';
import { verifyAssignmentContent, recordAssignmentContentIntegration } from '../../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-content-readback.ts';

describe('own contribution through owning SQL public HTTP client and native Git', () => {
	it('reads actual estimator source and stored attempt ownership while preserving a concurrent peer through moved denied and altered-source observations', async () => {
		vi.stubEnv('TREESEED_TREEDX_URL', ''); vi.stubEnv('TREESEED_TREEDX_BASE_URL', ''); vi.stubEnv('TREESEED_ENVIRONMENT', 'test');
		const f = await proposalNativeFixture();
		try {
			const ddl = splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0000_control_plane.sql', 'utf8'));
			for (const table of ['project_agent_classes', 'audit_events']) {
				const statement = ddl.find(sql => sql.startsWith(`CREATE TABLE "${table}" (`));
				if (!statement) throw new Error(`Original owning DDL required: ${table}`); await f.query(statement);
			}
			const permissions = { content: { read: ['proposal', 'decision'], write: ['decision'] }, tools: ['source.read', 'source.write', 'verification'] };
			const profile = { handler: 'writer', permissions, prompt: { system: 'Contribute to the real prepared workload handoff repair.' } };
			const definitions = ['technical-writer', 'engineer'].map(name => ({ schemaVersion: 'treeseed.agent/v1', id: `project/${name}`, name,
				agentClass: 'maintenance', groupIds: ['provider-runtime'], purpose: 'Own a real portfolio source repair.',
				responsibilities: ['Own implementation and independent peer review.'], capabilities: ['source-repair'], context: { include: ['project'] },
				activityProfiles: { estimating: { ...profile, permissions: { content: { read: ['proposal'], write: ['proposal'] }, tools: ['source.read'] } },
					acting: profile, reviewing: { ...profile, permissions: { content: { read: ['proposal', 'decision'], write: ['decision'] }, tools: ['source.read', 'verification'] } } } }));
			for (const definition of definitions) f.publishContent(`agents/${definition.name}.mdx`, definition);
			const discussed = definitions.map(definition => ({ id: `${definition.name}-work`, activity: 'acting',
				objective: `Own ${definition.name} provider runtime repair.`, workspace: 'git', review: 'required', maximumReviewCycles: 2,
				dependsOn: [], acceptanceCriteria: ['Deliver the accepted source boundary repair.'],
				requestedPermissions: { content: { read: ['proposal'], write: [] }, tools: ['source.read', 'source.write', 'verification'] },
				contextRefs: [{ store: 'git', model: 'repository', id: 'agent', repository: 'treeseed-ai/agent', commit: 'a'.repeat(40) }] }));
			const draft = { schemaVersion: 'treeseed.proposal/v2', id: 'proposal', projectId: 'project', groupIds: ['provider-runtime'],
				title: 'Preserve prepared workload inputs', request: 'Document and repair the actual model request handoff.',
				summary: 'Own documentation and engineering contributions to the opaque runner repair.', status: 'discussing',
				executionPlan: { workItems: discussed } };
			const frozen = await f.publish(draft), path = 'proposals/proposal.mdx';
			const initialRow = (await f.query('SELECT * FROM governance_proposals')).rows[0]!;
			expect((await readExactProposal(f.store, initialRow)).definition.executionPlan).toEqual(draft.executionPlan);
			expect(hasCompleteExecutablePlan(draft)).toBe(false);
			const sourceRef = { store: 'treedx', model: 'proposal', id: 'proposal', revision: 1, repository: 'repository',
				commit: frozen.commit, digest: `sha256:${frozen.digest}`, path };
			const inputs = ['technical-writer', 'engineer'].map(name => {
				const id = `estimate-${name}`, agentId = `project/${name}`;
				const attempt = assignmentAttemptSchema.parse({ ...original, id, projectId: 'project', agentClass: 'maintenance', sourceRef,
					workItemId: undefined, status: 'completed', effectiveProfile: { ...original.effectiveProfile, activity: 'estimating', handler: 'writer',
						profileRef: { store: 'treedx', model: 'agent', id: agentId, repository: 'repository', commit: frozen.commit,
							path: `agents/${name}.mdx` } },
					workspace: { mode: 'treedx', workspaceId: `workspace-${name}`, repository: 'repository', baseCommit: frozen.commit, writablePaths: [path] },
					grant: { contentRead: [sourceRef], contentWrite: [sourceRef], sourceRead: [], sourceWrite: [], tools: [] } });
				const estimate = { expectedSeconds: 120, maximumSeconds: 240, rationale: 'Controlled bounded contribution input, not measured agent work.' };
				const planned = discussed.find(item => item.id === `${name}-work`)!;
				const item = { ...planned, estimateRef: { store: 'postgresql', model: 'assignment-attempt', id, revision: attempt.attempt },
					estimate, reviewEstimate: estimate };
				const candidate = { ...draft, executionPlan: { workItems: [item, ...discussed.filter(peer => peer.id !== item.id)] } },
					committed = f.publishContent(path, candidate);
				const result = assignmentResultSchema.parse({ schemaVersion: 'treeseed.assignment-result/v1', id: `result-${name}`, assignmentId: id,
					status: 'completed', summary: 'Controlled native component input; no live agent completion claimed.',
					references: [{ kind: 'treedx', projectId: 'project', repository: 'repository', commit: committed.commit, path, workspaceId: attempt.workspace.mode === 'treedx' ? attempt.workspace.workspaceId : '' }],
					verification: [], diagnostics: [], usage: { elapsedSeconds: 0 }, completedAt: original.createdAt });
				return { assignment: { id, agentId, projectId: 'project', teamId: 'team', assignmentAttempt: attempt }, candidate, result };
			});
			for (const { assignment, result } of inputs) await f.query(`INSERT INTO capacity_provider_assignments
				(id,membership_id,team_id,project_id,capacity_provider_id,project_agent_class_id,mode,status,agent_id,
				assignment_attempt_json,assignment_result_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
				[assignment.id, 'controlled-membership', 'team', 'project', 'controlled-provider', 'maintenance', 'planning', 'completed',
					assignment.agentId, JSON.stringify(assignment.assignmentAttempt), JSON.stringify(result), original.createdAt, original.createdAt]);
			let current: Record<string, unknown> = draft;
			for (const [index, input] of inputs.entries()) {
				current = mergeAssignmentEstimate({ frozen: draft, current, candidate: input.candidate,
					assignment: input.assignment, ownedEstimateRefs: [] });
				expect(hasCompleteExecutablePlan(current)).toBe(index === inputs.length - 1);
			}
			await f.publish(current);
			const proposal = (await f.query('SELECT * FROM governance_proposals')).rows[0]!;
			await f.query(`INSERT INTO project_agent_classes (id,team_id,project_id,slug,name,handler_refs_json,metadata_json,created_at,updated_at)
				VALUES (?,?,?,?,?,?,?,?,?)`, ['maintenance', 'team', 'project', 'maintenance', 'Maintenance', JSON.stringify({ agents: definitions }),
				JSON.stringify({ source: 'project-library', immutableRef: frozen.commit, definitionPaths: definitions.map(definition => `agents/${definition.name}.mdx`) }), original.createdAt, original.createdAt]);
			const store = { ...f.store, run: (sql: string, params: unknown[] = []) => f.query(sql, params),
				ensureInitialized: async () => {}, listTeamProjects: async () => [{ id: 'project' }] };
			const subject = { id: 'proposal', teamId: 'team', projectId: 'project' };
			expect(await loadProposalGroupContributions(store as never, subject, current)).toMatchObject({ current: false,
				missing: ['project/project/engineer', 'project/project/technical-writer'] });
			for (const [index, { assignment, result }] of inputs.entries()) {
				for (const fault of ['moved', 'denied'] as const) {
					f.setFault(fault);
					const before = await store.all('SELECT * FROM audit_events ORDER BY id');
					await expect(verifyAssignmentContent(store, assignment, result)).rejects.toThrow();
					expect(await store.all('SELECT * FROM audit_events ORDER BY id')).toEqual(before);
				}
				f.setFault('none');
				const references = await verifyAssignmentContent(store, assignment, result);
				await recordAssignmentContentIntegration(store, assignment, result, references);
				const receipts = await store.all('SELECT * FROM audit_events ORDER BY id');
				await recordAssignmentContentIntegration(store, assignment, result, references);
				expect(await store.all('SELECT * FROM audit_events ORDER BY id')).toEqual(receipts);
				if (!index) {
					expect(await loadTeamExecutableProposalSources(store, 'team')).toEqual([]);
					expect(await loadProposalGroupContributions(store as never, subject, current)).toMatchObject({
						current: false, missing: ['project/project/engineer'] });
				}
			}
			const verified = await loadProposalGroupContributions(store as never, { id: 'proposal', teamId: 'team', projectId: 'project' }, current);
			expect(verified.current).toBe(true); expect(verified.attempts).toHaveLength(2);
			const sources = await loadTeamExecutableProposalSources(store, 'team'); expect(sources).toHaveLength(1);
			expect(sources[0]!.estimatingAttempts).toEqual(verified.attempts);
			const graph = projectTeamExecutionGraph({ teamId: 'team', revision: 1,
				profiles: Object.fromEntries(definitions.map(definition => [`project:${definition.id}`, definition])) as never,
				sources });
			for (const node of graph.nodes.filter(node => node.kind === 'acting' || node.kind === 'reviewing')) {
				const bound = await effectiveProfile(store, node);
				expect(bound.profile.profileRef.id).toBe(node.authorityRefs!.find(ref => ref.model === 'agent')!.id);
				expect(bound.profile.profileRef.commit).toBe(frozen.commit);
			}
			const before = await f.snapshot();
			for (const input of inputs) expect(await isCurrentSubscriberContribution(f.store as never, proposal, current,
				input.assignment, input.result)).toBe(true);
			for (const fault of ['moved', 'denied'] as const) {
				f.setFault(fault); await expect(isCurrentSubscriberContribution(f.store as never, proposal, current,
					inputs[0]!.assignment, inputs[0]!.result)).rejects.toThrow();
				expect(await f.snapshot()).toEqual(before);
			}
			f.setFault('none');
			for (const input of inputs) {
				expect(await isCurrentSubscriberContribution(f.store as never, proposal, { ...current, request: 'A changed objective.' }, input.assignment, input.result)).toBe(false);
				expect(await isCurrentSubscriberContribution(f.store as never, proposal, current, { ...input.assignment, agentId: 'project/foreign' }, input.result)).toBe(false);
				expect(await isCurrentSubscriberContribution(f.store as never, proposal, current, input.assignment, input.result)).toBe(true);
			}
			expect(await f.snapshot()).toEqual(before);
			// An accepted author stays current when a peer later refreshes its own work.
			// These are supplied proposal/attempt inputs, not live agent completions.
			const writer = inputs[0]!, peer = inputs[1]!;
			const frozenPeer = f.publishContent(path, current);
			const refreshedAttempt = assignmentAttemptSchema.parse({ ...writer.assignment.assignmentAttempt,
				id: 'refreshed-writer', sourceRef: { ...sourceRef, commit: frozenPeer.commit, digest: `sha256:${frozenPeer.digest}` } });
			const ownRef = { store: 'postgresql', model: 'assignment-attempt', id: refreshedAttempt.id, revision: refreshedAttempt.attempt };
			const owned = { ...writer.candidate.executionPlan.workItems[0]!, estimateRef: ownRef };
			const candidate = { ...current, executionPlan: { workItems: [owned, peer.candidate.executionPlan.workItems[0]!] } };
			const published = f.publishContent(path, candidate);
			const refreshed = { ...writer.assignment, id: refreshedAttempt.id, assignmentAttempt: refreshedAttempt };
			const result = assignmentResultSchema.parse({ ...writer.result, id: 'result-refreshed-writer', assignmentId: refreshed.id,
				references: [{ ...writer.result.references[0]!, commit: published.commit }] });
			await f.query(`INSERT INTO capacity_provider_assignments
				(id,membership_id,team_id,project_id,capacity_provider_id,project_agent_class_id,mode,status,agent_id,
				assignment_attempt_json,assignment_result_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
				[refreshed.id, 'controlled-membership', 'team', 'project', 'controlled-provider', 'maintenance', 'planning', 'completed',
					refreshed.agentId, JSON.stringify(refreshedAttempt), JSON.stringify(result), original.createdAt, original.createdAt]);
			const changedPeer = { ...candidate, executionPlan: { workItems: [owned,
				{ ...peer.candidate.executionPlan.workItems[0]!, estimateRef: { ...ownRef, id: 'newer-peer-attempt' } }] } };
			const held = await f.snapshot();
			expect(await isCurrentSubscriberContribution(f.store as never, proposal, changedPeer, refreshed, result)).toBe(true);
			for (const changedOwn of [{ ...owned, dependsOn: ['engineer-work'] }, { ...owned, objective: 'Changed own scope.' }])
				expect(await isCurrentSubscriberContribution(f.store as never, proposal,
					{ ...changedPeer, executionPlan: { workItems: [changedOwn, changedPeer.executionPlan.workItems[1]!] } }, refreshed, result)).toBe(false);
			expect(mergeAssignmentEstimate({ frozen: current, current: changedPeer, candidate,
				assignment: refreshed, ownedEstimateRefs: [writer.candidate.executionPlan.workItems[0]!.estimateRef] } as never))
				.toEqual(changedPeer);
			expect(await f.snapshot()).toEqual(held);
			// Real portfolio team growth must not let retained accepted history
			// prevent a new draft. No historical contribution is invented for it.
			const accepted = await readExactProposal(store, proposal);
			await f.query("UPDATE governance_proposals SET status='accepted',decision_id='retained-decision' WHERE id='proposal'");
			await f.query(`INSERT INTO governance_decisions
				(id,team_id,project_id,proposal_id,proposal_version,proposal_content_hash,status,title,summary,
				governance_provider_id,decision_record_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
				['retained-decision', 'team', 'project', 'proposal', 1, proposal.active_content_hash, 'accepted',
					'Retained accepted repair', 'Controlled historical authority, not a live approval.', 'default',
					JSON.stringify({ proposalRef: accepted.ref }), original.createdAt, original.createdAt]);
			await f.query(`INSERT INTO execution_nodes
				(id,team_id,project_id,kind,pair_role,source_ref_json,rule_revision,node_revision,status,
				graph_revision_created,graph_revision_updated,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
				['retained-node', 'team', 'project', 'acting', 'actor', JSON.stringify(accepted.ref), 1, 1,
					'blocked', 1, 1, original.createdAt, original.createdAt]);
			// A current proposal can still cite an estimate whose frozen source
			// predates the group-only schema. Re-read the real obsolete Git bytes;
			// never erase that estimate or count it as a current contribution.
			const obsolete = { ...draft, executionPlan: { workItems: discussed.map(item => ({ ...item, agentClass: 'maintenance' })) } };
			expect(validatePortableContentData('proposal', obsolete).ok).toBe(false);
			const obsoleteSource = f.publishContent(path, obsolete), estimator = inputs[0]!;
			const oldAttempt = assignmentAttemptSchema.parse({ ...estimator.assignment.assignmentAttempt,
				sourceRef: { ...sourceRef, commit: obsoleteSource.commit, digest: `sha256:${obsoleteSource.digest}` } });
			await f.query('BEGIN');
			try {
				await f.query('UPDATE capacity_provider_assignments SET assignment_attempt_json=? WHERE id=?',
					[JSON.stringify(oldAttempt), estimator.assignment.id]);
				const retainedEstimate = await f.snapshot();
				await expect(isCurrentSubscriberContribution(store, subject, current,
					{ ...estimator.assignment, assignmentAttempt: oldAttempt }, estimator.result)).resolves.toBe(false);
				await expect(loadProposalGroupContributions(store as never, subject, current)).resolves.toMatchObject({
					current: false, missing: ['project/project/technical-writer'] });
				const frozen: unknown[] = [];
				await expect(loadTeamExecutableProposalSources(store, 'team', undefined, source => frozen.push(source))).resolves.toEqual([]);
				expect(frozen).toEqual([{ id: 'proposal', digest: accepted.ref.digest }]);
				for (const fault of ['moved', 'denied'] as const) {
					f.setFault(fault);
					await expect(isCurrentSubscriberContribution(store, subject, current,
						{ ...estimator.assignment, assignmentAttempt: oldAttempt }, estimator.result)).rejects.toThrow();
				}
				f.setFault('none');
				expect(await f.snapshot()).toEqual(retainedEstimate);
			} finally { f.setFault('none'); await f.query('ROLLBACK'); }
			const newcomer = { ...definitions[1]!, id: 'project/integrator', name: 'integrator' };
			const grown = f.publishContent('agents/integrator.mdx', newcomer);
			await f.query('UPDATE project_agent_classes SET handler_refs_json=?,metadata_json=? WHERE id=?', [
				JSON.stringify({ agents: [...definitions, newcomer] }), JSON.stringify({ source: 'project-library',
					immutableRef: grown.commit, definitionPaths: [...definitions.map(item => `agents/${item.name}.mdx`), 'agents/integrator.mdx'] }), 'maintenance']);
			expect(await loadProposalGroupContributions(store as never, subject, current)).toMatchObject({
				current: false, missing: ['project/project/integrator'] });
			const nextDraft = { ...draft, id: 'next-objective' }, nextSource = f.publishContent('proposals/next-objective.mdx', nextDraft);
			await f.query(`INSERT INTO governance_proposals
				(id,team_id,project_id,title,summary,body,active_content_hash,governance_provider_id,metadata_json,created_at,updated_at)
				VALUES (?,?,?,?,?,?,?,?,?,?,?)`, ['next-objective', 'team', 'project', nextDraft.title, nextDraft.summary,
					nextDraft.request, nextSource.digest, 'default', JSON.stringify({ contentProvenance: { repositoryId: 'repository',
						contentPath: 'proposals/next-objective.mdx', commitSha: nextSource.commit, digest: nextSource.digest } }), original.createdAt, original.createdAt]);
			const retained = await f.snapshot(), frozenHistory: Array<{ id: string; digest: string }> = [];
			await expect(loadTeamExecutableProposalSources(store, 'team', undefined, source => frozenHistory.push(source))).resolves.toEqual([]);
			expect(frozenHistory).toEqual([{ id: 'proposal', digest: accepted.ref.digest }]);
			expect(await f.snapshot()).toEqual(retained);
			await expect(loadTeamExecutableProposalSources(store, 'team')).rejects.toMatchObject({ code: 'proposal_contributions_unverified' });
			await f.query('BEGIN');
			try {
				await f.query("DELETE FROM execution_nodes WHERE id='retained-node'");
				await expect(loadTeamExecutableProposalSources(store, 'team', undefined, () => undefined))
					.rejects.toMatchObject({ code: 'proposal_contributions_unverified' });
			} finally { await f.query('ROLLBACK'); }
			expect(await f.snapshot()).toEqual(retained);
			for (const fault of ['moved', 'denied'] as const) {
				f.setFault(fault); await expect(loadTeamExecutableProposalSources(store, 'team', undefined, () => undefined)).rejects.toThrow();
				expect(await f.snapshot()).toEqual(retained);
			}
			f.setFault('none');
			await f.query(`INSERT INTO capacity_provider_assignments
				(id,membership_id,team_id,project_id,capacity_provider_id,project_agent_class_id,mode,status,
				execution_node_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
				['active-retained', 'membership', 'team', 'project', 'provider', 'maintenance', 'acting', 'running',
					'retained-node', original.createdAt, original.createdAt]);
			const active = await f.snapshot();
			await expect(loadTeamExecutableProposalSources(store, 'team', undefined, () => undefined))
				.rejects.toMatchObject({ code: 'proposal_contributions_unverified', details: { missing: ['project/project/integrator'] } });
			expect(await f.snapshot()).toEqual(active);
			// Actual owning SQL, SDK HTTP transport and committed Git are exercised.
			// The existing isolated endpoint is not a native TreeDX server or managed
			// execution/approval/permission proof. Those layers remain required.
		} finally { await f.close(); vi.unstubAllEnvs(); }
	});
});
