import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
import { assertExpectedProposalVersion,simulationEvidence } from '../support/simulation-evidence.ts';
export async function adminDecideGovernanceProposalMethod(this: MarketControlPlaneStore, principal, proposalId, input: any = {}) {
    const proposal = await this.getGovernanceProposal(proposalId);
    if (!proposal) return null;
    assertExpectedProposalVersion(input, proposal.activeVersion);
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (!reason) throw new Error('An explicit rationale is required for an authorized proposal decision.');
    const decision = input.status === 'rejected' || input.status === 'request_changes' ? input.status : 'approved';
    const result = await this.evaluateGovernanceProposal(proposalId, {
        adminDecision: decision,
        actorType: 'user',
        actorId: principal?.id ?? null,
    });
    const simulation = simulationEvidence(input, principal?.id);
    await this.recordGovernanceEvent({
        eventType: Object.keys(simulation).length > 0 ? 'proposal.simulated_human_decision' : 'proposal.admin_decision', actorType: 'user', actorId: principal?.id ?? null,
        teamId: proposal.teamId, projectId: proposal.projectId, proposalId, proposalVersion: proposal.activeVersion,
        nextState: decision, message: reason, evidence: simulation,
    });
    return result;
}
