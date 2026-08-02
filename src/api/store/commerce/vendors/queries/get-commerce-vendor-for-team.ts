import { MarketControlPlaneStore,serializeCommerceVendor } from "../../../../persistence/store.ts";
export async function getCommerceVendorForTeamMethod(this: MarketControlPlaneStore, teamId) {
    await this.ensureInitialized();
    return serializeCommerceVendor(await this.first(`SELECT * FROM commerce_vendors WHERE team_id = ? LIMIT 1`, [teamId]));
}
