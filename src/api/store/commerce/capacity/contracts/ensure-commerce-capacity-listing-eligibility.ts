import { MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function ensureCommerceCapacityListingEligibilityMethod(this: MarketControlPlaneStore, product, input: any = {}, capacity) {
    if (!product) {
        const error: Error & Record<string, any> = new Error('Unknown commerce product.');
        error.status = 404;
        throw error;
    }
    if (product.kind !== 'capacity_listing') {
        const error: Error & Record<string, any> = new Error('Capacity listing metadata requires a capacity_listing product.');
        error.status = 409;
        throw error;
    }
    const vendor = await this.getCommerceVendor(product.vendorId);
    if (!vendor || vendor.status !== 'approved') {
        const error: Error & Record<string, any> = new Error('Approved vendor capability is required for capacity listings.');
        error.status = 409;
        throw error;
    }
    if (vendor.capacityListingsEnabled !== true) {
        const error: Error & Record<string, any> = new Error('Vendor capacity listing capability is required.');
        error.status = 409;
        throw error;
    }
    if (!input.marketAdmin && vendor.trustLevel !== 'trusted_capacity_vendor') {
        const error: Error & Record<string, any> = new Error('trusted_capacity_vendor trust is required for capacity marketplace listings.');
        error.status = 409;
        throw error;
    }
    await this.validateCommerceCapacityProviderDisclosure(product, input, capacity);
    return vendor;
}
