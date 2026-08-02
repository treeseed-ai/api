import { isoNow,MarketControlPlaneStore,serializeCommerceVendorStripeAccount } from "../../../../persistence/store.ts";
export async function markCommerceStripeOnboardingStartedMethod(this: MarketControlPlaneStore, accountId, input: any = {}) {
    const existing = serializeCommerceVendorStripeAccount(await this.first(`SELECT * FROM commerce_vendor_stripe_accounts WHERE id = ? LIMIT 1`, [accountId]));
    if (!existing)
        return null;
    const timestamp = isoNow();
    const account = await this.updateCommerceVendorStripeAccount(accountId, {
        onboardingStatus: 'started',
        onboardingStartedAt: existing.onboardingStartedAt ?? timestamp,
    });
    await this.recordCommerceGovernanceEvent({
        actorType: input.actorType ?? 'user',
        actorId: input.actorId ?? null,
        action: 'commerce_vendor.stripe_onboarding.started',
        objectType: 'commerce_vendor',
        objectId: existing.vendorId,
        priorState: existing.onboardingStatus,
        nextState: 'started',
        reason: input.reason ?? null,
        evidence: input.evidence ?? { environment: existing.environment },
        relatedTeamId: existing.teamId,
    });
    return account;
}
