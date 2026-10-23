import { expect, it, vi } from 'vitest';
import { proposalNativeFixture } from '../../../../../governance/proposals/architecture/proposal-native-fixture.ts';
import { readyProposal } from '../../../../../governance/proposals/architecture/ready-proposal-fixture.ts';
import { preflightCapacityWorkdayRun } from '../../../../../../../../src/api/capacity/services/capacity/workdays/scheduling/workday-scheduling-service.ts';
import { compileCapacityWorkdayRunRecord } from '../../../../../../../../src/api/capacity/services/capacity/workdays/scheduling/workday-run-service.ts';
import { governanceProposalReadinessMethod, assertGovernanceProposalReady } from '../../../../../../../../src/api/store/governance/policy/contracts/governance-proposal-readiness.ts';

// Native SQL, exact committed content and the official HTTP reader. Membership
// is a controlled input; no authenticated admission or agent execution claimed.
it('refuses new work from retained class-targeted proposals before selecting profiles while preserving exact source history', async () => {
	vi.stubEnv('TREESEED_TREEDX_URL',''); vi.stubEnv('TREESEED_TREEDX_BASE_URL',''); vi.stubEnv('TREESEED_ENVIRONMENT','test');
	const f = await proposalNativeFixture();
	try {
		const definition = { ...readyProposal(), id: 'proposal', projectId: 'project', groupIds: ['provider-runtime'] };
		const frozen = await f.publish(definition), classes = vi.fn(async () => { throw new Error('Legacy class audience must not be selected'); });
		const store = { ...f.store, ensureInitialized: async () => {},
			first: async (sql: string, parameters?: unknown[]) => sql.includes('capacity_provider_team_memberships') ? { id: 'controlled-membership' } : f.store.first(sql, parameters),
			getGovernanceProposal: async (id: string) => {
				const value = await f.store.first('SELECT * FROM governance_proposals WHERE id=?',[id]);
				return value ? { ...value, teamId: value.team_id, projectId: value.project_id, activeVersion: value.active_version,
					activeContentHash: value.active_content_hash, metadata: JSON.parse(String(value.metadata_json)) } : null;
			}, listTeamProjects: async () => [{ id: 'project', slug: 'project' }], listProjectAgentClassesPage: classes,
			getProjectTreeDxLibrary: async () => ({ ...await f.store.getProjectTreeDxLibrary(), metadata: { resolvedRef: frozen.commit } }) };
		const run = compileCapacityWorkdayRunRecord('team', { id: 'new-workday', capacityProviderId: 'controlled-provider', executionMode: 'simulation',
			parameters: { projects: ['project'], proposalIds: ['proposal'], groupIds: ['provider-runtime'], durationSeconds: 600 } });
		const before = await f.snapshot();
		const readiness = await governanceProposalReadinessMethod.call(store as never, 'proposal');
		expect(readiness).toMatchObject({ contentReady: true, votingReady: false, executionPlanReady: false,
			missingParticipantEstimates: ['subscriber-owned group contribution plan'] });
		await expect(assertGovernanceProposalReady.call({ ...store, governanceProposalReadiness: (id: string) => governanceProposalReadinessMethod.call(store as never, id) } as never,
			'proposal', 'voting')).rejects.toMatchObject({ status: 409, code: 'governance_proposal_not_ready' });
		await expect(preflightCapacityWorkdayRun(store as never, run)).rejects.toMatchObject({ code: 'capacity_workday_proposal_version_unsupported' });
		const unscoped = compileCapacityWorkdayRunRecord('team', { id: 'unscoped', capacityProviderId: 'controlled-provider', executionMode: 'simulation',
			parameters: { projects: ['project'], durationSeconds: 600 } });
		await expect(preflightCapacityWorkdayRun(store as never, unscoped)).rejects.toMatchObject({ code: 'capacity_workday_group_required' });
		expect(classes).not.toHaveBeenCalled(); expect(await f.snapshot()).toEqual(before);
		expect(f.requests).toEqual(Array.from({ length: 3 }, () => ({ ref: frozen.commit, path: 'proposals/proposal.mdx' })));
	} finally { await f.close(); vi.unstubAllEnvs(); }
});
