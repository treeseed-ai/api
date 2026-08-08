import { authorizeApp,createTeamAndProject,createTestApp,createTestPostgresDatabase,createTestStore,describe,expect,it,json } from '../../../../support/api-harness.ts';
import { bindGovernanceTreeDx,completeGovernanceProposalInput } from '../../../../support/governance-proposal.ts';
import { createCapacityControlPlane } from '../../../../../src/api/capacity/control-plane.ts';

describe('market api', () => {
it('lets isolated agent stand-ins question, debate, vote, and create a decision', async () => {
	const db = createTestPostgresDatabase();
	const store = createTestStore(db);
	const app = createTestApp({ db, store });
	const ownerToken = await authorizeApp(app, { principalId: 'evolution-owner', displayName: 'Evolution Test Owner' });
	const proposerToken = await authorizeApp(app, { principalId: 'evolution-proposer-agent', displayName: 'Proposer Agent' });
	const reviewerToken = await authorizeApp(app, { principalId: 'evolution-reviewer-agent', displayName: 'Reviewer Agent' });
	const { team, project } = await createTeamAndProject(app, ownerToken, { slug: 'automated-evolution', name: 'Automated Evolution Test' });
	await bindGovernanceTreeDx(store, team.id, project.id);
	await store.upsertTeamMember(team.id, 'evolution-proposer-agent', 'project_lead');
	await store.upsertTeamMember(team.id, 'evolution-reviewer-agent', 'reviewer');
	const headers = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

	const policy = await json(await app.request(`/v1/projects/${project.id}/governance-policy`, {
		method: 'POST', headers: headers(ownerToken), body: JSON.stringify({
			providerId: 'absolute_threshold_v1',
			config: { minimumParticipatingVoters: 3, quorumPercent: 1, acceptThreshold: 0.66, rejectThreshold: 0.66 },
		}),
	}));
	expect(policy.payload.providerId).toBe('absolute_threshold_v1');

	const proposal = await json(await app.request(`/v1/projects/${project.id}/proposals`, {
		method: 'POST', headers: headers(proposerToken), body: JSON.stringify(completeGovernanceProposalInput({
			title: 'Pilot autonomous Guide evolution',
			summary: 'Exercise isolated editorial governance without granting publication authority.',
			body: 'Agent stand-ins may deliberate and decide inside this acceptance project only. The scenario cannot publish content or grant production authority, and all evidence remains isolated to this project.',
			proposalType: 'editorial-test',
			metadata: { automatedEvolutionTest: true, productionAuthority: false },
		})),
	}));
	expect(proposal.payload.status).toBe('draft');
	await createCapacityControlPlane(store).createStructuredAgentEstimate(proposal.payload.id, {
		id: 'estimate-editorial-test', projectId: project.id, proposalId: proposal.payload.id,
		status: 'accepted', agentClass: 'editorial', agentId: 'evolution-reviewer-agent',
		minSeconds: 300, expectedSeconds: 600, maxSeconds: 900,
		expectedOutputs: [{ outputType: 'editorial-change', required: true }],
		acceptanceCriteria: ['The bounded governance scenario remains unable to publish production content.'],
	});
	const estimateTime = new Date().toISOString();
	await store.run(`INSERT INTO agent_signals
		(id,contract_id,subject_kind,subject_id,team_id,project_id,workday_run_id,assignment_id,agent_id,activity_type,capacity_provider_id,causation_id,correlation_id,origin,changed_paths_json,change_summary,evidence_ref,payload_json,metadata_json,created_at)
		VALUES (?,'proposal-estimated','proposal',?,?,?,?,NULL,?,'estimating',NULL,?,?,'deterministic-handler','[]',?,?,?,'{}',?)`, [
		'estimate-signal-editorial-test', proposal.payload.id, team.id, project.id, null,
		'evolution-reviewer-agent', `proposal:${proposal.payload.id}:estimate`, `proposal:${proposal.payload.id}`,
		'Independent structured estimate completed.', `estimate:${proposal.payload.id}`,
		JSON.stringify({ proposalId: proposal.payload.id, participant: 'evolution-reviewer-agent', expectedSeconds: 600 }), estimateTime,
	]);

	const question = await json(await app.request(`/v1/projects/${project.id}/proposals/${proposal.payload.id}/discussion`, {
		method: 'POST', headers: headers(reviewerToken), body: JSON.stringify({
			kind: 'question', message: 'How is this prevented from approving production publication?', contentContributorRef: 'person:evolution-reviewer-agent', automatedEvolutionTest: true,
		}),
	}));
	const response = await json(await app.request(`/v1/projects/${project.id}/proposals/${proposal.payload.id}/discussion`, {
		method: 'POST', headers: headers(proposerToken), body: JSON.stringify({
			kind: 'response', message: 'The test project has no production publication grant and human chapter gates remain mandatory.', resolvesEventId: question.payload.id, automatedEvolutionTest: true,
		}),
	}));
	expect([question.payload.evidence.kind, response.payload.evidence.kind]).toEqual(['question', 'response']);
	const review = await json(await app.request(`/v1/projects/${project.id}/proposals/${proposal.payload.id}/discussion`, {
		method: 'POST', headers: headers(reviewerToken), body: JSON.stringify({
			kind: 'support', message: 'Independent review confirms the scenario is bounded to this project and cannot publish.', automatedEvolutionTest: true,
		}),
	}));
	expect(review.payload.evidence.kind).toBe('support');

	const opened = await json(await app.request(`/v1/projects/${project.id}/proposals/${proposal.payload.id}/open`, { method: 'POST', headers: headers(proposerToken), body: '{}' }));
	expect(opened).toEqual(expect.objectContaining({ payload: expect.any(Object) }));
	const voting = await json(await app.request(`/v1/projects/${project.id}/proposals/${proposal.payload.id}/start-voting`, { method: 'POST', headers: headers(proposerToken), body: '{}' }));
	expect(voting).toEqual(expect.objectContaining({ payload: expect.any(Object) }));
	for (const [token, reason] of [[ownerToken, 'Human test owner supports the bounded scenario.'], [proposerToken, 'Proposer confirms the boundary.'], [reviewerToken, 'Reviewer accepts after the publication question was answered.']]) {
		const voted = await json(await app.request(`/v1/projects/${project.id}/proposals/${proposal.payload.id}/vote`, {
			method: 'POST', headers: headers(token), body: JSON.stringify({ vote: 'support', reason }),
		}));
		expect(['voting', 'accepted']).toContain(voted.payload.status);
	}
	const resolved = await json(await app.request(`/v1/projects/${project.id}/proposals/${proposal.payload.id}`, { headers: headers(ownerToken) }));
	expect(resolved.payload.status).toBe('accepted');
	expect(resolved.payload.decision).toMatchObject({ status: 'accepted', governanceProviderId: 'absolute_threshold_v1' });
	expect(resolved.payload.events.filter((event: { eventType: string }) => event.eventType === 'proposal.discussion')).toHaveLength(3);
});
});
