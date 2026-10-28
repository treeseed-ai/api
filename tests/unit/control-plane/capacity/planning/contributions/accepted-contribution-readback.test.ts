import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { subscriberSourceFixture, subscriberSourceProposal } from '../../../governance/proposals/architecture/native-subscriber-inputs.ts';
import { readyContributionProposal } from '../../../governance/proposals/architecture/ready-proposal-fixture.ts';
import { compileWorkdayAgentProfileSnapshot } from '../../../../../../src/api/capacity/services/capacity/workdays/policy/workday-agent-profile-policy.ts';
import { loadProposalGroupContributions } from '../../../../../../src/api/capacity/services/capacity/execution/proposal-contributions.ts';
import { splitPostgresSqlStatements } from '../../../../../../src/api/persistence/postgres-sql-statements.ts';

it('keeps accepted contribution owners and their original profiles after team growth while drafts require the newcomer', async () => {
	vi.stubEnv('TREESEED_TREEDX_URL', ''); vi.stubEnv('TREESEED_TREEDX_BASE_URL', ''); vi.stubEnv('TREESEED_ENVIRONMENT', 'test');
	const f = await subscriberSourceFixture();
	try {
		for (const sql of splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0031_workday_execution_mode_authority.sql', 'utf8'))) await f.query(sql);
		const definition = subscriberSourceProposal(readyContributionProposal());
		const exact = await f.publishCurrent(definition);
		const classes = (await f.query('SELECT * FROM project_agent_classes ORDER BY id')).rows;
		const snapshot = compileWorkdayAgentProfileSnapshot(classes.map(row => ({ ...row,
			handlerRefs: JSON.parse(String(row.handler_refs_json)) })), undefined, definition.groupIds);
		const assignments = (await f.query('SELECT id,assignment_attempt_json FROM capacity_provider_assignments ORDER BY id')).rows
			.map(row => ({ id: String(row.id), attempt: assignmentAttemptSchema.parse(JSON.parse(String(row.assignment_attempt_json))) }));
		const at = assignments[0]!.attempt.createdAt;
		for (const id of new Set(assignments.map(row => row.attempt.workdayId))) await f.query(`INSERT INTO capacity_workday_runs
			(id,team_id,capacity_provider_id,status,execution_kind,execution_mode,trigger_kind,parameters_json,created_at,updated_at)
			VALUES (?,?,?,?,?,?,?,?,?,?)`, [id, 'team', 'controlled-provider', 'completed', 'workday', 'simulation', 'manual',
				JSON.stringify({ scheduledProjectIds: ['project'], agentProfilesByProjectId: { project: snapshot } }), at, at]);
		for (const row of assignments) await f.query('UPDATE capacity_provider_assignments SET work_day_id=? WHERE id=?', [row.attempt.workdayId, row.id]);
		await f.query("UPDATE governance_proposals SET status='accepted',decision_id='original-decision' WHERE id='proposal'");
		await f.query(`INSERT INTO governance_decisions
			(id,team_id,project_id,proposal_id,proposal_version,proposal_content_hash,status,title,summary,governance_provider_id,decision_record_json,created_at,updated_at)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, ['original-decision', 'team', 'project', 'proposal', 1, exact.digest, 'accepted',
				'Controlled accepted source', 'Component input; no live approval or agent work claimed.', 'default', '{}', at, at]);
		const subject = { id: 'proposal', teamId: 'team', projectId: 'project' };
		const before = await loadProposalGroupContributions(f.store as never, subject, definition);
		expect(before.current).toBe(true);
		const first = classes[0]!, handler = JSON.parse(String(first.handler_refs_json));
		const newcomer = { ...handler.agents[0], id: 'project/newcomer', name: 'New subscriber' };
		await f.query('UPDATE project_agent_classes SET handler_refs_json=? WHERE id=?',
			[JSON.stringify({ ...handler, agents: [...handler.agents, newcomer] }), first.id]);
		const held = await f.snapshot();
		await expect(loadProposalGroupContributions(f.store as never, subject, definition)).resolves.toMatchObject({
			current: false, missing: ['project/project/newcomer'] });
		const accepted = await loadProposalGroupContributions(f.store as never, { ...subject, decisionId: 'original-decision' }, definition);
		expect(accepted).toMatchObject({ current: true, missing: [] });
		expect(accepted.profiles).toEqual(before.profiles);
		expect(accepted.attempts.map(row => row.id).sort()).toEqual(assignments.map(row => row.id).sort());
		expect(await f.snapshot()).toEqual(held);
	} finally { await f.close(); vi.unstubAllEnvs(); }
});
