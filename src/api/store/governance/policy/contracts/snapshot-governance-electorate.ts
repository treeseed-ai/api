import { governanceVotingProvider } from '@treeseed/sdk';
import { randomUUID } from 'node:crypto';
import { isoNow,MarketControlPlaneStore,serializeGovernanceElectorateSnapshot } from "../../../../persistence/store.ts";
export async function snapshotGovernanceElectorateMethod(this: MarketControlPlaneStore, proposalId) {
    await this.ensureInitialized();
    const proposal = await this.getGovernanceProposal(proposalId);
    if (!proposal)
        return null;
    const provider = governanceVotingProvider(proposal.governanceProviderId);
    const policy = proposal.projectId ? await this.getProjectGovernancePolicy(proposal.projectId) : await this.getTeamGovernancePolicy(proposal.teamId, proposal.scope === 'commons' ? 'commons' : 'team');
    const eligibleVoters = await this.governanceEligibleVoters(proposal.teamId, provider.id);
    const delegations = await this.activeGovernanceDelegationSnapshots(proposal.teamId, proposal.scope);
    const snapshot = await provider.snapshotElectorate({
        teamId: proposal.teamId,
        projectId: proposal.projectId,
        scope: proposal.scope,
        proposalType: proposal.proposalType,
        providerConfig: policy?.config ?? {},
        eligibleVoters,
        delegations,
        createdAt: isoNow(),
    });
    const id = randomUUID();
    await this.run(`INSERT INTO governance_electorate_snapshots (
				id, proposal_id, proposal_version, provider_id, provider_version, rule_snapshot_json, chambers_json,
				eligible_voters_json, delegations_json, eligible_weight_total, active_weight_total, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        proposal.id,
        proposal.activeVersion,
        snapshot.providerId,
        snapshot.providerVersion,
        JSON.stringify(snapshot.ruleSnapshot),
        JSON.stringify(snapshot.chambers),
        JSON.stringify(snapshot.eligibleVoters),
        JSON.stringify(snapshot.delegations),
        snapshot.chambers.reduce((total, chamber) => total + Number(chamber.eligibleWeightTotal ?? 0), 0),
        snapshot.chambers.reduce((total, chamber) => total + Number(chamber.activeWeightTotal ?? 0), 0),
        snapshot.createdAt,
    ]);
    await this.recordGovernanceEvent({
        eventType: 'governance.electorate_snapshotted',
        actorType: 'system',
        teamId: proposal.teamId,
        projectId: proposal.projectId,
        proposalId: proposal.id,
        proposalVersion: proposal.activeVersion,
        evidence: { snapshotId: id, providerId: provider.id },
    });
    return serializeGovernanceElectorateSnapshot(await this.first(`SELECT * FROM governance_electorate_snapshots WHERE id = ? LIMIT 1`, [id]));
}
