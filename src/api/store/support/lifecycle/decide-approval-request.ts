import { isoNow,MarketControlPlaneStore } from "../../../persistence/store.ts";
export async function decideApprovalRequestMethod(this: MarketControlPlaneStore, id, input) {
    await this.ensureInitialized();
    const existing = await this.getApprovalRequest(id);
    if (!existing)
        return null;
    const timestamp = isoNow();
    const state = input.state === 'rejected' ? 'rejected' : input.state === 'expired' ? 'expired' : 'approved';
    await this.run(`UPDATE approval_requests
			 SET state = ?, decided_by_type = ?, decided_by_id = ?, decided_at = ?, decision_json = ?, updated_at = ?
			 WHERE id = ?`, [
        state,
        input.decidedByType ?? 'user',
        input.decidedById ?? null,
        timestamp,
        JSON.stringify(input.decision ?? {}),
        timestamp,
        id,
    ]);
    return this.getApprovalRequest(id);
}
