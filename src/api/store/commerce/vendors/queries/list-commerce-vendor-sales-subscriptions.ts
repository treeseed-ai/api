import { MarketControlPlaneStore,serializeCommerceSubscription } from "../../../../persistence/store.ts";
export async function listCommerceVendorSalesSubscriptionsMethod(this: MarketControlPlaneStore, teamId, filters: any = {}) {
    await this.ensureInitialized();
    const rows = await this.all(`SELECT * FROM commerce_subscriptions WHERE seller_team_id = ? ORDER BY updated_at DESC, created_at DESC`, [teamId]);
    return rows.map(serializeCommerceSubscription);
}
