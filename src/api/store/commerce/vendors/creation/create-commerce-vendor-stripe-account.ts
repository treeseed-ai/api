import { randomUUID } from 'node:crypto';
import { arrayValue,COMMERCE_STRIPE_ACCOUNT_STATUS_SET,COMMERCE_STRIPE_ENVIRONMENT_SET,COMMERCE_STRIPE_ONBOARDING_STATUS_SET,enumValue,isoNow,MarketControlPlaneStore,objectValue,stringValue } from "../../../../persistence/store.ts";
export async function createCommerceVendorStripeAccountMethod(this: MarketControlPlaneStore, vendorId, input: any = {}) {
    await this.ensureInitialized();
    const vendor = await this.getCommerceVendor(vendorId);
    if (!vendor) {
        const error: Error & Record<string, any> = new Error(`Unknown commerce vendor "${vendorId}".`);
        error.status = 404;
        throw error;
    }
    if (vendor.status !== 'approved') {
        const error: Error & Record<string, any> = new Error('Commerce vendor approval is required before Stripe onboarding.');
        error.status = 409;
        throw error;
    }
    const environment = enumValue(input.environment, COMMERCE_STRIPE_ENVIRONMENT_SET, 'test');
    const stripeAccountId = stringValue(input.stripeAccountId, '');
    if (!stripeAccountId) {
        const error: Error & Record<string, any> = new Error('stripeAccountId is required.');
        error.status = 400;
        throw error;
    }
    const existing = await this.getCommerceVendorStripeAccount(vendorId, environment);
    if (existing)
        return existing;
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    await this.run(`INSERT INTO commerce_vendor_stripe_accounts (
				id, vendor_id, team_id, environment, stripe_account_id, account_status, onboarding_status,
				charges_enabled, payouts_enabled, details_submitted,
				requirements_currently_due_json, requirements_eventually_due_json, requirements_past_due_json, requirements_disabled_reason,
				capabilities_json, onboarding_started_at, onboarding_completed_at, last_synced_at, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        vendorId,
        vendor.teamId,
        environment,
        stripeAccountId,
        enumValue(input.accountStatus, COMMERCE_STRIPE_ACCOUNT_STATUS_SET, 'pending'),
        enumValue(input.onboardingStatus, COMMERCE_STRIPE_ONBOARDING_STATUS_SET, 'not_started'),
        input.chargesEnabled === true ? 1 : 0,
        input.payoutsEnabled === true ? 1 : 0,
        input.detailsSubmitted === true ? 1 : 0,
        JSON.stringify(arrayValue(input.requirementsCurrentlyDue)),
        JSON.stringify(arrayValue(input.requirementsEventuallyDue)),
        JSON.stringify(arrayValue(input.requirementsPastDue)),
        input.requirementsDisabledReason ?? null,
        JSON.stringify(objectValue(input.capabilities, {})),
        input.onboardingStartedAt ?? null,
        input.onboardingCompletedAt ?? null,
        input.lastSyncedAt ?? null,
        JSON.stringify(objectValue(input.metadata, {})),
        timestamp,
        timestamp,
    ]);
    await this.updateCommerceVendor(vendorId, { stripeAccountId });
    await this.recordCommerceGovernanceEvent({
        actorType: input.actorType ?? 'system',
        actorId: input.actorId ?? null,
        action: 'commerce_vendor.stripe_account.created',
        objectType: 'commerce_vendor',
        objectId: vendorId,
        priorState: vendor.stripeAccountId ? 'linked' : null,
        nextState: 'linked',
        reason: input.reason ?? null,
        evidence: input.evidence ?? { environment },
        relatedTeamId: vendor.teamId,
    });
    return this.getCommerceVendorStripeAccount(vendorId, environment);
}
