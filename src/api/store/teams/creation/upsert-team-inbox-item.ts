import { randomUUID } from 'node:crypto';
import { isoNow,ControlPlaneStore,serializeTeamInboxItem } from "../../../persistence/store.ts";
export async function upsertTeamInboxItemMethod(this: ControlPlaneStore, teamId, input) {
    await this.ensureInitialized();
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    await this.run(`INSERT OR REPLACE INTO team_inbox_items (
				id, team_id, project_id, kind, state, title, summary, href, item_key, metadata_json, created_at, updated_at
			) VALUES (
				?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
				COALESCE((SELECT created_at FROM team_inbox_items WHERE id = ?), ?),
				?
			)`, [
        id,
        teamId,
        input.projectId ?? null,
        input.kind,
        input.state,
        input.title,
        input.summary ?? null,
        input.href ?? null,
        input.itemKey ?? null,
        JSON.stringify(input.metadata ?? {}),
        id,
        timestamp,
        timestamp,
    ]);
    return serializeTeamInboxItem(await this.first(`SELECT * FROM team_inbox_items WHERE id = ? LIMIT 1`, [id]));
}
