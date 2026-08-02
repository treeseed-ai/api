import { MarketControlPlaneStore,serializeCommerceEntitlement } from "../../../../../persistence/store.ts";
export async function getCommerceEntitlementMethod(this: MarketControlPlaneStore, entitlementId) {
    await this.ensureInitialized();
    return serializeCommerceEntitlement(await this.first(`SELECT * FROM commerce_entitlements WHERE id = ? LIMIT 1`, [entitlementId]));
}
