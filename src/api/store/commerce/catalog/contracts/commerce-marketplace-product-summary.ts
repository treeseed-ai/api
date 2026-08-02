import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function commerceMarketplaceProductSummaryMethod(this: MarketControlPlaneStore, product, options: any = {}) {
    if (!product)
        return null;
    const vendor = await this.getCommerceVendor(product.vendorId).catch(() => null);
    const ownershipRecords = await this.listCommerceOwnershipRecords(product.id).catch(() => []);
    const currentOwnership = ownershipRecords.find((record) => record.id === product.ownershipRecordId)
        ?? ownershipRecords.find((record) => record.buyerVisible)
        ?? null;
    const stewards = await this.listCommerceStewardshipAssignments(product.id).catch(() => []);
    const offers = (await this.listCommerceOffers({ productId: product.id, status: 'approved' }).catch(() => []))
        .map(async (offer) => {
        const price = offer.activePriceId ? await this.getCommercePrice(offer.activePriceId).catch(() => null) : null;
        const checkoutEligible = ['free', 'one_time', 'one_time_current_version', 'subscription', 'subscription_updates'].includes(offer.mode)
            && (offer.mode === 'free' || price?.status === 'active');
        const serviceEligible = product.kind === 'scoped_service' && ['contact', 'scoped_contract'].includes(offer.mode);
        const capacityInquiryEligible = product.kind === 'capacity_listing' && ['contact', 'private', 'external'].includes(offer.mode);
        return {
            id: offer.id,
            mode: offer.mode,
            title: offer.title,
            status: offer.status,
            priceId: price?.id ?? null,
            unitAmount: price?.amount ?? null,
            currency: price?.currency ?? null,
            billingInterval: price?.billingInterval ?? null,
            checkoutEligible,
            serviceEligible,
            capacityInquiryEligible,
            stripeSyncStatus: price?.stripeSyncStatus ?? null,
        };
    });
    const resolvedOffers = await Promise.all(offers);
    const capacityListing = product.kind === 'capacity_listing'
        ? await this.getCommerceCapacityListingForProduct(product.id, { publicSafe: options.publicSafe }).catch(() => null)
        : null;
    const publicStewards = stewards
        .filter((assignment) => assignment.visibleToBuyers !== false)
        .map((assignment) => ({
        id: assignment.id,
        role: assignment.role,
        displayName: assignment.displayName,
        responsibilities: assignment.responsibilities,
    }));
    return {
        id: product.id,
        kind: product.kind,
        title: product.title,
        slug: product.slug,
        summary: product.summary,
        status: product.status,
        vendorId: product.vendorId,
        sellerTeamId: product.sellerTeamId,
        vendorDisplayName: vendor?.displayName ?? null,
        ownershipModel: product.ownershipModel ?? null,
        buyerVisibleOwnershipSummary: currentOwnership?.buyerVisible === false ? null : currentOwnership?.publicSummary ?? null,
        stewardshipSummary: publicStewards,
        offers: resolvedOffers,
        capacityListingId: capacityListing?.status === 'approved' ? capacityListing.id : null,
        serviceRequestEligible: product.kind === 'scoped_service' && resolvedOffers.some((offer) => offer.serviceEligible),
        checkoutEligible: resolvedOffers.some((offer) => offer.checkoutEligible),
        updatedAt: product.updatedAt,
    };
}
