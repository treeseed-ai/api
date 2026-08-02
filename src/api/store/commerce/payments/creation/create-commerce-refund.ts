import { randomUUID } from 'node:crypto';
import { COMMERCE_REFUND_STATUS_SET,enumValue,isoNow,MarketControlPlaneStore,stringValue } from "../../../../persistence/store.ts";
export async function createCommerceRefundMethod(this: MarketControlPlaneStore, input: any = {}) {
    await this.ensureInitialized();
    if (input.idempotencyKey) {
        const existing = await this.getCommerceRefundByIdempotencyKey(input.idempotencyKey);
        if (existing)
            return existing;
    }
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    await this.run(`INSERT INTO commerce_refunds (
				id, order_id, order_item_id, payment_group_id, vendor_id, seller_team_id, buyer_team_id, buyer_user_id,
				amount, currency, status, reason, stripe_refund_id, stripe_payment_intent_id, stripe_connected_account_id,
				idempotency_key, requested_by_type, requested_by_id, failure_reason, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        input.orderId,
        input.orderItemId ?? null,
        input.paymentGroupId ?? null,
        input.vendorId,
        input.sellerTeamId,
        input.buyerTeamId ?? null,
        input.buyerUserId ?? null,
        Number(input.amount ?? 0),
        stringValue(input.currency, 'usd'),
        enumValue(input.status, COMMERCE_REFUND_STATUS_SET, 'processing'),
        input.reason ?? null,
        input.stripeRefundId ?? null,
        input.stripePaymentIntentId ?? null,
        input.stripeConnectedAccountId ?? null,
        input.idempotencyKey ?? randomUUID(),
        input.requestedByType ?? 'user',
        input.requestedById ?? 'system',
        input.failureReason ?? null,
        JSON.stringify(input.metadata ?? {}),
        timestamp,
        timestamp,
    ]);
    await this.recordCommerceGovernanceEvent({
        actorType: input.actorType ?? 'user',
        actorId: input.actorId ?? null,
        action: 'commerce_refund.created',
        objectType: 'commerce_refund',
        objectId: id,
        nextState: input.status ?? 'processing',
        evidence: {
            amount: Number(input.amount ?? 0),
            currency: stringValue(input.currency, 'usd'),
            stripePaymentIntentId: input.stripePaymentIntentId ?? null,
            stripeConnectedAccountId: input.stripeConnectedAccountId ?? null,
        },
        relatedOrderId: input.orderId,
        relatedTeamId: input.sellerTeamId,
    });
    return this.getCommerceRefund(id);
}
