import { MarketControlPlaneStore,serializeCommerceStewardshipAssignment } from "../../../../persistence/store.ts";
export async function listCommerceStewardshipAssignmentsMethod(this: MarketControlPlaneStore, productId) {
    await this.ensureInitialized();
    const rows = await this.all(`SELECT * FROM commerce_stewardship_assignments WHERE product_id = ? ORDER BY created_at ASC`, [productId]);
    return rows.map(serializeCommerceStewardshipAssignment);
}
