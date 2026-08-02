import { isoNow,MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function commerceCapacityOwnershipSnapshotMethod(this: MarketControlPlaneStore, product) {
    const ownershipRecords = await this.listCommerceOwnershipRecords(product.id).catch(() => []);
    const currentOwnershipRecord = ownershipRecords.find((record) => record.id === product.ownershipRecordId) ?? ownershipRecords[0] ?? null;
    const stewards = await this.listCommerceStewardshipAssignments(product.id).catch(() => []);
    return {
        capturedAt: isoNow(),
        productId: product.id,
        ownershipModel: product.ownershipModel,
        ownershipRecord: currentOwnershipRecord,
        stewards: stewards.filter((assignment) => assignment.visibleToBuyers !== false),
        sellerTeamId: product.sellerTeamId,
        vendorId: product.vendorId,
    };
}
