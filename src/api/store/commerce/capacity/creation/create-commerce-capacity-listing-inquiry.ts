import { randomUUID } from 'node:crypto';
import { isoNow,MarketControlPlaneStore,objectValue,stringValue } from "../../../../persistence/store.ts";
export async function createCommerceCapacityListingInquiryMethod(this: MarketControlPlaneStore, principal, listingId, input: any = {}) {
    await this.ensureInitialized();
    const listing = await this.getCommerceCapacityListing(listingId);
    if (!listing) {
        const error: Error & Record<string, any> = new Error(`Unknown commerce capacity listing "${listingId}".`);
        error.status = 404;
        throw error;
    }
    if (listing.status !== 'approved') {
        const error: Error & Record<string, any> = new Error('Capacity listing inquiries require an approved listing.');
        error.status = 409;
        throw error;
    }
    const product = await this.getCommerceProduct(listing.productId);
    if (!product || product.status !== 'approved' || product.visibility !== 'public') {
        const error: Error & Record<string, any> = new Error('Capacity listing inquiries require an approved public product.');
        error.status = 409;
        throw error;
    }
    if (!principal?.id && !input.buyerTeamId) {
        const error: Error & Record<string, any> = new Error('Authenticated buyer identity is required for capacity inquiries.');
        error.status = 401;
        throw error;
    }
    const requestedScope = stringValue(input.requestedScope, '');
    if (!requestedScope) {
        const error: Error & Record<string, any> = new Error('requestedScope is required for capacity inquiries.');
        error.status = 400;
        throw error;
    }
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    await this.run(`INSERT INTO commerce_capacity_listing_inquiries (
				id, listing_id, product_id, vendor_id, seller_team_id, buyer_team_id, buyer_user_id, status,
				requested_service_type, requested_scope, data_access_requested_json, secret_access_requested_json,
				related_project_id, related_workday_id, governance_evidence_json, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        listing.id,
        listing.productId,
        listing.vendorId,
        listing.sellerTeamId,
        input.buyerTeamId ?? null,
        input.buyerUserId ?? principal?.id ?? null,
        'requested',
        input.requestedServiceType ?? null,
        requestedScope,
        JSON.stringify(objectValue(input.dataAccessRequested, {})),
        JSON.stringify(objectValue(input.secretAccessRequested, {})),
        input.relatedProjectId ?? null,
        input.relatedWorkdayId ?? null,
        JSON.stringify(objectValue(input.governanceEvidence ?? input.evidence, {})),
        JSON.stringify(objectValue(input.metadata, {})),
        timestamp,
        timestamp,
    ]);
    await this.recordCommerceGovernanceEvent({
        actorType: input.actorType ?? 'user',
        actorId: input.actorId ?? principal?.id ?? null,
        action: 'commerce_capacity_inquiry.created',
        objectType: 'commerce_capacity_listing_inquiry',
        objectId: id,
        nextState: 'requested',
        reason: input.reason ?? null,
        evidence: {
            listingId: listing.id,
            requestedServiceType: input.requestedServiceType ?? null,
            relatedProjectId: input.relatedProjectId ?? null,
            relatedWorkdayId: input.relatedWorkdayId ?? null,
        },
        relatedProductId: listing.productId,
        relatedTeamId: listing.sellerTeamId,
    });
    return this.getCommerceCapacityListingInquiry(id);
}
