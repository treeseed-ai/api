import { MarketControlPlaneStore } from "../../../persistence/store.ts";
export async function roleIdForKeyMethod(this: MarketControlPlaneStore, key) {
    await this.ensureInitialized();
    const row = await this.first(`SELECT id FROM roles WHERE key = ? LIMIT 1`, [key]);
    return typeof row?.id === 'string' ? row.id : null;
}
