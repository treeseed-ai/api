import { COMMERCE_STRIPE_ENVIRONMENT_SET,enumValue,MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function upsertCommerceVendorStripeAccountMethod(this: MarketControlPlaneStore, vendorId, input: any = {}) {
    const environment = enumValue(input.environment, COMMERCE_STRIPE_ENVIRONMENT_SET, 'test');
    const existing = await this.getCommerceVendorStripeAccount(vendorId, environment);
    if (existing)
        return this.updateCommerceVendorStripeAccount(existing.id, input);
    return this.createCommerceVendorStripeAccount(vendorId, input);
}
