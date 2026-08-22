import { ControlPlaneStore,objectValue,optionalStringValue } from "../../../../persistence/store.ts";
export async function withdrawGovernanceProposalMethod(this: ControlPlaneStore, principal, proposalId, input: any = {}) {
    return this.transitionGovernanceProposal(proposalId, 'withdrawn', {
        actorType: 'user',
        actorId: principal?.id ?? null,
        reason: optionalStringValue(input.reason, 'Proposal withdrawn.'),
        evidence: objectValue(input.evidence, {}),
    });
}
