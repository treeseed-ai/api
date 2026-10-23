import { expect, it, vi } from 'vitest';
import { proposalNativeFixture } from '../../../../../governance/proposals/architecture/proposal-native-fixture.ts';
import { readyProposal } from '../../../../../governance/proposals/architecture/ready-proposal-fixture.ts';
import { preflightCapacityWorkdayRun } from '../../../../../../../../src/api/capacity/services/capacity/workdays/scheduling/workday-scheduling-service.ts';
import { compileCapacityWorkdayRunRecord } from '../../../../../../../../src/api/capacity/services/capacity/workdays/scheduling/workday-run-service.ts';

// Original SQL, committed Git and official HTTP reader. Membership and configured
// profiles are controlled inputs, not authenticated admission or model execution.
it('derives every accepted proposal group from exact decision authority without importing outsiders or narrowing to an explicit subset', async () => {
	vi.stubEnv('TREESEED_TREEDX_URL', ''); vi.stubEnv('TREESEED_TREEDX_BASE_URL', ''); vi.stubEnv('TREESEED_ENVIRONMENT', 'test');
	const f = await proposalNativeFixture();
	try {
		const base = readyProposal(), { agentClass: _class, ...item } = base.executionPlan.workItems[0]!;
		const definition = { ...base, schemaVersion: 'treeseed.proposal/v2', groupIds: ['provider-runtime', 'portfolio-ui'],
			executionPlan: { workItems: [{ ...item, estimate: { ...item.estimate, rationale: 'Controlled own implementation estimate.' },
				reviewEstimate: { ...item.reviewEstimate, rationale: 'Controlled own independent review estimate.' }, estimateRef: { store: 'postgresql', model: 'assignment-attempt', id: 'controlled-estimate', revision: 1 } }] } };
		const frozen = await f.publish(definition), proposalRef = { store: 'treedx', model: 'proposal', id: 'proposal', revision: 1,
			digest: `sha256:${frozen.digest}`, repository: 'repository', commit: frozen.commit, path: 'proposals/proposal.mdx' };
		await f.query("UPDATE governance_proposals SET status='accepted' WHERE id='proposal'");
		const user = { store: 'postgresql', model: 'user', id: 'operator' }, now = '2026-10-23T12:00:00.000Z';
		const content = f.publishContent('decisions/decision.mdx', { schemaVersion: 'treeseed.decision/v1', id: 'decision', projectId: 'project',
			decisionClass: 'proposal', decisionMethod: 'authority', subjectRef: proposalRef, disposition: 'approved',
			rationale: 'Controlled admission input, not real work approval.', authorityRefs: [user], decidedByRefs: [user], decidedAt: now });
		const decisionRef = { store: 'treedx', model: 'decision', id: 'decision', revision: 1, repository: 'repository',
			commit: content.commit, path: 'decisions/decision.mdx', digest: `sha256:${content.digest}` };
		await f.query(`INSERT INTO governance_decisions (id,team_id,project_id,proposal_id,proposal_version,proposal_content_hash,
			status,title,summary,governance_provider_id,decision_record_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			['decision', 'team', 'project', 'proposal', 1, frozen.digest, 'accepted', 'Controlled admission', 'No agent work supplied', 'default',
				JSON.stringify({ proposalRef, decisionRef, decisionDependencies: [] }), now, now]);
		const profile = { handler: 'writer', prompt: { system: 'Contribute useful source work.' }, permissions: { content: { read: ['proposal'], write: [] }, tools: [] } };
		const agents = definition.groupIds.map((group, index) => ({ schemaVersion: 'treeseed.agent/v1', id: `project/member-${index}`, name: `Member ${index}`,
			agentClass: 'maintenance', purpose: 'Deliver useful project source.', responsibilities: ['Own a contribution.'], capabilities: ['source-repair'],
			context: { include: ['project'] }, groupIds: [group], activityProfiles: { planning: profile, estimating: profile, acting: profile, reviewing: profile,
				reporting: { ...profile, handler: 'reporter', dependsOn: { events: ['workday-closing'] } } } }));
		const store = { ...f.store, ensureInitialized: async () => {},
			first: async (sql: string, parameters?: unknown[]) => sql.includes('capacity_provider_team_memberships') ? { id: 'controlled-membership' } : f.store.first(sql, parameters),
			getGovernanceProposal: async () => { const row = await f.store.first("SELECT * FROM governance_proposals WHERE id='proposal'");
				return row ? { ...row, teamId: row.team_id, projectId: row.project_id } : null; },
			listTeamProjects: async () => [{ id: 'project', slug: 'project' }],
			listProjectAgentClassesPage: async () => ({ items: [{ id: 'allocation', slug: 'maintenance', handlerRefs: { agents: [...agents,
				{ id: 'outside', groupIds: ['unrelated'], invalid: 'Must never enter this audience' }] } }], page: { hasMore: false, nextCursor: null } }),
			getProjectTreeDxLibrary: async () => ({ ...await f.store.getProjectTreeDxLibrary(), metadata: { resolvedRef: content.commit } }) };
		const before = await f.snapshot();
		for (const groupIds of [undefined, ['provider-runtime']]) {
			const run = compileCapacityWorkdayRunRecord('team', { id: 'new-workday', capacityProviderId: 'controlled-provider', executionMode: 'simulation',
				parameters: { projects: ['project'], decisionIds: ['decision'], ...(groupIds ? { groupIds } : {}), durationSeconds: 600 } });
			const preflight = await preflightCapacityWorkdayRun(store as never, run);
			expect(preflight.agentProfilesByProjectId.project.agents.map(entry => entry.definition.id)).toEqual(agents.map(agent => agent.id));
			expect(await f.snapshot()).toEqual(before);
		}
		f.setFault('moved');
		const run = compileCapacityWorkdayRunRecord('team', { id: 'new-workday', capacityProviderId: 'controlled-provider', executionMode: 'simulation',
			parameters: { projects: ['project'], decisionIds: ['decision'], durationSeconds: 600 } });
		await expect(preflightCapacityWorkdayRun(store as never, run)).rejects.toMatchObject({ code: 'governance_decision_content_invalid' });
		expect(await f.snapshot()).toEqual(before);
	} finally { await f.close(); vi.unstubAllEnvs(); }
});
