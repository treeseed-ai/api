import { randomUUID } from 'node:crypto';
import { isoNow,MarketControlPlaneStore,objectValue,stringValue } from "../../../../persistence/store.ts";
export async function createCommerceServiceRequestMethod(this: MarketControlPlaneStore, principal, input: any = {}) {
    await this.ensureInitialized();
    const offer = await this.getCommerceOffer(input.offerId);
    if (!offer || offer.status !== 'approved') {
        const error: Error & Record<string, any> = new Error('Service request requires an approved contact or scoped contract offer.');
        error.status = offer ? 409 : 404;
        throw error;
    }
    if (!['contact', 'scoped_contract'].includes(offer.mode)) {
        const error: Error & Record<string, any> = new Error('Service request requires a contact or scoped contract offer.');
        error.status = 409;
        throw error;
    }
    const product = await this.getCommerceProduct(offer.productId);
    if (!product || product.status !== 'approved' || product.kind !== 'scoped_service') {
        const error: Error & Record<string, any> = new Error('Service request requires an approved scoped service product.');
        error.status = product ? 409 : 404;
        throw error;
    }
    const vendor = await this.getCommerceVendor(offer.vendorId);
    if (!vendor || vendor.status !== 'approved' || vendor.serviceSalesEnabled !== true) {
        const error: Error & Record<string, any> = new Error('Service request requires an approved service-enabled vendor.');
        error.status = 409;
        throw error;
    }
    const requestedScope = stringValue(input.requestedScope, '');
    if (!requestedScope) {
        const error: Error & Record<string, any> = new Error('requestedScope is required.');
        error.status = 400;
        throw error;
    }
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    const ownershipSnapshot = await this.buildCommerceOwnershipSnapshot(product.id);
    await this.run(`INSERT INTO commerce_service_requests (
				id, buyer_team_id, buyer_user_id, vendor_id, seller_team_id, product_id, offer_id, status,
				requested_scope, approved_scope, access_needs_json, buyer_visible_summary, vendor_private_notes,
				active_quote_id, approved_quote_id, contract_id, related_project_id, related_workday_id,
				order_id, entitlement_id, ownership_snapshot_json, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        input.buyerTeamId ?? null,
        principal?.id ?? input.buyerUserId ?? null,
        vendor.id,
        product.sellerTeamId,
        product.id,
        offer.id,
        'requested',
        requestedScope,
        null,
        JSON.stringify(objectValue(input.accessNeeds, {})),
        input.buyerVisibleSummary ?? null,
        null,
        null,
        null,
        null,
        input.relatedProjectId ?? null,
        input.relatedWorkdayId ?? null,
        null,
        null,
        JSON.stringify(ownershipSnapshot),
        JSON.stringify(objectValue(input.metadata, {})),
        timestamp,
        timestamp,
    ]);
    await this.recordCommerceServiceGovernance({
        requestId: id,
        eventType: 'requested',
        action: 'commerce_service.requested',
        objectId: id,
        actorType: input.actorType ?? 'user',
        actorId: input.actorId ?? principal?.id ?? null,
        nextState: 'requested',
        evidence: { offerId: offer.id, productId: product.id, vendorId: vendor.id },
        relatedOfferId: offer.id,
        relatedProductId: product.id,
        relatedTeamId: product.sellerTeamId,
    });
    return this.getCommerceServiceRequest(id);
}
