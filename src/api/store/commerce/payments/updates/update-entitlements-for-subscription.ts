import { MarketControlPlaneStore,serializeCommerceEntitlement } from "../../../../persistence/store.ts";
export async function updateEntitlementsForSubscriptionMethod(this: MarketControlPlaneStore, subscriptionId, input: any = {}) {
    await this.ensureInitialized();
    const rows = await this.all(`SELECT * FROM commerce_entitlements WHERE subscription_id = ?`, [subscriptionId]);
    const updated = [];
    for (const row of rows) {
        const entitlement = serializeCommerceEntitlement(row);
        updated.push(await this.updateCommerceEntitlementStatus(entitlement.id, input));
    }
    return updated;
}
