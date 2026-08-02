import { isoNow,MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function endCommerceStewardshipAssignmentMethod(this: MarketControlPlaneStore, assignmentId, input: any = {}) {
    return this.updateCommerceStewardshipAssignment(assignmentId, {
        ...input,
        endsAt: input.endsAt ?? isoNow(),
        evidence: input.evidence ?? { ended: true },
    }).then(async (updated) => {
        if (updated) {
            await this.recordCommerceGovernanceEvent({
                actorType: input.actorType ?? 'system',
                actorId: input.actorId ?? null,
                action: 'commerce_stewardship.assignment.ended',
                objectType: 'commerce_stewardship_assignment',
                objectId: assignmentId,
                priorState: 'active',
                nextState: 'ended',
                reason: input.reason ?? null,
                evidence: input.evidence ?? {},
                relatedProductId: updated.productId,
            });
        }
        return updated;
    });
}
