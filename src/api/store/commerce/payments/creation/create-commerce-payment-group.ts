import { randomUUID } from 'node:crypto';
import { COMMERCE_PAYMENT_GROUP_STATUS_SET,enumValue,isoNow,MarketControlPlaneStore,serializeCommercePaymentGroup,stringValue } from "../../../../persistence/store.ts";
export async function createCommercePaymentGroupMethod(this: MarketControlPlaneStore, input: any = {}) {
    await this.ensureInitialized();
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    const clientSecret = input.clientSecret ?? null;
    await this.run(`INSERT INTO commerce_payment_groups (
				id, checkout_id, order_id, vendor_id, seller_team_id, connected_account_id, group_kind, billing_interval, status,
				currency, subtotal_amount, total_amount, stripe_payment_intent_id, stripe_subscription_id, stripe_customer_id,
				client_secret_last4, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        input.checkoutId,
        input.orderId,
        input.vendorId,
        input.sellerTeamId,
        input.connectedAccountId ?? null,
        input.groupKind,
        input.billingInterval ?? null,
        enumValue(input.status, COMMERCE_PAYMENT_GROUP_STATUS_SET, 'pending'),
        stringValue(input.currency, 'usd'),
        Number(input.subtotalAmount ?? 0),
        Number(input.totalAmount ?? 0),
        input.stripePaymentIntentId ?? null,
        input.stripeSubscriptionId ?? null,
        input.stripeCustomerId ?? null,
        clientSecret ? clientSecret.slice(-4) : null,
        JSON.stringify(input.metadata ?? {}),
        timestamp,
        timestamp,
    ]);
    await this.recordCommerceGovernanceEvent({
        actorType: input.actorType ?? 'system',
        actorId: input.actorId ?? null,
        action: 'commerce_payment_group.created',
        objectType: 'commerce_payment_group',
        objectId: id,
        nextState: input.status ?? 'pending',
        evidence: {
            connectedAccountId: input.connectedAccountId ?? null,
            stripePaymentIntentId: input.stripePaymentIntentId ?? null,
            stripeSubscriptionId: input.stripeSubscriptionId ?? null,
        },
        relatedOrderId: input.orderId,
        relatedTeamId: input.sellerTeamId,
    });
    return serializeCommercePaymentGroup(await this.first(`SELECT * FROM commerce_payment_groups WHERE id = ?`, [id]), clientSecret);
}
