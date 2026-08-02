import { isoNow,MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function buildCommerceOwnershipSnapshotMethod(this: MarketControlPlaneStore, productId) {
    const product = await this.getCommerceProduct(productId);
    if (!product)
        return {};
    const records = await this.listCommerceOwnershipRecords(productId).catch(() => []);
    const stewards = await this.listCommerceStewardshipAssignments(productId).catch(() => []);
    const ownership = records.find((record) => record.id === product.ownershipRecordId) ?? records[0] ?? null;
    return {
        capturedAt: isoNow(),
        productId,
        ownershipModel: product.ownershipModel,
        ownershipRecord: ownership,
        stewards: stewards.filter((assignment) => assignment.visibleToBuyers !== false),
        sellerTeamId: product.sellerTeamId,
        vendorId: product.vendorId,
    };
}
