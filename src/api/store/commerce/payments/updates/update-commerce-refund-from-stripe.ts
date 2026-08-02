import { COMMERCE_REFUND_STATUS_SET,enumValue,isoNow,MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function updateCommerceRefundFromStripeMethod(this: MarketControlPlaneStore, refundId, input: any = {}) {
    await this.ensureInitialized();
    const existing = await this.getCommerceRefund(refundId);
    if (!existing)
        return null;
    const status = enumValue(input.status, COMMERCE_REFUND_STATUS_SET, existing.status);
    await this.run(`UPDATE commerce_refunds
			 SET status = ?, stripe_refund_id = ?, failure_reason = ?, metadata_json = ?, updated_at = ?
			 WHERE id = ?`, [
        status,
        input.stripeRefundId === undefined ? existing.stripeRefundId : input.stripeRefundId,
        input.failureReason === undefined ? existing.failureReason : input.failureReason,
        JSON.stringify(input.metadata ?? existing.metadata ?? {}),
        isoNow(),
        refundId,
    ]);
    await this.recordCommerceGovernanceEvent({
        actorType: input.actorType ?? 'system',
        actorId: input.actorId ?? null,
        action: status === 'failed' ? 'commerce_refund.failed' : 'commerce_refund.succeeded',
        objectType: 'commerce_refund',
        objectId: refundId,
        priorState: existing.status,
        nextState: status,
        evidence: {
            stripeRefundId: input.stripeRefundId ?? existing.stripeRefundId,
            failureReason: input.failureReason ?? null,
        },
        relatedOrderId: existing.orderId,
        relatedTeamId: existing.sellerTeamId,
    });
    return this.getCommerceRefund(refundId);
}
