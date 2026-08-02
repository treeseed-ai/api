import { COMMERCE_SERVICE_REQUEST_STATUS_SET,enumValue,isoNow,MarketControlPlaneStore,objectValue } from "../../../../persistence/store.ts";
export async function updateCommerceServiceRequestMethod(this: MarketControlPlaneStore, requestId, input: any = {}) {
    await this.ensureInitialized();
    const existing = await this.getCommerceServiceRequest(requestId);
    if (!existing)
        return null;
    const timestamp = isoNow();
    await this.run(`UPDATE commerce_service_requests
			 SET status = ?, approved_scope = ?, access_needs_json = ?, buyer_visible_summary = ?, vendor_private_notes = ?,
			     active_quote_id = ?, approved_quote_id = ?, contract_id = ?, related_project_id = ?, related_workday_id = ?,
			     order_id = ?, entitlement_id = ?, metadata_json = ?, updated_at = ?
			 WHERE id = ?`, [
        enumValue(input.status, COMMERCE_SERVICE_REQUEST_STATUS_SET, existing.status),
        input.approvedScope === undefined ? existing.approvedScope : input.approvedScope,
        JSON.stringify(input.accessNeeds === undefined ? existing.accessNeeds : objectValue(input.accessNeeds, {})),
        input.buyerVisibleSummary === undefined ? existing.buyerVisibleSummary : input.buyerVisibleSummary,
        input.vendorPrivateNotes === undefined ? existing.vendorPrivateNotes : input.vendorPrivateNotes,
        input.activeQuoteId === undefined ? existing.activeQuoteId : input.activeQuoteId,
        input.approvedQuoteId === undefined ? existing.approvedQuoteId : input.approvedQuoteId,
        input.contractId === undefined ? existing.contractId : input.contractId,
        input.relatedProjectId === undefined ? existing.relatedProjectId : input.relatedProjectId,
        input.relatedWorkdayId === undefined ? existing.relatedWorkdayId : input.relatedWorkdayId,
        input.orderId === undefined ? existing.orderId : input.orderId,
        input.entitlementId === undefined ? existing.entitlementId : input.entitlementId,
        JSON.stringify(input.metadata ?? existing.metadata ?? {}),
        timestamp,
        requestId,
    ]);
    if (input.recordEvent !== false) {
        await this.recordCommerceServiceGovernance({
            requestId,
            eventType: input.eventType ?? 'scope_updated',
            action: input.action ?? 'commerce_service.scope_updated',
            objectId: requestId,
            actorType: input.actorType ?? 'user',
            actorId: input.actorId ?? null,
            priorState: existing.status,
            nextState: input.status ?? existing.status,
            message: input.reason ?? null,
            evidence: input.evidence ?? {},
            relatedOfferId: existing.offerId,
            relatedProductId: existing.productId,
            relatedTeamId: existing.sellerTeamId,
        });
    }
    return this.getCommerceServiceRequest(requestId);
}
