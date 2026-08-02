import { randomUUID } from 'node:crypto';
import { COMMERCE_STRIPE_ENVIRONMENT_SET,enumValue,isoNow,MarketControlPlaneStore,serializeCommerceBuyerStripeCustomer } from "../../../../persistence/store.ts";
export async function upsertCommerceBuyerStripeCustomerMethod(this: MarketControlPlaneStore, input: any = {}) {
    await this.ensureInitialized();
    const existing = await this.getCommerceBuyerStripeCustomer(input);
    if (existing)
        return existing;
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    const environment = enumValue(input.environment, COMMERCE_STRIPE_ENVIRONMENT_SET, 'test');
    await this.run(`INSERT INTO commerce_buyer_stripe_customers (
				id, buyer_team_id, buyer_user_id, vendor_id, connected_account_id, environment, stripe_customer_id,
				metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        input.buyerTeamId ?? null,
        input.buyerUserId ?? null,
        input.vendorId,
        input.connectedAccountId,
        environment,
        input.stripeCustomerId,
        JSON.stringify(input.metadata ?? {}),
        timestamp,
        timestamp,
    ]);
    return serializeCommerceBuyerStripeCustomer(await this.first(`SELECT * FROM commerce_buyer_stripe_customers WHERE id = ?`, [id]));
}
