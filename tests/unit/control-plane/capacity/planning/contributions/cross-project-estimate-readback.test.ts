import { expect, it, vi } from 'vitest';
import { assignmentAttemptSchema, assignmentResultSchema } from '@treeseed/sdk/agent-capacity';
import { assignment as original } from '../../execution/fixtures/assignment.ts';
import { proposalNativeFixture } from '../../../governance/proposals/architecture/proposal-native-fixture.ts';
import { integrateAssignmentEstimate, readAssignmentEstimateProposal } from '../../../../../../src/api/capacity/services/capacity/assignments/planning/estimates/integration.ts';

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
