import { randomUUID } from 'node:crypto';
import { isoNow,MarketControlPlaneStore,parseJson } from "../../../persistence/store.ts";
export async function upsertTeamStorageLocatorMethod(this: MarketControlPlaneStore, teamId, input) {
    await this.ensureInitialized();
    const timestamp = isoNow();
    const existing = await this.first(`SELECT * FROM team_storage_locators WHERE team_id = ?`, [teamId]);
    if (existing) {
        await this.run(`UPDATE team_storage_locators
				 SET bucket_name = ?, manifest_key_template = ?, preview_root_template = ?, public_base_url = ?, metadata_json = ?, updated_at = ?
				 WHERE team_id = ?`, [
            input.bucketName,
            input.manifestKeyTemplate,
            input.previewRootTemplate,
            input.publicBaseUrl ?? null,
            JSON.stringify(input.metadata ?? parseJson(existing.metadata_json, {})),
            timestamp,
            teamId,
        ]);
    }
    else {
        await this.run(`INSERT INTO team_storage_locators (
					id, team_id, bucket_name, manifest_key_template, preview_root_template, public_base_url, metadata_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            randomUUID(),
            teamId,
            input.bucketName,
            input.manifestKeyTemplate,
            input.previewRootTemplate,
            input.publicBaseUrl ?? null,
            JSON.stringify(input.metadata ?? {}),
            timestamp,
            timestamp,
        ]);
    }
    return this.getTeamStorageLocator(teamId);
}
