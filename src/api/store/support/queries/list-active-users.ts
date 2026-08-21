import { ControlPlaneStore } from "../../../persistence/store.ts";
export async function listActiveUsersMethod(this: ControlPlaneStore, limit = 50) {
    await this.ensureInitialized();
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
    return this.all(`SELECT * FROM users WHERE status = 'active' ORDER BY created_at ASC LIMIT ?`, [boundedLimit]);
}
