import { randomUUID } from 'node:crypto';
import { isoNow,MarketControlPlaneStore,serializeGovernanceDecision } from "../../../../persistence/store.ts";
export async function createGovernanceDecisionFromProposalMethod(this: MarketControlPlaneStore, proposalId, input: any = {}) {
    await this.ensureInitialized();
    const proposal = await this.getGovernanceProposal(proposalId);
    if (!proposal)
        return null;
    const existing = await this.first(`SELECT * FROM governance_decisions WHERE proposal_id = ? LIMIT 1`, [proposalId]);
    if (existing?.id)
        return serializeGovernanceDecision(existing);
    const timestamp = isoNow();
    const id = randomUUID();
    const votes = await this.effectiveGovernanceVotes(proposal) as Array<{
        userId: string;
        vote: string;
        reason?: string | null;
    }>;
    const voterReasons = votes.filter((vote) => vote.reason).map((vote) => ({ userId: vote.userId, vote: vote.vote, reason: vote.reason }));
    const proposalSnapshot = {
        title: proposal.title,
        summary: proposal.summary,
        body: proposal.body,
        proposalType: proposal.proposalType,
        contentHash: proposal.activeContentHash,
        version: proposal.activeVersion,
    };
    await this.run(`INSERT INTO governance_decisions (
				id, team_id, project_id, proposal_id, proposal_version, proposal_content_hash, status,
				title, summary, content_decision_slug, governance_provider_id, governance_rule_json,
				electorate_snapshot_id, vote_result_json, voter_reasons_json, proposal_snapshot_json,
				decision_record_json, created_by_type, created_by_id, created_at, updated_at, superseded_at
			) VALUES (?, ?, ?, ?, ?, ?, 'accepted', ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, NULL)`, [
        id,
        proposal.teamId,
        proposal.projectId,
        proposal.id,
        proposal.activeVersion,
        proposal.activeContentHash,
        proposal.title,
        proposal.summary,
        proposal.contentDecisionSlug,
        proposal.governanceProviderId,
        JSON.stringify(input.outcome?.voteResult?.chambers ? { providerId: proposal.governanceProviderId } : {}),
        input.electorateSnapshotId ?? null,
        JSON.stringify(input.outcome?.voteResult ?? {}),
        JSON.stringify(voterReasons),
        JSON.stringify(proposalSnapshot),
        input.actorType ?? 'system',
        input.actorId ?? null,
        timestamp,
        timestamp,
    ]);
    await this.run(`UPDATE governance_proposals SET decision_id = ?, updated_at = ? WHERE id = ?`, [id, timestamp, proposal.id]);
    await this.recordGovernanceEvent({
        eventType: 'decision.created',
        actorType: input.actorType ?? 'system',
        actorId: input.actorId ?? null,
        teamId: proposal.teamId,
        projectId: proposal.projectId,
        proposalId: proposal.id,
        decisionId: id,
        proposalVersion: proposal.activeVersion,
        nextState: 'accepted',
        evidence: { proposalContentHash: proposal.activeContentHash },
    });
    return this.getGovernanceDecision(id);
}
