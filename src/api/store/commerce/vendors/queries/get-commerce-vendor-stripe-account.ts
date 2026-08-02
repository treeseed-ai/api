import { COMMERCE_STRIPE_ENVIRONMENT_SET,enumValue,MarketControlPlaneStore,serializeCommerceVendorStripeAccount } from "../../../../persistence/store.ts";
export async function getCommerceVendorStripeAccountMethod(this: MarketControlPlaneStore, vendorId, environment = 'test') {
    await this.ensureInitialized();
    const env = enumValue(environment, COMMERCE_STRIPE_ENVIRONMENT_SET, 'test');
    return serializeCommerceVendorStripeAccount(await this.first(`SELECT * FROM commerce_vendor_stripe_accounts WHERE vendor_id = ? AND environment = ? LIMIT 1`, [vendorId, env]));
}
