import { MarketControlPlaneStore,serializeCommerceVendorStripeAccount } from "../../../../persistence/store.ts";
export async function markCommerceStripeOnboardingReturnedMethod(this: MarketControlPlaneStore, accountId, input: any = {}) {
    const existing = serializeCommerceVendorStripeAccount(await this.first(`SELECT * FROM commerce_vendor_stripe_accounts WHERE id = ? LIMIT 1`, [accountId]));
    if (!existing)
        return null;
    const account = await this.updateCommerceVendorStripeAccount(accountId, {
        onboardingStatus: 'returned',
    });
    await this.recordCommerceGovernanceEvent({
        actorType: input.actorType ?? 'user',
        actorId: input.actorId ?? null,
        action: 'commerce_vendor.stripe_onboarding.returned',
        objectType: 'commerce_vendor',
        objectId: existing.vendorId,
        priorState: existing.onboardingStatus,
        nextState: 'returned',
        reason: input.reason ?? null,
        evidence: input.evidence ?? { environment: existing.environment },
        relatedTeamId: existing.teamId,
    });
    return account;
}
