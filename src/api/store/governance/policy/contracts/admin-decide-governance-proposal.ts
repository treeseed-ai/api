import { ControlPlaneStore } from "../../../../persistence/store.ts";
import { assertExpectedProposalVersion,simulationEvidence } from '../support/simulation-evidence.ts';
import { hasCompleteExecutablePlan, proposalApprovalFingerprint, readExactProposal } from '../../../../governance/executable-proposal.ts';
export async function adminDecideGovernanceProposalMethod(this: ControlPlaneStore, principal: ApiPrincipal | null | undefined, proposalId: string, input: any = {}) {
    const proposal = await this.getGovernanceProposal(proposalId);
    if (!proposal) return null;
    assertExpectedProposalVersion(input, proposal.activeVersion);
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (!reason) throw new Error('An explicit rationale is required for an authorized proposal decision.');
    const decision = input.status === 'rejected' || input.status === 'request_changes' ? input.status : 'approved';
	const exact = decision === 'approved' ? await readExactProposal(this, proposal) : null;
	if (exact?.definition.status === 'withdrawn') throw Object.assign(
		new Error('A withdrawn proposal cannot be approved.'), { status: 409, code: 'governance_proposal_withdrawn' });
	if (exact && !hasCompleteExecutablePlan(exact.definition)) {
		const simulation = simulationEvidence(input, principal?.id);
		await this.recordGovernanceEvent({ eventType: Object.keys(simulation).length > 0
			? 'proposal.simulated_human_decision' : 'proposal.admin_decision', actorType: 'user', actorId: principal?.id ?? null,
			teamId: proposal.teamId, projectId: proposal.projectId, proposalId, proposalVersion: proposal.activeVersion,
			nextState: 'approved', message: reason,
			evidence: { ...simulation, approvalFingerprint: proposalApprovalFingerprint(exact.definition), pendingEstimates: true },
		});
		return { ...proposal, pendingEstimates: true };
	}
    const result = await this.evaluateGovernanceProposal(proposalId, {
        adminDecision: decision,
        actorType: 'user',
        actorId: principal?.id ?? null,
        reason,
    });
    const simulation = simulationEvidence(input, principal?.id);
    await this.recordGovernanceEvent({
        eventType: Object.keys(simulation).length > 0 ? 'proposal.simulated_human_decision' : 'proposal.admin_decision', actorType: 'user', actorId: principal?.id ?? null,
        teamId: proposal.teamId, projectId: proposal.projectId, proposalId, proposalVersion: proposal.activeVersion,
        nextState: decision, message: reason, evidence: simulation,
    });
    return result;
}
import type { ApiPrincipal } from '../../../../types.ts';
