import { MarketControlPlaneStore,serializeCommercePaymentGroup } from "../../../../../persistence/store.ts";
export async function getCommercePaymentGroupMethod(this: MarketControlPlaneStore, groupId) {
    await this.ensureInitialized();
    return serializeCommercePaymentGroup(await this.first(`SELECT * FROM commerce_payment_groups WHERE id = ? LIMIT 1`, [groupId]));
}
