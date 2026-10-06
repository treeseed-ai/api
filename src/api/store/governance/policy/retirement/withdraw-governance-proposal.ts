import { ControlPlaneStore,objectValue,optionalStringValue } from "../../../../persistence/store.ts";
import { assertExpectedProposalVersion } from '../support/simulation-evidence.ts';
export async function withdrawGovernanceProposalMethod(this: ControlPlaneStore, principal: ApiPrincipal | null | undefined, proposalId: string, input: any = {}) {
    const proposal = await this.getGovernanceProposal(proposalId);
    if (!proposal) return null;
    assertExpectedProposalVersion(input, proposal.activeVersion);
    return this.transitionGovernanceProposal(proposalId, 'withdrawn', {
        actorType: 'user',
        actorId: principal?.id ?? null,
        reason: optionalStringValue(input.reason, 'Proposal withdrawn.'),
        evidence: objectValue(input.evidence, {}),
    });
}
import type { ApiPrincipal } from '../../../../types.ts';
