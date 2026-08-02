import { MarketControlPlaneStore,serializeCommerceVendorStripeAccount } from "../../../../persistence/store.ts";
export async function recordCommerceStripeAccountStatusMethod(this: MarketControlPlaneStore, accountId, input: any = {}) {
    const existing = serializeCommerceVendorStripeAccount(await this.first(`SELECT * FROM commerce_vendor_stripe_accounts WHERE id = ? LIMIT 1`, [accountId]));
    if (!existing)
        return null;
    const account = await this.updateCommerceVendorStripeAccount(accountId, input);
    await this.recordCommerceGovernanceEvent({
        actorType: input.actorType ?? 'system',
        actorId: input.actorId ?? null,
        action: 'commerce_vendor.stripe_status.synced',
        objectType: 'commerce_vendor',
        objectId: existing.vendorId,
        priorState: existing.accountStatus,
        nextState: account?.accountStatus ?? existing.accountStatus,
        reason: input.reason ?? null,
        evidence: input.evidence ?? {
            environment: existing.environment,
            chargesEnabled: account?.chargesEnabled ?? false,
            payoutsEnabled: account?.payoutsEnabled ?? false,
            detailsSubmitted: account?.detailsSubmitted ?? false,
        },
        relatedTeamId: existing.teamId,
    });
    return account;
}
