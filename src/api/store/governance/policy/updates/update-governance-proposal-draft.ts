import { randomUUID } from 'node:crypto';
import { governanceContentHash,isoNow,MarketControlPlaneStore,optionalStringValue } from "../../../../persistence/store.ts";
export async function updateGovernanceProposalDraftMethod(this: MarketControlPlaneStore, principal, proposalId, input: any = {}) {
    await this.ensureInitialized();
    const existing = await this.getGovernanceProposal(proposalId);
    if (!existing)
        return null;
    if (['accepted', 'rejected', 'withdrawn', 'superseded', 'no_decision_quorum_failed'].includes(existing.status)) {
        const error: Error & Record<string, any> = new Error('Closed proposals cannot be edited. Create a revised proposal instead.');
        error.status = 409;
        throw error;
    }
    const title = optionalStringValue(input.title, existing.title);
    const summary = optionalStringValue(input.summary, existing.summary);
    const body = optionalStringValue(input.body, existing.body);
    const proposalType = optionalStringValue(input.proposalType, existing.proposalType);
    const nextHash = governanceContentHash({ title, summary, body, proposalType });
    const materialChange = nextHash !== existing.activeContentHash;
    const timestamp = isoNow();
    const nextVersion = existing.status === 'voting' && materialChange ? existing.activeVersion + 1 : existing.activeVersion;
    const nextStatus = existing.status === 'voting' && materialChange ? 'open' : existing.status;
    if (nextVersion !== existing.activeVersion) {
        await this.run(`INSERT INTO governance_proposal_versions (
					id, proposal_id, version, title, summary, body, content_hash, change_reason,
					created_by_type, created_by_id, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'user', ?, ?)`, [randomUUID(), proposalId, nextVersion, title, summary, body, nextHash, optionalStringValue(input.changeReason, 'Material edit reset voting.'), principal?.id ?? null, timestamp]);
    }
    await this.run(`UPDATE governance_proposals
			 SET title = ?, summary = ?, body = ?, proposal_type = ?, status = ?, active_version = ?,
				 active_content_hash = ?, voting_starts_at = CASE WHEN ? = 1 THEN NULL ELSE voting_starts_at END,
				 voting_ends_at = CASE WHEN ? = 1 THEN NULL ELSE voting_ends_at END, updated_at = ?
			 WHERE id = ?`, [title, summary, body, proposalType, nextStatus, nextVersion, nextHash, nextVersion !== existing.activeVersion ? 1 : 0, nextVersion !== existing.activeVersion ? 1 : 0, timestamp, proposalId]);
    await this.recordGovernanceEvent({
        eventType: nextVersion !== existing.activeVersion ? 'proposal.version_reset_voting' : 'proposal.updated',
        actorType: 'user',
        actorId: principal?.id ?? null,
        teamId: existing.teamId,
        projectId: existing.projectId,
        proposalId,
        proposalVersion: nextVersion,
        priorState: existing.status,
        nextState: nextStatus,
        evidence: { priorHash: existing.activeContentHash, nextHash },
    });
    return this.getGovernanceProposal(proposalId);
}
