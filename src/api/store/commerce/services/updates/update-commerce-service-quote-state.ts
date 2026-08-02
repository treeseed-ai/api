import { COMMERCE_SERVICE_QUOTE_STATUS_SET,enumValue,isoNow,MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function updateCommerceServiceQuoteStateMethod(this: MarketControlPlaneStore, quoteId, status, input: any = {}) {
    await this.ensureInitialized();
    const existing = await this.getCommerceServiceQuote(quoteId);
    if (!existing)
        return null;
    const timestamp = isoNow();
    await this.run(`UPDATE commerce_service_quotes
			 SET status = ?, buyer_approved_at = ?, vendor_approved_at = ?, accepted_at = ?, rejected_at = ?,
			     metadata_json = ?, updated_at = ?
			 WHERE id = ?`, [
        enumValue(status, COMMERCE_SERVICE_QUOTE_STATUS_SET, existing.status),
        input.buyerApprovedAt === undefined ? existing.buyerApprovedAt : input.buyerApprovedAt,
        input.vendorApprovedAt === undefined ? existing.vendorApprovedAt : input.vendorApprovedAt,
        input.acceptedAt === undefined ? existing.acceptedAt : input.acceptedAt,
        input.rejectedAt === undefined ? existing.rejectedAt : input.rejectedAt,
        JSON.stringify(input.metadata ?? existing.metadata ?? {}),
        timestamp,
        quoteId,
    ]);
    if (input.recordEvent !== false) {
        await this.recordCommerceServiceGovernance({
            requestId: existing.requestId,
            quoteId,
            eventType: input.eventType ?? 'manual_update',
            action: input.action ?? `commerce_service.quote_${status}`,
            objectType: 'commerce_service_quote',
            objectId: quoteId,
            actorType: input.actorType ?? 'user',
            actorId: input.actorId ?? null,
            priorState: existing.status,
            nextState: status,
            message: input.reason ?? null,
            evidence: input.evidence ?? {},
            relatedTeamId: existing.sellerTeamId,
        });
    }
    return this.getCommerceServiceQuote(quoteId);
}
