import { ControlPlaneStore,optionalStringValue } from "../../../../persistence/store.ts";
import { assertExpectedProposalVersion,simulationEvidence } from '../support/simulation-evidence.ts';
import { assertGovernanceProposalReady } from '../contracts/governance-proposal-readiness.ts';
export async function openGovernanceProposalMethod(this: ControlPlaneStore, principal, proposalId, input: any = {}) {
	const proposal = await this.getGovernanceProposal(proposalId);
	if (!proposal) return null;
	assertExpectedProposalVersion(input, proposal.activeVersion);
	await assertGovernanceProposalReady.call(this, proposalId, 'content');
    return this.transitionGovernanceProposal(proposalId, 'open', {
        actorType: 'user',
        actorId: principal?.id ?? null,
        reason: optionalStringValue(input.reason),
		evidence: simulationEvidence(input, principal?.id),
    });
}
