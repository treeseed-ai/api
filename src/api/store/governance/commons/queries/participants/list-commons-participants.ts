import { MarketControlPlaneStore,serializeCommonsParticipant } from "../../../../../persistence/store.ts";
export async function listCommonsParticipantsMethod(this: MarketControlPlaneStore, filters: any = {}) {
    await this.ensureInitialized();
    const limit = Math.max(1, Math.min(200, Number(filters.limit) || 100));
    const rows = await this.all(`SELECT * FROM commons_participants
			 ${filters.status ? 'WHERE status = ?' : ''}
			 ORDER BY updated_at DESC LIMIT ?`, filters.status ? [filters.status, limit] : [limit]);
    return rows.map(serializeCommonsParticipant);
}
