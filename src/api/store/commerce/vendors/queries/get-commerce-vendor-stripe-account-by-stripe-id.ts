import { COMMERCE_STRIPE_ENVIRONMENT_SET,enumValue,MarketControlPlaneStore,serializeCommerceVendorStripeAccount } from "../../../../persistence/store.ts";
export async function getCommerceVendorStripeAccountByStripeIdMethod(this: MarketControlPlaneStore, stripeAccountId, environment = 'test') {
    await this.ensureInitialized();
    const env = enumValue(environment, COMMERCE_STRIPE_ENVIRONMENT_SET, 'test');
    return serializeCommerceVendorStripeAccount(await this.first(`SELECT * FROM commerce_vendor_stripe_accounts WHERE stripe_account_id = ? AND environment = ? LIMIT 1`, [stripeAccountId, env]));
}
