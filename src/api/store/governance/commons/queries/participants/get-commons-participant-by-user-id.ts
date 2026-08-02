import { MarketControlPlaneStore,serializeCommonsParticipant } from "../../../../../persistence/store.ts";
export async function getCommonsParticipantByUserIdMethod(this: MarketControlPlaneStore, userId) {
    await this.ensureInitialized();
    return serializeCommonsParticipant(await this.first(`SELECT * FROM commons_participants WHERE user_id = ? LIMIT 1`, [userId]));
}
