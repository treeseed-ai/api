import { COMMERCE_CHECKOUT_STATUS_SET,enumValue,isoNow,MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function updateCommerceCheckoutStatusMethod(this: MarketControlPlaneStore, checkoutId, input: any = {}) {
    await this.ensureInitialized();
    const existing = await this.getCommerceCheckout(checkoutId);
    if (!existing)
        return null;
    const status = enumValue(input.status, COMMERCE_CHECKOUT_STATUS_SET, existing.status);
    const completedGroupCount = input.completedGroupCount === undefined ? existing.completedGroupCount : Number(input.completedGroupCount);
    await this.run(`UPDATE commerce_checkouts SET status = ?, completed_group_count = ?, metadata_json = ?, updated_at = ? WHERE id = ?`, [
        status,
        completedGroupCount,
        JSON.stringify(input.metadata ?? existing.metadata ?? {}),
        isoNow(),
        checkoutId,
    ]);
    return this.getCommerceCheckout(checkoutId);
}
