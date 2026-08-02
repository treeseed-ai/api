import { randomUUID } from 'node:crypto';
import { isoNow,MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function createCommerceServiceContractFromQuoteMethod(this: MarketControlPlaneStore, quoteId, input: any = {}) {
    await this.ensureInitialized();
    const quote = await this.getCommerceServiceQuote(quoteId);
    if (!quote)
        return null;
    const existing = await this.getCommerceServiceContractForRequest(quote.requestId);
    if (existing)
        return existing;
    const request = await this.getCommerceServiceRequest(quote.requestId);
    if (!request)
        return null;
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    const accessApprovalSnapshot = {
        quoteId,
        accessRequirements: quote.accessRequirements,
        governanceRequirements: quote.governanceRequirements,
        approvedAt: timestamp,
    };
    await this.run(`INSERT INTO commerce_service_contracts (
				id, request_id, quote_id, vendor_id, seller_team_id, buyer_team_id, buyer_user_id, product_id, offer_id,
				status, amount, currency, order_id, order_item_id, payment_group_id, entitlement_id,
				related_project_id, related_workday_id, ownership_snapshot_json, access_approval_snapshot_json,
				fulfillment_summary, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        request.id,
        quote.id,
        request.vendorId,
        request.sellerTeamId,
        request.buyerTeamId,
        request.buyerUserId,
        request.productId,
        request.offerId,
        'pending_checkout',
        quote.amount,
        quote.currency,
        null,
        null,
        null,
        null,
        request.relatedProjectId,
        request.relatedWorkdayId,
        JSON.stringify(request.ownershipSnapshot ?? {}),
        JSON.stringify(accessApprovalSnapshot),
        null,
        JSON.stringify(input.metadata ?? {}),
        timestamp,
        timestamp,
    ]);
    await this.updateCommerceServiceRequest(request.id, {
        contractId: id,
        recordEvent: false,
    });
    await this.recordCommerceServiceGovernance({
        requestId: request.id,
        quoteId: quote.id,
        contractId: id,
        eventType: 'quote_vendor_approved',
        action: 'commerce_service.contract_created',
        objectType: 'commerce_service_contract',
        objectId: id,
        actorType: input.actorType ?? 'user',
        actorId: input.actorId ?? null,
        nextState: 'pending_checkout',
        evidence: { quoteId, amount: quote.amount, currency: quote.currency },
        relatedOfferId: request.offerId,
        relatedProductId: request.productId,
        relatedTeamId: request.sellerTeamId,
    });
    return this.getCommerceServiceContract(id);
}
