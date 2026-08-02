import { COMMERCE_STRIPE_ENVIRONMENT_SET,enumValue,MarketControlPlaneStore,serializeCommerceBuyerStripeCustomer } from "../../../../persistence/store.ts";
export async function getCommerceBuyerStripeCustomerMethod(this: MarketControlPlaneStore, input: any = {}) {
    await this.ensureInitialized();
    const environment = enumValue(input.environment, COMMERCE_STRIPE_ENVIRONMENT_SET, 'test');
    if (input.buyerTeamId) {
        return serializeCommerceBuyerStripeCustomer(await this.first(`SELECT * FROM commerce_buyer_stripe_customers WHERE vendor_id = ? AND environment = ? AND buyer_team_id = ? LIMIT 1`, [input.vendorId, environment, input.buyerTeamId]));
    }
    return serializeCommerceBuyerStripeCustomer(await this.first(`SELECT * FROM commerce_buyer_stripe_customers WHERE vendor_id = ? AND environment = ? AND buyer_user_id = ? LIMIT 1`, [input.vendorId, environment, input.buyerUserId ?? null]));
}
