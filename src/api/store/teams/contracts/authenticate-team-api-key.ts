import { equalHash,isoNow,MarketControlPlaneStore,parseJson,stableHash,tokenPrefix } from "../../../persistence/store.ts";
export async function authenticateTeamApiKeyMethod(this: MarketControlPlaneStore, token) {
    await this.ensureInitialized();
    const prefix = tokenPrefix(token);
    const rows = await this.all(`SELECT team_api_keys.*, teams.name AS team_name, teams.display_name AS team_display_name
			 FROM team_api_keys
			 INNER JOIN teams ON teams.id = team_api_keys.team_id
			 WHERE team_api_keys.key_prefix = ? AND team_api_keys.revoked_at IS NULL`, [prefix]);
    for (const row of rows) {
        if (row.expires_at && new Date(String(row.expires_at)).getTime() <= Date.now()) {
            continue;
        }
        const expected = stableHash(token, String(this.config.authSecret ?? ''));
        if (!equalHash(expected, String(row.key_hash ?? ''))) {
            continue;
        }
        await this.run(`UPDATE team_api_keys SET last_used_at = ?, updated_at = ? WHERE id = ?`, [isoNow(), isoNow(), row.id]);
        return {
            teamId: row.team_id,
            keyId: row.id,
            principal: {
                id: `team-key:${row.id}`,
                displayName: row.name,
                roles: ['team_api_key'],
                permissions: parseJson(row.permissions_json, []),
                scopes: ['auth:me'],
                metadata: {
                    teamId: row.team_id,
                    teamName: row.team_name,
                    teamDisplayName: row.team_display_name ?? row.team_name,
                },
            },
        };
    }
    return null;
}
