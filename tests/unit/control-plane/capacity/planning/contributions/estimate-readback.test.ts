import { describe, expect, it, vi } from 'vitest';
import { assignmentAttemptSchema, assignmentResultSchema } from '@treeseed/sdk/agent-capacity';
import { assignment as original } from '../../execution/fixtures/assignment.ts';
import { proposalNativeFixture } from '../../../governance/proposals/architecture/proposal-native-fixture.ts';
import { isCurrentSubscriberContribution, mergeAssignmentEstimate } from '../../../../../../src/api/capacity/services/capacity/assignments/planning/estimates/integration.ts';
import { readFileSync } from 'node:fs';
import { splitPostgresSqlStatements } from '../../../../../../src/api/persistence/postgres-sql-statements.ts';
import { loadProposalGroupContributions } from '../../../../../../src/api/capacity/services/capacity/execution/proposal-contributions.ts';
import { projectTeamExecutionGraph } from '../../../../../../src/api/capacity/policy/execution/execution-graph-projector.ts';
import { effectiveProfile } from '../../../../../../src/api/capacity/services/build/execution-node-profile.ts';
import { loadTeamExecutableProposalSources } from '../../../../../../src/api/capacity/services/capacity/execution/executable-proposal-source.ts';

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
			const draft = { schemaVersion: 'treeseed.proposal/v2', id: 'proposal', projectId: 'project', groupIds: ['provider-runtime'],
				title: 'Preserve prepared workload inputs', request: 'Document and repair the actual model request handoff.',
				summary: 'Own documentation and engineering contributions to the opaque runner repair.', status: 'discussing' };
			const frozen = await f.publish(draft), path = 'proposals/proposal.mdx';
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
				const item = { id: `${name}-work`, activity: 'acting', objective: `Own ${name} provider runtime repair.`, workspace: 'git',
					review: 'required', maximumReviewCycles: 2, dependsOn: [], estimateRef: { store: 'postgresql', model: 'assignment-attempt', id, revision: attempt.attempt },
					estimate, reviewEstimate: estimate, acceptanceCriteria: ['Deliver the accepted source boundary repair.'],
					requestedPermissions: { content: { read: ['proposal'], write: [] }, tools: ['source.read', 'source.write', 'verification'] },
					contextRefs: [{ store: 'git', model: 'repository', id: 'agent', repository: 'treeseed-ai/agent', commit: 'a'.repeat(40) }] };
				const candidate = { ...draft, executionPlan: { workItems: [item] } }, committed = f.publishContent(path, candidate);
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
			for (const input of inputs) current = mergeAssignmentEstimate({ frozen: draft, current, candidate: input.candidate,
				assignment: input.assignment, ownedEstimateRefs: [] });
			await f.publish(current);
			const proposal = (await f.query('SELECT * FROM governance_proposals')).rows[0]!;
			await f.query(`INSERT INTO project_agent_classes (id,team_id,project_id,slug,name,handler_refs_json,metadata_json,created_at,updated_at)
				VALUES (?,?,?,?,?,?,?,?,?)`, ['maintenance', 'team', 'project', 'maintenance', 'Maintenance', JSON.stringify({ agents: definitions }),
				JSON.stringify({ source: 'project-library', immutableRef: frozen.commit, definitionPaths: definitions.map(definition => `agents/${definition.name}.mdx`) }), original.createdAt, original.createdAt]);
			const store = { ...f.store, ensureInitialized: async () => {}, listTeamProjects: async () => [{ id: 'project' }] };
			for (const [index, { assignment, result }] of inputs.entries()) {
				await f.query(`INSERT INTO audit_events (id,actor_type,event_type,target_type,target_id,data_json,created_at) VALUES (?,?,?,?,?,?,?)`,
					[`integrated-${assignment.id}`, 'service', 'assignment.content.integrated', 'capacity_provider_assignment', assignment.id,
						JSON.stringify({ resultId: result.id, references: result.references }), original.createdAt]);
				if (!index) expect(await loadTeamExecutableProposalSources(store, 'team')).toEqual([]);
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
			// Actual owning SQL, SDK HTTP transport and committed Git are exercised.
			// The existing isolated endpoint is not a native TreeDX server or managed
			// execution/approval/permission proof. Those layers remain required.
		} finally { await f.close(); vi.unstubAllEnvs(); }
	});
});
