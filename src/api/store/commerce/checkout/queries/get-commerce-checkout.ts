import { MarketControlPlaneStore,serializeCommerceCheckout } from "../../../../persistence/store.ts";
export async function getCommerceCheckoutMethod(this: MarketControlPlaneStore, checkoutId) {
    await this.ensureInitialized();
    return serializeCommerceCheckout(await this.first(`SELECT * FROM commerce_checkouts WHERE id = ? LIMIT 1`, [checkoutId]));
}
