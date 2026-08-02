import { randomUUID } from 'node:crypto';
import { isoNow,MarketControlPlaneStore,serializeHubRepository } from "../../../persistence/store.ts";
export async function upsertHubRepositoryMethod(this: MarketControlPlaneStore, hubId, input) {
    await this.ensureInitialized();
    const timestamp = isoNow();
    const project = await this.getProject(hubId);
    const teamId = input.teamId ?? project?.teamId;
    if (!teamId)
        throw new Error('teamId is required for hub repository records.');
    const role = String(input.role);
    const existing = await this.first(`SELECT * FROM hub_repositories WHERE hub_id = ? AND role = ? LIMIT 1`, [hubId, role]);
    const payload = [
        teamId,
        role,
        input.provider ?? 'github',
        input.owner,
        input.name,
        input.url ?? null,
        input.defaultBranch ?? null,
        input.currentBranch ?? input.defaultBranch ?? null,
        input.status ?? 'queued',
        JSON.stringify(input.accessPolicy ?? {}),
        JSON.stringify(input.releasePolicy ?? {}),
        JSON.stringify(input.publishPolicy ?? {}),
        input.submodulePath ?? null,
        JSON.stringify(input.metadata ?? {}),
    ];
    if (existing) {
        await this.run(`UPDATE hub_repositories
				 SET team_id = ?, role = ?, provider = ?, owner = ?, name = ?, url = ?,
				     default_branch = ?, current_branch = ?, status = ?, access_policy_json = ?, release_policy_json = ?,
				     publish_policy_json = ?, submodule_path = ?, metadata_json = ?, updated_at = ?
				 WHERE hub_id = ? AND role = ?`, [...payload, timestamp, hubId, role]);
        return serializeHubRepository(await this.first(`SELECT * FROM hub_repositories WHERE hub_id = ? AND role = ?`, [hubId, role]));
    }
    const id = input.id ?? randomUUID();
    await this.run(`INSERT INTO hub_repositories (
				id, hub_id, team_id, role, provider, owner, name, url, default_branch, current_branch, status,
				access_policy_json, release_policy_json, publish_policy_json, submodule_path, metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, hubId, ...payload, timestamp, timestamp]);
    return serializeHubRepository(await this.first(`SELECT * FROM hub_repositories WHERE id = ?`, [id]));
}
