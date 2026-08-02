import { arrayValue,COMMERCE_CAPACITY_ACCESS_LEVEL_SET,COMMERCE_CAPACITY_AI_INVOLVEMENT_LEVEL_SET,COMMERCE_CAPACITY_DATA_ACCESS_LEVEL_SET,COMMERCE_CAPACITY_HUMAN_INVOLVEMENT_LEVEL_SET,COMMERCE_CAPACITY_RUNTIME_ISOLATION_LEVEL_SET,COMMERCE_CAPACITY_SECRET_ACCESS_LEVEL_SET,enumValue,isoNow,MarketControlPlaneStore,objectValue,serializeCommerceCapacityListing } from "../../../../persistence/store.ts";
export async function updateCommerceCapacityListingMethod(this: MarketControlPlaneStore, listingId, input: any = {}, capacity) {
    await this.ensureInitialized();
    const existingRow = await this.first(`SELECT * FROM commerce_capacity_listings WHERE id = ? LIMIT 1`, [listingId]);
    const existing = serializeCommerceCapacityListing(existingRow);
    if (!existing)
        return null;
    const product = await this.getCommerceProduct(existing.productId);
    await this.ensureCommerceCapacityListingEligibility(product, {
        ...input,
        capacityProviderId: input.capacityProviderId === undefined ? existing.capacityProviderId : input.capacityProviderId,
        executionProviderId: input.executionProviderId === undefined ? existing.executionProviderId : input.executionProviderId,
    }, capacity);
    const timestamp = isoNow();
    await this.run(`UPDATE commerce_capacity_listings
			 SET capacity_provider_id = ?, execution_provider_id = ?, access_level = ?, runtime_isolation_level = ?,
			     human_involvement_level = ?, ai_involvement_level = ?, data_access_level = ?, secret_access_level = ?,
			     supported_service_types_json = ?, supported_regions_json = ?, runtime_requirements_json = ?,
			     data_handling_summary = ?, buyer_visible_risk_summary = ?, governance_requirements_json = ?,
			     support_policy = ?, availability_summary = ?, metadata_json = ?, updated_at = ?
			 WHERE id = ?`, [
        input.capacityProviderId === undefined ? existing.capacityProviderId : input.capacityProviderId,
        input.executionProviderId === undefined ? existing.executionProviderId : input.executionProviderId,
        enumValue(input.accessLevel, COMMERCE_CAPACITY_ACCESS_LEVEL_SET, existing.accessLevel),
        enumValue(input.runtimeIsolationLevel, COMMERCE_CAPACITY_RUNTIME_ISOLATION_LEVEL_SET, existing.runtimeIsolationLevel),
        enumValue(input.humanInvolvementLevel, COMMERCE_CAPACITY_HUMAN_INVOLVEMENT_LEVEL_SET, existing.humanInvolvementLevel),
        enumValue(input.aiInvolvementLevel, COMMERCE_CAPACITY_AI_INVOLVEMENT_LEVEL_SET, existing.aiInvolvementLevel),
        enumValue(input.dataAccessLevel, COMMERCE_CAPACITY_DATA_ACCESS_LEVEL_SET, existing.dataAccessLevel),
        enumValue(input.secretAccessLevel, COMMERCE_CAPACITY_SECRET_ACCESS_LEVEL_SET, existing.secretAccessLevel),
        JSON.stringify(input.supportedServiceTypes === undefined ? existing.supportedServiceTypes : arrayValue(input.supportedServiceTypes)),
        JSON.stringify(input.supportedRegions === undefined ? existing.supportedRegions : arrayValue(input.supportedRegions)),
        JSON.stringify(input.runtimeRequirements === undefined ? existing.runtimeRequirements : objectValue(input.runtimeRequirements, {})),
        input.dataHandlingSummary === undefined ? existing.dataHandlingSummary : input.dataHandlingSummary,
        input.buyerVisibleRiskSummary === undefined ? existing.buyerVisibleRiskSummary : input.buyerVisibleRiskSummary,
        JSON.stringify(input.governanceRequirements === undefined ? existing.governanceRequirements : objectValue(input.governanceRequirements, {})),
        input.supportPolicy === undefined ? existing.supportPolicy : input.supportPolicy,
        input.availabilitySummary === undefined ? existing.availabilitySummary : input.availabilitySummary,
        JSON.stringify(input.metadata === undefined ? existing.metadata : objectValue(input.metadata, {})),
        timestamp,
        listingId,
    ]);
    const updated = await this.getCommerceCapacityListing(listingId);
    await this.recordCommerceGovernanceEvent({
        actorType: input.actorType ?? 'user',
        actorId: input.actorId ?? null,
        action: 'commerce_capacity_listing.updated',
        objectType: 'commerce_capacity_listing',
        objectId: listingId,
        priorState: existing.status,
        nextState: updated.status,
        reason: input.reason ?? null,
        evidence: input.evidence ?? {},
        relatedProductId: existing.productId,
        relatedTeamId: existing.sellerTeamId,
    });
    if (input.capacityProviderId && input.capacityProviderId !== existing.capacityProviderId) {
        await this.recordCommerceGovernanceEvent({
            actorType: input.actorType ?? 'user',
            actorId: input.actorId ?? null,
            action: 'commerce_capacity_listing.provider_linked',
            objectType: 'commerce_capacity_listing',
            objectId: listingId,
            evidence: {
                capacityProviderId: input.capacityProviderId,
                executionProviderId: input.executionProviderId ?? null,
            },
            relatedProductId: existing.productId,
            relatedTeamId: existing.sellerTeamId,
        });
    }
    return updated;
}
