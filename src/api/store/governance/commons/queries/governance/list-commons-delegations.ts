import { ControlPlaneStore,serializeCommonsDelegation } from "../../../../../persistence/store.ts";
export async function listCommonsDelegationsMethod(this: ControlPlaneStore, principal = null) {
    await this.ensureInitialized();
    if (!principal?.id)
        return [];
    const participant = await this.getCommonsParticipantByUserId(principal.id);
    if (!participant)
        return [];
    const rows = await this.all(`SELECT * FROM commons_delegations WHERE from_participant_id = ? OR to_participant_id = ? ORDER BY created_at DESC`, [participant.id, participant.id]);
    return rows.map(serializeCommonsDelegation);
}
