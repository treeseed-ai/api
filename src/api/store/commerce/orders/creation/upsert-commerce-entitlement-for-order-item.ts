import { isoNow,MarketControlPlaneStore,serializeCommerceEntitlement } from "../../../../persistence/store.ts";
export async function upsertCommerceEntitlementForOrderItemMethod(this: MarketControlPlaneStore, orderItemId, input: any = {}) {
    await this.ensureInitialized();
    const existing = serializeCommerceEntitlement(await this.first(`SELECT * FROM commerce_entitlements WHERE order_item_id = ? LIMIT 1`, [orderItemId]));
    if (existing) {
        return this.updateCommerceEntitlementStatus(existing.id, {
            ...input,
            status: input.status ?? existing.status,
            action: input.status === 'active' ? 'commerce_entitlement.activated' : undefined,
        });
    }
    const entitlement = await this.createCommerceEntitlement({ ...input, orderItemId });
    await this.run(`UPDATE commerce_order_items SET entitlement_id = ?, updated_at = ? WHERE id = ?`, [entitlement.id, isoNow(), orderItemId]);
    return entitlement;
}
