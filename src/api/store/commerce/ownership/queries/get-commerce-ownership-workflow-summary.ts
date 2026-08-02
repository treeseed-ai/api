import { MarketControlPlaneStore,serializeCommerceOwnershipTransfer,serializeCommerceOwnershipWorkflowSummary } from "../../../../persistence/store.ts";
export async function getCommerceOwnershipWorkflowSummaryMethod(this: MarketControlPlaneStore, productId) {
    await this.ensureInitialized();
    const product = await this.getCommerceProduct(productId);
    if (!product)
        return null;
    const ownershipRecords = await this.listCommerceOwnershipRecords(productId);
    const currentOwnershipRecord = ownershipRecords.find((record) => record.id === product.ownershipRecordId) ?? null;
    const transfers = (await this.all(`SELECT * FROM commerce_ownership_transfers WHERE product_id = ? ORDER BY created_at DESC`, [productId]))
        .map(serializeCommerceOwnershipTransfer);
    return serializeCommerceOwnershipWorkflowSummary({
        productId,
        currentOwnershipRecord,
        buyerVisibleOwnershipRecords: ownershipRecords.filter((record) => record.buyerVisible),
        stewardshipAssignments: await this.listCommerceStewardshipAssignments(productId),
        contributions: await this.listCommerceContributions(productId),
        governancePolicies: await this.listCommerceGovernancePolicies({ productId }),
        pendingTransfers: transfers,
        successionEvents: await this.listCommerceSuccessionEvents(productId),
    });
}
