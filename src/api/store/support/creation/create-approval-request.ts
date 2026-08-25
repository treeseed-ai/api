import { randomUUID } from 'node:crypto';
import { isoNow,ControlPlaneStore,serializeApprovalRequest } from "../../../persistence/store.ts";
export async function createApprovalRequestMethod(this: ControlPlaneStore, input) {
    await this.ensureInitialized();
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    await this.run(`INSERT INTO approval_requests (
				id, team_id, project_id, work_day_id, task_id, kind, state, severity, requested_by_type,
				requested_by_id, title, summary, options_json, recommendation_json, policy_snapshot_json,
				expires_at, decision_json, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`, [
        id,
        input.teamId,
        input.projectId,
        input.workDayId ?? null,
        input.taskId ?? null,
        input.kind,
        input.severity ?? 'medium',
        input.requestedByType ?? 'worker',
        input.requestedById ?? null,
        input.title,
        input.summary,
        JSON.stringify(input.options ?? []),
        JSON.stringify(input.recommendation ?? {}),
        JSON.stringify(input.policySnapshot ?? {}),
        input.expiresAt ?? null,
        JSON.stringify(input.metadata ?? {}),
        timestamp,
        timestamp,
    ]);
    return serializeApprovalRequest(await this.first(`SELECT * FROM approval_requests WHERE id = ? LIMIT 1`, [id]));
}
