import { expect, it, vi } from 'vitest';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { subscriberSourceFixture, subscriberSourceProposal } from '../../../governance/proposals/architecture/native-subscriber-inputs.ts';
import { readyContributionProposal } from '../../../governance/proposals/architecture/ready-proposal-fixture.ts';
import { compileWorkdayAgentProfileSnapshot } from '../../../../../../src/api/capacity/services/capacity/workdays/policy/workday-agent-profile-policy.ts';
import { loadProposalGroupContributions } from '../../../../../../src/api/capacity/services/capacity/execution/proposal-contributions.ts';
import { projectTeamExecutionGraph, type ExecutableProposalSource } from '../../../../../../src/api/capacity/policy/execution/execution-graph-projector.ts';

it('keeps accepted contribution owners and their original profiles after team growth while drafts require the newcomer', async () => {
	vi.stubEnv('TREESEED_TREEDX_URL', ''); vi.stubEnv('TREESEED_TREEDX_BASE_URL', ''); vi.stubEnv('TREESEED_ENVIRONMENT', 'test');
	const f = await subscriberSourceFixture();
	try {
		const definition = subscriberSourceProposal(readyContributionProposal());
		const exact = await f.publishCurrent(definition);
		const classes = (await f.query('SELECT * FROM project_agent_classes ORDER BY id')).rows;
		const snapshot = compileWorkdayAgentProfileSnapshot(classes.map(row => ({ ...row,
			handlerRefs: JSON.parse(String(row.handler_refs_json)) })), undefined, definition.groupIds);
		const assignments = (await f.query('SELECT id,assignment_attempt_json FROM capacity_provider_assignments ORDER BY id')).rows
			.map(row => ({ id: String(row.id), attempt: assignmentAttemptSchema.parse(JSON.parse(String(row.assignment_attempt_json))) }));
		const at = assignments[0]!.attempt.createdAt;
		await f.query("UPDATE governance_proposals SET status='accepted',decision_id='original-decision' WHERE id='proposal'");
		await f.query(`INSERT INTO governance_decisions
			(id,team_id,project_id,proposal_id,proposal_version,proposal_content_hash,status,title,summary,governance_provider_id,decision_record_json,created_at,updated_at)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, ['original-decision', 'team', 'project', 'proposal', 1, exact.digest, 'accepted',
				'Controlled accepted source', 'Component input; no live approval or agent work claimed.', 'default', '{}', at, at]);
		const subject = { id: 'proposal', teamId: 'team', projectId: 'project' };
		const before = await loadProposalGroupContributions(f.store as never, subject, definition);
		expect(before.current).toBe(true);
		const source: ExecutableProposalSource = { teamId: 'team', projectId: 'project', repository: 'repository',
			path: 'proposals/proposal.mdx', commit: exact.commit, digest: `sha256:${exact.digest}`, proposalRevision: 1,
			frontmatter: definition, estimatingAttempts: before.attempts, profiles: before.profiles,
			decision: { id: 'original-decision', revision: 1, current: true, digest: `sha256:${'d'.repeat(64)}`,
				repository: 'repository', commit: exact.commit, path: 'decisions/original-decision.mdx' } };
		const originalGraph = projectTeamExecutionGraph({ teamId: 'team', revision: 1, createdAt: at, sources: [source], profiles: before.profiles });
		const first = classes[0]!, handler = JSON.parse(String(first.handler_refs_json));
		handler.agents[0].activityProfiles.planning.prompt.system += '\nFuture planning instructions must not replace accepted profiles.';
		const newcomer = { ...handler.agents[0], id: 'project/newcomer', name: 'New subscriber' };
		await f.query('UPDATE project_agent_classes SET handler_refs_json=? WHERE id=?',
			[JSON.stringify({ ...handler, agents: [...handler.agents, newcomer] }), first.id]);
		const held = await f.snapshot();
		const draft = await loadProposalGroupContributions(f.store as never, subject, definition);
		expect(draft).toMatchObject({ current: false, missing: ['project/project/newcomer'] });
		const accepted = await loadProposalGroupContributions(f.store as never, { ...subject, decisionId: 'original-decision' }, definition);
		expect(accepted).toMatchObject({ current: true, missing: [] });
		expect(accepted.profiles).toEqual(before.profiles);
		expect(accepted.attempts.map(row => row.id).sort()).toEqual(assignments.map(row => row.id).sort());
		expect(projectTeamExecutionGraph({ teamId: 'team', revision: 1, createdAt: at, profiles: draft.profiles,
			sources: [{ ...source, profiles: accepted.profiles, estimatingAttempts: accepted.attempts }] })).toEqual(originalGraph);
		for (const fault of ['missing-workday', 'foreign-workday', 'corrupt-snapshot', 'wrong-agent', 'wrong-class', 'wrong-project', 'superseded-decision', 'stale-version'] as const) {
			await f.query('BEGIN');
			try {
				if (fault === 'missing-workday') await f.query('DELETE FROM capacity_workday_runs');
				if (fault === 'foreign-workday') await f.query("UPDATE capacity_workday_runs SET team_id='foreign'");
				if (fault === 'corrupt-snapshot') await f.query('UPDATE capacity_workday_runs SET parameters_json=?',
					[JSON.stringify({ agentProfilesByProjectId: { project: { ...snapshot, revision: 'corrupted' } } })]);
				if (fault === 'wrong-agent') await f.query("UPDATE capacity_provider_assignments SET agent_id='project/impostor'");
				if (fault === 'wrong-class') await f.query("UPDATE capacity_provider_assignments SET project_agent_class_id='foreign'");
				if (fault === 'wrong-project') await f.query("UPDATE capacity_provider_assignments SET project_id='foreign'");
				if (fault === 'superseded-decision') await f.query('UPDATE governance_decisions SET superseded_at=?', [at]);
				if (fault === 'stale-version') await f.query('UPDATE governance_proposals SET active_version=active_version+1');
				const observation = loadProposalGroupContributions(f.store as never, { ...subject, decisionId: 'original-decision' }, definition);
				if (fault === 'corrupt-snapshot') await expect(observation).rejects.toMatchObject({ code: 'capacity_workday_agent_profile_snapshot_invalid' });
				else if (fault === 'superseded-decision' || fault === 'stale-version') await expect(observation).rejects.toMatchObject({ code: 'governance_execution_authority_stale' });
				else await expect(observation).resolves.toMatchObject({ current: false });
			} finally { await f.query('ROLLBACK'); }
			expect(await f.snapshot()).toEqual(held);
		}
		for (const fault of ['moved', 'denied'] as const) {
			f.setFault(fault);
			await expect(loadProposalGroupContributions(f.store as never, { ...subject, decisionId: 'original-decision' }, definition)).rejects.toThrow();
			f.setFault('none');
		}
		expect(await f.snapshot()).toEqual(held);
	} finally { await f.close(); vi.unstubAllEnvs(); }
});
