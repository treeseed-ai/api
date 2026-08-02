import { randomUUID } from 'node:crypto';
import { arrayValue,COMMERCE_CAPACITY_ACCESS_LEVEL_SET,COMMERCE_CAPACITY_AI_INVOLVEMENT_LEVEL_SET,COMMERCE_CAPACITY_DATA_ACCESS_LEVEL_SET,COMMERCE_CAPACITY_HUMAN_INVOLVEMENT_LEVEL_SET,COMMERCE_CAPACITY_RUNTIME_ISOLATION_LEVEL_SET,COMMERCE_CAPACITY_SECRET_ACCESS_LEVEL_SET,enumValue,isoNow,MarketControlPlaneStore,objectValue } from "../../../../persistence/store.ts";
export async function createCommerceCapacityListingMethod(this: MarketControlPlaneStore, productId, input: any = {}, capacity) {
    await this.ensureInitialized();
    const product = await this.getCommerceProduct(productId);
    const vendor = await this.ensureCommerceCapacityListingEligibility(product, input, capacity);
    const existing = await this.getCommerceCapacityListingForProduct(productId);
    if (existing)
        return existing;
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    const ownershipSnapshot = input.ownershipSnapshot ?? await this.commerceCapacityOwnershipSnapshot(product);
    await this.run(`INSERT INTO commerce_capacity_listings (
				id, product_id, vendor_id, seller_team_id, capacity_provider_id, execution_provider_id, status,
				access_level, runtime_isolation_level, human_involvement_level, ai_involvement_level,
				data_access_level, secret_access_level, supported_service_types_json, supported_regions_json,
				runtime_requirements_json, data_handling_summary, buyer_visible_risk_summary,
				governance_requirements_json, support_policy, availability_summary, ownership_snapshot_json,
				metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        product.id,
        vendor.id,
        product.sellerTeamId,
        input.capacityProviderId ?? null,
        input.executionProviderId ?? null,
        'draft',
        enumValue(input.accessLevel, COMMERCE_CAPACITY_ACCESS_LEVEL_SET, 'public_summary'),
        enumValue(input.runtimeIsolationLevel, COMMERCE_CAPACITY_RUNTIME_ISOLATION_LEVEL_SET, 'none'),
        enumValue(input.humanInvolvementLevel, COMMERCE_CAPACITY_HUMAN_INVOLVEMENT_LEVEL_SET, 'none'),
        enumValue(input.aiInvolvementLevel, COMMERCE_CAPACITY_AI_INVOLVEMENT_LEVEL_SET, 'none'),
        enumValue(input.dataAccessLevel, COMMERCE_CAPACITY_DATA_ACCESS_LEVEL_SET, 'none'),
        enumValue(input.secretAccessLevel, COMMERCE_CAPACITY_SECRET_ACCESS_LEVEL_SET, 'none'),
        JSON.stringify(arrayValue(input.supportedServiceTypes)),
        JSON.stringify(arrayValue(input.supportedRegions)),
        JSON.stringify(objectValue(input.runtimeRequirements, {})),
        input.dataHandlingSummary ?? null,
        input.buyerVisibleRiskSummary ?? null,
        JSON.stringify(objectValue(input.governanceRequirements, {})),
        input.supportPolicy ?? product.supportPolicy ?? null,
        input.availabilitySummary ?? null,
        JSON.stringify(ownershipSnapshot),
        JSON.stringify(objectValue(input.metadata, {})),
        timestamp,
        timestamp,
    ]);
    await this.recordCommerceGovernanceEvent({
        actorType: input.actorType ?? 'user',
        actorId: input.actorId ?? null,
        action: 'commerce_capacity_listing.created',
        objectType: 'commerce_capacity_listing',
        objectId: id,
        nextState: 'draft',
        reason: input.reason ?? null,
        evidence: input.evidence ?? {
            productId: product.id,
            capacityProviderId: input.capacityProviderId ?? null,
            executionProviderId: input.executionProviderId ?? null,
        },
        relatedProductId: product.id,
        relatedTeamId: product.sellerTeamId,
    });
    if (input.capacityProviderId) {
        await this.recordCommerceGovernanceEvent({
            actorType: input.actorType ?? 'user',
            actorId: input.actorId ?? null,
            action: 'commerce_capacity_listing.provider_linked',
            objectType: 'commerce_capacity_listing',
            objectId: id,
            nextState: 'linked',
            evidence: {
                capacityProviderId: input.capacityProviderId,
                executionProviderId: input.executionProviderId ?? null,
            },
            relatedProductId: product.id,
            relatedTeamId: product.sellerTeamId,
        });
    }
    return this.getCommerceCapacityListing(id);
}
