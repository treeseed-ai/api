import { randomUUID } from 'node:crypto';
import { isoNow,MarketControlPlaneStore,TEAM_ROLE_DESCRIPTIONS } from "../../../persistence/store.ts";
export async function seedTeamRolesMethod(this: MarketControlPlaneStore) {
    const timestamp = isoNow();
    for (const [key, description] of Object.entries(TEAM_ROLE_DESCRIPTIONS)) {
        await this.run(`INSERT OR IGNORE INTO roles (id, key, description, created_at)
				 VALUES (?, ?, ?, ?)`, [randomUUID(), key, description, timestamp]);
    }
}
