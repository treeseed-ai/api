import { MarketControlPlaneStore,optionalStringValue } from "../../../../persistence/store.ts";
import { assertExpectedProposalVersion,simulationEvidence } from '../support/simulation-evidence.ts';
export async function openGovernanceProposalMethod(this: MarketControlPlaneStore, principal, proposalId, input: any = {}) {
	const proposal = await this.getGovernanceProposal(proposalId);
	if (!proposal) return null;
	assertExpectedProposalVersion(input, proposal.activeVersion);
    return this.transitionGovernanceProposal(proposalId, 'open', {
        actorType: 'user',
        actorId: principal?.id ?? null,
        reason: optionalStringValue(input.reason),
		evidence: simulationEvidence(input, principal?.id),
    });
}
