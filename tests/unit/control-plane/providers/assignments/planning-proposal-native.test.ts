import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { assignmentAttemptSchema, assignmentResultSchema } from '@treeseed/sdk/agent-capacity';
import { assignment as original } from '../../capacity/execution/fixtures/assignment.ts';
import { proposalNativeFixture } from '../../governance/proposals/architecture/proposal-native-fixture.ts';
import { splitPostgresSqlStatements } from '../../../../../src/api/persistence/postgres-sql-statements.ts';
import { verifyAssignmentContent, recordAssignmentContentIntegration } from '../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-content-readback.ts';

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
			const definition = { schemaVersion: 'treeseed.proposal/v2', id: 'planning-product', projectId: 'project',
				title: 'Retrieve the original reviewed Git product', summary: 'Expose the existing exporter through the shared backend.',
				request: 'Allow coordinators to retrieve the retained Engineer product without private host exports.',
				status: 'discussing', groupIds: ['portfolio-delivery'], executionPlan: { workItems: [{ id: 'download-contract',
					activity: 'acting', objective: 'Document the authenticated retained-product download contract.',
					workspace: 'treedx', review: 'required', maximumReviewCycles: 2, dependsOn: [],
					acceptanceCriteria: ['Preserve the original assignment, result, repository, base and head identity.'] }] } };
			const path = 'proposals/planning-product.mdx', published = f.publishContent(path, definition);
			const target = { store: 'treedx', model: 'proposal', id: definition.id, repository: 'repository',
				commit: published.commit, path };
			const attempt = assignmentAttemptSchema.parse({ ...original, id: 'planning-assignment', teamId: 'team', projectId: 'project',
				status: 'completed', effectiveProfile: { ...original.effectiveProfile, activity: 'planning', handler: 'writer',
					profileRef: { store: 'treedx', model: 'agent', id: 'project/portfolio-planner', repository: 'repository',
						commit: published.commit, path: 'agents/portfolio-planner.mdx' } },
				workspace: { mode: 'treedx', workspaceId: 'planning-workspace', repository: 'repository',
					baseCommit: published.commit, writablePaths: [path] },
				grant: { contentRead: [], contentWrite: [target], sourceRead: [], sourceWrite: [], tools: [] } });
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
			const store = { ...f.store, run: (sql: string, params: unknown[] = []) => f.query(sql, params) };
			const before = await f.snapshot();
			const references = await verifyAssignmentContent(store, scope, result);
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
			const after = await f.snapshot(); expect(after.head).toBe(before.head); expect(after.status).toBe(before.status);
			expect(after.rows.capacity_provider_assignments).toEqual(before.rows.capacity_provider_assignments);
		} finally { await f.close(); vi.unstubAllEnvs(); }
	});
});
