import { expect, it, vi } from 'vitest';
import { assignmentAttemptSchema, assignmentResultSchema } from '@treeseed/sdk/agent-capacity';
import { assignment as original } from '../../execution/fixtures/assignment.ts';
import { proposalNativeFixture } from '../../../governance/proposals/architecture/proposal-native-fixture.ts';
import { integrateAssignmentEstimate, readAssignmentEstimateProposal } from '../../../../../../src/api/capacity/services/capacity/assignments/planning/estimates/integration.ts';
import { verifyAssignmentContent, reconcileAssignmentContent } from '../../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-content-readback.ts';
import { readFileSync } from 'node:fs';
import { splitPostgresSqlStatements } from '../../../../../../src/api/persistence/postgres-sql-statements.ts';

// Original SQL, SDK HTTP transport and native committed Git. The remote server
// and admitted attempt are controlled inputs, not live agent or permission proof.
it('reads a subscriber contribution from the proposal owner library while retaining the contributor project and denying foreign ownership or missing write authority', async () => {
	vi.stubEnv('TREESEED_TREEDX_URL', ''); vi.stubEnv('TREESEED_TREEDX_BASE_URL', ''); vi.stubEnv('TREESEED_ENVIRONMENT', 'test');
	const f = await proposalNativeFixture();
	try {
		const proposal = { schemaVersion: 'treeseed.proposal/v2', id: 'proposal', projectId: 'project', groupIds: ['provider-runtime'],
			title: 'Repair the prepared workload handoff', status: 'discussing',
			request: 'Document and repair the shared model request boundary.', summary: 'A second project contributes to the same objective.' };
		const frozen = await f.publish(proposal), source = { store: 'treedx', model: 'proposal', id: proposal.id,
			repository: 'repository', path: 'proposals/proposal.mdx', commit: frozen.commit, revision: 1, digest: `sha256:${frozen.digest}` };
		const attempt = assignmentAttemptSchema.parse({ ...original, id: 'api-own-estimate', projectId: 'api', workItemId: undefined,
			sourceRef: source, contextRefs: [source], effectiveProfile: { ...original.effectiveProfile, activity: 'estimating',
				profileRef: { ...original.effectiveProfile.profileRef, id: 'api/maintenance' } },
			workspace: { mode: 'treedx', workspaceId: 'own-contribution', repository: 'repository', baseCommit: frozen.commit, writablePaths: [source.path] },
			grant: { contentRead: [source], contentWrite: [source], sourceRead: [], sourceWrite: [], tools: [] } });
		const contribution = { ...proposal, executionPlan: { workItems: [{ id: 'repair-api-request', activity: 'acting', objective: proposal.request,
			workspace: 'git', review: 'required', maximumReviewCycles: 2, dependsOn: [],
			estimateRef: { store: 'postgresql', model: 'assignment-attempt', id: attempt.id, revision: attempt.attempt },
			estimate: { expectedSeconds: 120, maximumSeconds: 240, rationale: 'Controlled source input, not generated model usage.' },
			reviewEstimate: { expectedSeconds: 60, maximumSeconds: 120, rationale: 'Controlled independent review budget input.' },
			contextRefs: [{ store: 'git', model: 'repository', id: 'api', repository: 'treeseed-ai/api', commit: frozen.commit }],
			requestedPermissions: { content: { read: ['proposal'], write: [] }, tools: ['source.read', 'source.write'] },
			acceptanceCriteria: ['Implement the documented request boundary in the API project.'] }] } };
		const candidate = f.publishContent(source.path, contribution), assignment = { id: attempt.id, agentId: 'api/maintenance',
			teamId: attempt.teamId, projectId: 'api', assignmentAttempt: attempt };
		const result = assignmentResultSchema.parse({ schemaVersion: 'treeseed.assignment-result/v1', id: 'own-estimate-result',
			assignmentId: attempt.id, status: 'completed', summary: 'Controlled cross-project contribution source.',
			references: [{ kind: 'treedx', projectId: 'project', repository: 'repository', path: source.path,
				commit: candidate.commit, workspaceId: 'own-contribution' }], verification: [], diagnostics: [], usage: { elapsedSeconds: 0 }, completedAt: original.createdAt });
		const projects: string[] = [], store = { ...f.store, getProjectTreeDxLibrary: async (projectId: string) => {
			projects.push(projectId); return projectId === 'project' ? f.store.getProjectTreeDxLibrary() : null;
		} };
		const held = structuredClone({ assignment, result }), before = await f.snapshot();
		expect(await readAssignmentEstimateProposal(store as never, assignment, result)).toEqual(contribution);
		expect(projects).toEqual(['project']); expect(await f.snapshot()).toEqual(before); expect({ assignment, result }).toEqual(held);
		await expect(readAssignmentEstimateProposal(store as never, { ...assignment, assignmentAttempt: { ...attempt,
			grant: { ...attempt.grant, contentWrite: [] } } }, result)).rejects.toMatchObject({ code: 'assignment_estimate_reference_invalid' });
		const foreign = { ...result, references: result.references.map(reference => ({ ...reference, projectId: 'foreign' })) };
		await expect(readAssignmentEstimateProposal(store as never, assignment, foreign)).rejects.toMatchObject({ code: 'assignment_estimate_proposal_mismatch' });
		// A controlled already-integrated current version proves unchanged replay,
		// not the initial authoring/publishing path or a generated agent estimate.
		await f.query('UPDATE governance_proposals SET active_version=2,active_content_hash=?,metadata_json=?', [candidate.digest,
			JSON.stringify({ contentProvenance: { repositoryId: 'repository', contentPath: source.path, commitSha: candidate.commit, digest: candidate.digest } })]);
		const integrationStore = { ...store, getGovernanceProposal: async (id: string) => {
			const value = await f.store.first('SELECT * FROM governance_proposals WHERE id=?', [id]);
			return value ? { ...value, teamId: value.team_id, projectId: value.project_id, activeVersion: value.active_version,
				activeContentHash: value.active_content_hash, metadata: JSON.parse(String(value.metadata_json)) } : null;
		}, updateGovernanceProposalDraft: async () => { throw new Error('Unchanged replay cannot author another version'); },
			evaluateGovernanceProposal: async () => { throw new Error('Replay cannot fabricate approval'); } };
		const integrated = await f.snapshot();
		await integrateAssignmentEstimate(integrationStore as never, assignment as never, result);
		expect(await f.snapshot()).toEqual(integrated);
		const completionStore = { ...store, run: (sql: string, parameters?: unknown[]) => f.query(sql, parameters) };
		expect(await verifyAssignmentContent(completionStore as never, assignment, result)).toEqual(result.references);
		const auditDdl = splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0000_control_plane.sql', 'utf8'))
			.find(sql => sql.startsWith('CREATE TABLE "audit_events" ('));
		if (!auditDdl) throw new Error('Original audit DDL required'); await f.query(auditDdl);
		await f.query(`INSERT INTO capacity_provider_assignments
			(id,membership_id,team_id,project_id,capacity_provider_id,project_agent_class_id,mode,status,agent_id,work_day_id,
			assignment_attempt_json,assignment_result_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			[assignment.id, 'controlled-membership', assignment.teamId, assignment.projectId, 'controlled-provider', 'maintenance', 'planning', 'completed',
				assignment.agentId, 'cross-workday', JSON.stringify(attempt), JSON.stringify(result), original.createdAt, original.createdAt]);
		const completed = await f.snapshot();
		await reconcileAssignmentContent(completionStore, assignment.teamId, 'cross-workday');
		const audits = (await f.query('SELECT * FROM audit_events ORDER BY id')).rows;
		expect(audits).toHaveLength(1); expect(JSON.parse(String(audits[0]!.data_json))).toEqual({ resultId: result.id, references: result.references, publication: false });
		const reads = f.requests.length;
		await reconcileAssignmentContent(completionStore, assignment.teamId, 'cross-workday');
		expect((await f.query('SELECT * FROM audit_events ORDER BY id')).rows).toEqual(audits);
		expect(f.requests).toHaveLength(reads); expect(await f.snapshot()).toEqual(completed);
		// A later real contribution from the same subscriber keeps the original
		// product's measured-attempt custody while adding its own new provenance.
		const nextSource = { ...source, commit: candidate.commit, digest: `sha256:${candidate.digest}`, revision: 2 };
		const nextAttempt = assignmentAttemptSchema.parse({ ...attempt, id: 'api-additional-estimate', sourceRef: nextSource,
			contextRefs: [nextSource], workspace: { ...attempt.workspace, baseCommit: candidate.commit },
			grant: { ...attempt.grant, contentRead: [nextSource], contentWrite: [nextSource] } });
		const additional = { ...contribution.executionPlan.workItems[0]!, id: 'repair-api-history-routing',
			estimateRef: { store: 'postgresql', model: 'assignment-attempt', id: nextAttempt.id, revision: nextAttempt.attempt } };
		const combined = { ...contribution, executionPlan: { workItems: [...contribution.executionPlan.workItems, additional] } };
		const nextCommit = f.publishContent(source.path, combined);
		const nextAssignment = { ...assignment, id: nextAttempt.id, assignmentAttempt: nextAttempt };
		const nextResult = assignmentResultSchema.parse({ ...result, id: 'additional-estimate-result', assignmentId: nextAttempt.id,
			references: result.references.map(reference => ({ ...reference, commit: nextCommit.commit })) });
		await f.query('UPDATE governance_proposals SET active_version=3,active_content_hash=?,metadata_json=?', [nextCommit.digest,
			JSON.stringify({ contentProvenance: { repositoryId: 'repository', contentPath: source.path, commitSha: nextCommit.commit, digest: nextCommit.digest } })]);
		const retained = await f.snapshot();
		expect(await readAssignmentEstimateProposal(store as never, nextAssignment, nextResult)).toEqual(combined);
		await integrateAssignmentEstimate(integrationStore as never, nextAssignment as never, nextResult);
		await integrateAssignmentEstimate(integrationStore as never, nextAssignment as never, nextResult);
		expect(await f.snapshot()).toEqual(retained);
		const forged = f.publishContent(source.path, { ...combined, executionPlan: { workItems: [
			{ ...contribution.executionPlan.workItems[0]!, estimate: { expectedSeconds: 150, maximumSeconds: 240, rationale: 'Forged earlier measurement.' } }, additional,
		] } });
		const deniedCheckpoint = await f.snapshot();
		await expect(integrateAssignmentEstimate(integrationStore as never, nextAssignment as never, { ...nextResult,
			references: nextResult.references.map(reference => ({ ...reference, commit: forged.commit })) }))
			.rejects.toMatchObject({ code: 'assignment_estimate_owner_missing' });
		expect(await f.snapshot()).toEqual(deniedCheckpoint);
		for (const change of [{ id: 'other-proposal' }, { projectId: 'foreign' }]) {
			const altered = f.publishContent(source.path, { ...contribution, ...change }), checkpoint = await f.snapshot();
			const changed = { ...result, references: result.references.map(reference => ({ ...reference, commit: altered.commit })) };
			await expect(readAssignmentEstimateProposal(store as never, assignment, changed)).rejects.toMatchObject({ code: 'assignment_estimate_content_invalid' });
			expect(await f.snapshot()).toEqual(checkpoint);
		}
		await f.query("UPDATE governance_proposals SET team_id='foreign'");
		const denied = await f.snapshot();
		await expect(readAssignmentEstimateProposal(store as never, assignment, result)).rejects.toMatchObject({ code: 'assignment_estimate_proposal_mismatch' });
		expect(await f.snapshot()).toEqual(denied); expect({ assignment, result }).toEqual(held);
	} finally { await f.close(); vi.unstubAllEnvs(); }
});
