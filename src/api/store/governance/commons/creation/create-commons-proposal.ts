import { randomUUID } from 'node:crypto';
import { isoNow,MarketControlPlaneStore,optionalStringValue,stringValue } from "../../../../persistence/store.ts";
export async function createCommonsProposalMethod(this: MarketControlPlaneStore, principal, input: any = {}) {
    const participant = await this.ensureCommonsParticipantForPrincipal(principal);
    const title = stringValue(input.title);
    const summary = stringValue(input.summary);
    const body = stringValue(input.body);
    if (!title || !summary || !body) {
        const error: Error & Record<string, any> = new Error('Proposal title, summary, and body are required.');
        error.status = 400;
        throw error;
    }
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    await this.run(`INSERT INTO commons_proposals (
				id, participant_id, user_id, team_id, status, title, summary, body, scope, decision_type,
				content_proposal_slug, content_decision_slug, backing_count, vote_support_weight, vote_object_weight,
				vote_abstain_weight, qualified_at, voting_starts_at, voting_ends_at, steward_decision_at,
				steward_decision_by, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`, [
        id,
        participant.id,
        participant.userId,
        participant.teamId,
        input.status === 'submitted' ? 'submitted' : 'draft',
        title,
        summary,
        body,
        optionalStringValue(input.scope, 'treeseed_commons'),
        optionalStringValue(input.decisionType, 'advisory'),
        JSON.stringify(input.metadata ?? {}),
        timestamp,
        timestamp,
    ]);
    await this.recordCommonsGovernanceEvent({
        eventType: 'proposal.created',
        actorType: 'user',
        actorId: principal.id,
        participantId: participant.id,
        proposalId: id,
        nextState: input.status === 'submitted' ? 'submitted' : 'draft',
        message: 'Commons proposal created.',
    });
    return this.getCommonsProposal(id);
}
