import { ControlPlaneStore,serializeApprovalRequest } from "../../../../persistence/store.ts";
export async function listApprovalRequestsForTeamMethod(this: ControlPlaneStore, teamId, options: any = {}) {
    await this.ensureInitialized();
    const limit = Math.max(1, Math.min(200, Number(options.limit) || 50));
    const kind = typeof options.kind === 'string' && options.kind.trim() ? options.kind.trim() : null;
    const rows = kind
        ? await this.all(`SELECT * FROM approval_requests
				 WHERE team_id = ? AND kind = ?
				 ORDER BY created_at DESC LIMIT ?`, [teamId, kind, limit])
        : await this.all(`SELECT * FROM approval_requests
				 WHERE team_id = ?
				 ORDER BY created_at DESC LIMIT ?`, [teamId, limit]);
    return rows.map(serializeApprovalRequest);
}
