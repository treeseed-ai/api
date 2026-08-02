import { parseJson } from '../../foundation.ts';

export function serializeCommerceVendor(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        teamId: row.team_id,
        displayName: row.display_name,
        slug: row.slug,
        status: row.status,
        trustLevel: row.trust_level,
        professionalEntitlementId: row.professional_entitlement_id,
        stripeAccountId: row.stripe_account_id,
        salesEnabled: Boolean(row.sales_enabled),
        serviceSalesEnabled: Boolean(row.service_sales_enabled),
        capacityListingsEnabled: Boolean(row.capacity_listings_enabled),
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeCommerceProduct(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        vendorId: row.vendor_id,
        sellerTeamId: row.seller_team_id,
        kind: row.kind,
        slug: row.slug,
        title: row.title,
        summary: row.summary,
        description: row.description,
        status: row.status,
        visibility: row.visibility,
        catalogItemId: row.catalog_item_id,
        currentVersionId: row.current_version_id,
        ownershipModel: row.ownership_model,
        ownershipRecordId: row.ownership_record_id,
        supportPolicy: row.support_policy,
        license: row.license,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeCommerceProductVersion(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        productId: row.product_id,
        version: row.version,
        status: row.status,
        catalogArtifactVersionId: row.catalog_artifact_version_id,
        manifestKey: row.manifest_key,
        artifactKey: row.artifact_key,
        integrity: row.integrity,
        releaseNotes: row.release_notes,
        compatibility: parseJson(row.compatibility_json, {}),
        metadata: parseJson(row.metadata_json, {}),
        publishedAt: row.published_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeCommerceOffer(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        productId: row.product_id,
        productVersionId: row.product_version_id,
        vendorId: row.vendor_id,
        sellerTeamId: row.seller_team_id,
        mode: row.mode,
        status: row.status,
        title: row.title,
        termsSummary: row.terms_summary,
        accessScope: parseJson(row.access_scope_json, {}),
        supportScope: parseJson(row.support_scope_json, {}),
        fulfillmentMode: row.fulfillment_mode,
        activePriceId: row.active_price_id,
        stripeProductId: row.stripe_product_id,
        stripeProductStatus: row.stripe_product_status ?? 'not_synced',
        stripeProductSyncedAt: row.stripe_product_synced_at,
        stripeProductSyncError: row.stripe_product_sync_error,
        stripeProductMetadata: parseJson(row.stripe_product_metadata_json, {}),
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeCommercePrice(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        offerId: row.offer_id,
        amount: Number(row.amount ?? 0),
        currency: row.currency,
        billingInterval: row.billing_interval,
        status: row.status,
        stripeProductId: row.stripe_product_id,
        stripePriceId: row.stripe_price_id,
        stripeLookupKey: row.stripe_lookup_key,
        stripeSyncStatus: row.stripe_sync_status ?? 'not_synced',
        stripeSyncedAt: row.stripe_synced_at,
        stripeSyncError: row.stripe_sync_error,
        stripeMetadata: parseJson(row.stripe_metadata_json, {}),
        priceVersion: Number(row.price_version ?? 1),
        taxBehavior: row.tax_behavior,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeCommerceWebhookEvent(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        provider: row.provider,
        environment: row.environment,
        eventId: row.event_id,
        eventType: row.event_type,
        connectedAccountId: row.connected_account_id,
        status: row.status,
        objectType: row.object_type,
        objectId: row.object_id,
        relatedOrderId: row.related_order_id,
        relatedSubscriptionId: row.related_subscription_id,
        payloadHash: row.payload_hash,
        processingError: row.processing_error,
        receivedAt: row.received_at,
        processedAt: row.processed_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
