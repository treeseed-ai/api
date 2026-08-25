import { ControlPlaneStore,serializePlatformOperation } from "../../../../persistence/store.ts";
export async function listPlatformOperationsMethod(this: ControlPlaneStore, input: any = {}) {
    await this.ensureInitialized();
    const limit = Math.max(1, Math.min(Number(input.limit ?? 50), 200));
    const rows = await this.all(`SELECT * FROM platform_operations ORDER BY created_at DESC LIMIT ?`, [limit]);
    return rows.map(serializePlatformOperation);
}
