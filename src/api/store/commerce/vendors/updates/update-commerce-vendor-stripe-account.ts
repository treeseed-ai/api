import { arrayValue,COMMERCE_STRIPE_ACCOUNT_STATUS_SET,COMMERCE_STRIPE_ONBOARDING_STATUS_SET,enumValue,isoNow,MarketControlPlaneStore,objectValue,serializeCommerceVendorStripeAccount } from "../../../../persistence/store.ts";
export async function updateCommerceVendorStripeAccountMethod(this: MarketControlPlaneStore, accountId, input: any = {}) {
    await this.ensureInitialized();
    const existing = serializeCommerceVendorStripeAccount(await this.first(`SELECT * FROM commerce_vendor_stripe_accounts WHERE id = ? LIMIT 1`, [accountId]));
    if (!existing)
        return null;
    const timestamp = isoNow();
    const accountStatus = enumValue(input.accountStatus, COMMERCE_STRIPE_ACCOUNT_STATUS_SET, existing.accountStatus);
    const onboardingStatus = enumValue(input.onboardingStatus, COMMERCE_STRIPE_ONBOARDING_STATUS_SET, existing.onboardingStatus);
    const onboardingCompletedAt = input.onboardingCompletedAt === undefined
        ? (onboardingStatus === 'completed' && !existing.onboardingCompletedAt ? timestamp : existing.onboardingCompletedAt)
        : input.onboardingCompletedAt;
    await this.run(`UPDATE commerce_vendor_stripe_accounts
			 SET account_status = ?, onboarding_status = ?, charges_enabled = ?, payouts_enabled = ?, details_submitted = ?,
			     requirements_currently_due_json = ?, requirements_eventually_due_json = ?, requirements_past_due_json = ?,
			     requirements_disabled_reason = ?, capabilities_json = ?, onboarding_started_at = ?, onboarding_completed_at = ?,
			     last_synced_at = ?, metadata_json = ?, updated_at = ?
			 WHERE id = ?`, [
        accountStatus,
        onboardingStatus,
        input.chargesEnabled === undefined ? (existing.chargesEnabled ? 1 : 0) : (input.chargesEnabled === true ? 1 : 0),
        input.payoutsEnabled === undefined ? (existing.payoutsEnabled ? 1 : 0) : (input.payoutsEnabled === true ? 1 : 0),
        input.detailsSubmitted === undefined ? (existing.detailsSubmitted ? 1 : 0) : (input.detailsSubmitted === true ? 1 : 0),
        JSON.stringify(input.requirementsCurrentlyDue === undefined ? existing.requirementsCurrentlyDue : arrayValue(input.requirementsCurrentlyDue)),
        JSON.stringify(input.requirementsEventuallyDue === undefined ? existing.requirementsEventuallyDue : arrayValue(input.requirementsEventuallyDue)),
        JSON.stringify(input.requirementsPastDue === undefined ? existing.requirementsPastDue : arrayValue(input.requirementsPastDue)),
        input.requirementsDisabledReason === undefined ? existing.requirementsDisabledReason : input.requirementsDisabledReason,
        JSON.stringify(input.capabilities === undefined ? existing.capabilities : objectValue(input.capabilities, {})),
        input.onboardingStartedAt === undefined ? existing.onboardingStartedAt : input.onboardingStartedAt,
        onboardingCompletedAt,
        input.lastSyncedAt === undefined ? existing.lastSyncedAt : input.lastSyncedAt,
        JSON.stringify(input.metadata === undefined ? existing.metadata : objectValue(input.metadata, {})),
        timestamp,
        accountId,
    ]);
    if (existing.stripeAccountId) {
        await this.updateCommerceVendor(existing.vendorId, { stripeAccountId: existing.stripeAccountId });
    }
    return serializeCommerceVendorStripeAccount(await this.first(`SELECT * FROM commerce_vendor_stripe_accounts WHERE id = ? LIMIT 1`, [accountId]));
}
