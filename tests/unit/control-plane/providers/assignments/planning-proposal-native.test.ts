import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { assignmentAttemptSchema, assignmentResultSchema } from '@treeseed/sdk/agent-capacity';
import { validatePortableContentData } from '@treeseed/sdk/content-validation';
import { assignment as original } from '../../capacity/execution/fixtures/assignment.ts';
import { proposalNativeFixture } from '../../governance/proposals/architecture/proposal-native-fixture.ts';
import { splitPostgresSqlStatements } from '../../../../../src/api/persistence/postgres-sql-statements.ts';
import { verifyAssignmentContent, recordAssignmentContentIntegration } from '../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-content-readback.ts';
import { createGovernanceProposalMethod } from '../../../../../src/api/store/governance/policy/creation/create-governance-proposal.ts';
import { getGovernanceProposalMethod } from '../../../../../src/api/store/governance/policy/queries/proposals/get-governance-proposal.ts';
import { recordGovernanceEventMethod } from '../../../../../src/api/store/governance/policy/updates/record-governance-event.ts';
import { readExactProposal } from '../../../../../src/api/governance/executable-proposal.ts';

function planningStore(f: Awaited<ReturnType<typeof proposalNativeFixture>>) {
	return { ...f.store, run: (sql: string, params: unknown[] = []) => f.query(sql, params),
		ensureInitialized: async () => {}, getProject: async () => ({ id: 'project', teamId: 'team' }),
		resolveGovernancePolicy: async () => null,
		createGovernanceProposal: createGovernanceProposalMethod, getGovernanceProposal: getGovernanceProposalMethod,
		recordGovernanceEvent: recordGovernanceEventMethod,
		batch: async (operations: Array<{ query: string; params: unknown[] }>) => {
			await f.query('BEGIN');
			try { for (const operation of operations) await f.query(operation.query, operation.params); await f.query('COMMIT'); }
			catch (error) { await f.query('ROLLBACK'); throw error; }
		} };
}

describe('original planning product admission', () => {
	it('binds the completed agent proposal bytes into one canonical draft before recording integration', async () => {
		// Owning SQL, the original read-back service, official HTTP client and Git
		// commits; controlled assignment/result inputs are not live agent output.
		// The fixture endpoint is not a native TreeDX server or managed E2E proof.
		vi.stubEnv('TREESEED_TREEDX_URL', ''); vi.stubEnv('TREESEED_TREEDX_BASE_URL', ''); vi.stubEnv('TREESEED_ENVIRONMENT', 'test');
		const f = await proposalNativeFixture();
		try {
			const ddl = splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0000_control_plane.sql', 'utf8'));
			for (const table of ['governance_proposal_versions', 'audit_events']) {
				const statement = ddl.find(sql => sql.startsWith(`CREATE TABLE "${table}" (`));
				if (!statement) throw new Error(`Original owning DDL required: ${table}`);
				await f.query(statement);
			}
			const profile = { handler: 'writer', prompt: { system: 'Produce the group-discussed proposal without inventing estimates.' },
				permissions: { content: { read: ['objective'], write: ['proposal'] }, tools: [] } };
			const seed = f.publishContent('agents/portfolio-planner.mdx', { schemaVersion: 'treeseed.agent/v1',
				id: 'project/portfolio-planner', name: 'Portfolio Planner', agentClass: 'technical-writer', groupIds: ['portfolio-delivery'],
				purpose: 'Plan retained product delivery.', responsibilities: ['Consolidate group discussion.'], capabilities: ['planning'],
				context: { include: ['project'] }, activityProfiles: { planning: profile } });
			const definition = { schemaVersion: 'treeseed.proposal/v2', id: 'planning-product', projectId: 'project',
				title: 'Retrieve the original reviewed Git product', summary: 'Expose the existing exporter through the shared backend.',
				request: 'Allow coordinators to retrieve the retained Engineer product without private host exports.',
				status: 'discussing', groupIds: ['portfolio-delivery'], executionPlan: { workItems: [{ id: 'download-contract',
					activity: 'acting', objective: 'Document the authenticated retained-product download contract.',
					workspace: 'treedx', review: 'required', maximumReviewCycles: 2, dependsOn: [],
					requestedPermissions: { content: { read: ['proposal'], write: ['knowledge'] }, tools: [] },
					contextRefs: [{ store: 'treedx', model: 'repository', id: 'project-library', repository: 'repository', commit: seed.commit }],
					acceptanceCriteria: ['Preserve the original assignment, result, repository, base and head identity.'] }] } };
			expect(validatePortableContentData('proposal', definition).diagnostics).toEqual([]);
			const path = 'proposals/planning-product.mdx', published = f.publishContent(path, definition);
			const target = { store: 'treedx', model: 'proposal', id: definition.id, repository: 'repository',
				commit: published.commit, path };
			const profileRef = { store: 'treedx', model: 'agent', id: 'project/portfolio-planner', repository: 'repository',
				commit: seed.commit, path: 'agents/portfolio-planner.mdx' };
			const attempt = assignmentAttemptSchema.parse({ ...original, id: 'planning-assignment', teamId: 'team', projectId: 'project',
				agentClass: 'technical-writer', status: 'completed', effectiveProfile: { handler: profile.handler,
					prompt: profile.prompt, permissionCeiling: profile.permissions, activity: 'planning',
					handlerOrigin: 'agent-package', profileRef },
				workspace: { mode: 'treedx', workspaceId: 'planning-workspace', repository: 'repository',
					baseCommit: published.commit, writablePaths: [path] },
				grant: { contentRead: [profileRef], contentWrite: [target], sourceRead: [], sourceWrite: [], tools: [] } });
			const scope = { id: attempt.id, teamId: 'team', projectId: 'project', agentId: 'project/portfolio-planner', assignmentAttempt: attempt };
			const result = assignmentResultSchema.parse({ schemaVersion: 'treeseed.assignment-result/v1', id: 'planning-result',
				assignmentId: scope.id, status: 'completed', summary: 'Controlled original planning product input.',
				references: [{ kind: 'treedx', projectId: 'project', repository: 'repository', commit: published.commit,
					path, workspaceId: 'planning-workspace' }], verification: [], diagnostics: [],
				usage: { elapsedSeconds: 0 }, completedAt: original.createdAt });
			await f.query(`INSERT INTO capacity_provider_assignments
				(id,membership_id,team_id,project_id,capacity_provider_id,project_agent_class_id,mode,status,agent_id,
				assignment_attempt_json,assignment_result_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
				[scope.id, 'controlled-membership', scope.teamId, scope.projectId, 'controlled-provider', attempt.agentClass,
					'planning', 'completed', scope.agentId, JSON.stringify(attempt), JSON.stringify(result), original.createdAt, original.createdAt]);
			const store = planningStore(f);
			const before = await f.snapshot();
			const references = await verifyAssignmentContent(store, scope, result);
			for (const fault of ['moved', 'denied'] as const) {
				f.setFault(fault);
				await expect(recordAssignmentContentIntegration(store, scope, result, references)).rejects.toThrow();
				expect((await f.query('SELECT * FROM governance_proposals')).rows).toEqual([]);
				expect((await f.query('SELECT * FROM audit_events')).rows).toEqual([]);
			}
			f.setFault('none');
			for (const changed of [{ ...result, id: 'foreign-result' }, { ...result, summary: 'Caller-altered result' }]) {
				await expect(recordAssignmentContentIntegration(store, scope, changed, references)).rejects.toMatchObject({ code: 'assignment_planning_proposal_invalid' });
			}
			await expect(recordAssignmentContentIntegration(store, { ...scope, agentId: 'project/foreign' }, result, references))
				.rejects.toMatchObject({ code: 'assignment_planning_proposal_invalid' });
			await recordAssignmentContentIntegration(store, scope, result, references);
			const proposals = (await f.query('SELECT * FROM governance_proposals')).rows;
			expect(proposals).toHaveLength(1);
			expect(proposals[0]).toMatchObject({ id: definition.id, team_id: scope.teamId, project_id: scope.projectId,
				status: 'draft', created_by_type: 'agent', created_by_id: scope.agentId, active_version: 1,
				active_content_hash: published.digest, title: definition.title, summary: definition.summary, body: definition.request });
			const metadata = typeof proposals[0]!.metadata_json === 'string' ? JSON.parse(proposals[0]!.metadata_json) : proposals[0]!.metadata_json;
			expect(metadata).toMatchObject({ contentProvenance: { repositoryId: target.repository, contentPath: path,
				commitSha: published.commit, digest: published.digest } });
			expect((await f.query('SELECT * FROM governance_proposal_versions')).rows).toHaveLength(1);
			expect((await f.query("SELECT * FROM governance_events WHERE event_type='proposal.created'")).rows).toHaveLength(1);
			expect((await f.query("SELECT * FROM audit_events WHERE event_type='assignment.content.integrated'")).rows).toHaveLength(1);
			const canonical = await getGovernanceProposalMethod.call(store as never, definition.id);
			expect((await readExactProposal(store, canonical!)).definition).toEqual(definition);
			const retained = await f.snapshot(), audits = (await f.query('SELECT * FROM audit_events ORDER BY id')).rows;
			await recordAssignmentContentIntegration(store, scope, result, references);
			expect(await f.snapshot()).toEqual(retained); expect((await f.query('SELECT * FROM audit_events ORDER BY id')).rows).toEqual(audits);
			// Controlled later approval is an input to this recovery test, not a
			// governance/agent approval claim. A lost receipt must not reset it.
			await f.query('DELETE FROM audit_events');
			await f.query("UPDATE governance_proposals SET status='accepted',active_version=2,active_content_hash=?", ['f'.repeat(64)]);
			const advanced = await f.snapshot();
			await recordAssignmentContentIntegration(store, scope, result, references);
			expect(await f.snapshot()).toEqual(advanced);
			expect((await f.query('SELECT * FROM audit_events')).rows).toHaveLength(1);
			const after = await f.snapshot(); expect(after.head).toBe(before.head); expect(after.status).toBe(before.status);
			expect(after.rows.capacity_provider_assignments).toEqual(before.rows.capacity_provider_assignments);
		} finally { await f.close(); vi.unstubAllEnvs(); }
	});

	it('rolls back the original initial proposal and version when its creation event fails, then recovers once', async () => {
		const f = await proposalNativeFixture();
		try {
			const ddl = splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0000_control_plane.sql', 'utf8'));
			const versionDdl = ddl.find(sql => sql.startsWith('CREATE TABLE "governance_proposal_versions" ('));
			if (!versionDdl) throw new Error('Original version DDL required'); await f.query(versionDdl);
			await f.query(`CREATE FUNCTION reject_planning_created() RETURNS trigger AS $$ BEGIN
				RAISE EXCEPTION 'controlled planning creation interruption'; END; $$ LANGUAGE plpgsql;`);
			await f.query('CREATE TRIGGER reject_planning_created BEFORE INSERT ON governance_events FOR EACH ROW EXECUTE FUNCTION reject_planning_created();');
			const store = planningStore(f), input = { id: 'interrupted-planning', projectId: 'project', teamId: 'team',
				request: 'Preserve the original product when creation is interrupted.', createdByType: 'agent', createdById: 'project/portfolio-planner' };
			await expect(createGovernanceProposalMethod.call(store as never, null, input)).rejects.toThrow('controlled planning creation interruption');
			for (const table of ['governance_proposals', 'governance_proposal_versions', 'governance_events']) expect((await f.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
			await f.query('DROP TRIGGER reject_planning_created ON governance_events;');
			await f.query('DROP FUNCTION reject_planning_created();');
			expect(await createGovernanceProposalMethod.call(store as never, null, input)).toMatchObject({ id: input.id, status: 'draft', createdById: input.createdById });
			for (const table of ['governance_proposals', 'governance_proposal_versions', 'governance_events']) expect((await f.query(`SELECT * FROM ${table}`)).rows).toHaveLength(1);
		} finally { await f.close(); }
	});
});
