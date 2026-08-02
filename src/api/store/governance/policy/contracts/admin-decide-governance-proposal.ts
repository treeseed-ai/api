import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
import { assertExpectedProposalVersion,simulationEvidence } from '../support/simulation-evidence.ts';
export async function adminDecideGovernanceProposalMethod(this: MarketControlPlaneStore, principal, proposalId, input: any = {}) {
    const proposal = await this.getGovernanceProposal(proposalId);
    if (!proposal) return null;
    assertExpectedProposalVersion(input, proposal.activeVersion);
    const decision = input.status === 'rejected' || input.status === 'request_changes' ? input.status : 'approved';
    const result = await this.evaluateGovernanceProposal(proposalId, {
        adminDecision: decision,
        actorType: 'user',
        actorId: principal?.id ?? null,
    });
    const simulation = simulationEvidence(input, principal?.id);
    if (Object.keys(simulation).length > 0) await this.recordGovernanceEvent({
        eventType: 'proposal.simulated_human_decision', actorType: 'user', actorId: principal?.id ?? null,
        teamId: proposal.teamId, projectId: proposal.projectId, proposalId, proposalVersion: proposal.activeVersion,
        nextState: decision, message: input.reason ?? null, evidence: simulation,
    });
    return result;
}
