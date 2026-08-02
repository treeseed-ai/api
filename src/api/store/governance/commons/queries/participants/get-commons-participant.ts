import { MarketControlPlaneStore,serializeCommonsParticipant } from "../../../../../persistence/store.ts";
export async function getCommonsParticipantMethod(this: MarketControlPlaneStore, participantId) {
    await this.ensureInitialized();
    return serializeCommonsParticipant(await this.first(`SELECT * FROM commons_participants WHERE id = ? LIMIT 1`, [participantId]));
}
