import { randomUUID } from 'node:crypto';
import { COMMERCE_ORDER_STATUS_SET,enumValue,isoNow,MarketControlPlaneStore,stringValue } from "../../../../persistence/store.ts";
export async function createCommerceOrderMethod(this: MarketControlPlaneStore, input: any = {}) {
    await this.ensureInitialized();
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    await this.run(`INSERT INTO commerce_orders (
				id, checkout_id, cart_id, buyer_team_id, buyer_user_id, vendor_id, seller_team_id, status, currency,
				subtotal_amount, total_amount, refunded_amount, refund_status, stripe_checkout_session_id, stripe_payment_intent_id, stripe_subscription_id,
				stripe_customer_id, stripe_connected_account_id, ownership_snapshot_json, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        input.checkoutId ?? null,
        input.cartId ?? null,
        input.buyerTeamId ?? null,
        input.buyerUserId ?? null,
        input.vendorId ?? null,
        input.sellerTeamId ?? null,
        enumValue(input.status, COMMERCE_ORDER_STATUS_SET, 'draft'),
        stringValue(input.currency, 'usd'),
        Number(input.subtotalAmount ?? 0),
        Number(input.totalAmount ?? 0),
        Number(input.refundedAmount ?? 0),
        input.refundStatus ?? 'none',
        null,
        input.stripePaymentIntentId ?? null,
        input.stripeSubscriptionId ?? null,
        input.stripeCustomerId ?? null,
        input.stripeConnectedAccountId ?? null,
        JSON.stringify(input.ownershipSnapshot ?? {}),
        JSON.stringify(input.metadata ?? {}),
        timestamp,
        timestamp,
    ]);
    await this.recordCommerceGovernanceEvent({
        actorType: input.actorType ?? 'system',
        actorId: input.actorId ?? null,
        action: 'commerce_order.created',
        objectType: 'commerce_order',
        objectId: id,
        nextState: input.status ?? 'draft',
        relatedOrderId: id,
        relatedTeamId: input.buyerTeamId ?? input.sellerTeamId ?? null,
    });
    return this.getCommerceOrder(id);
}
