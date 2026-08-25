import { randomUUID } from 'node:crypto';
import { isoNow,ControlPlaneStore,TEAM_ROLE_DESCRIPTIONS } from "../../../persistence/store.ts";
export async function seedTeamRolesMethod(this: ControlPlaneStore) {
    const timestamp = isoNow();
    for (const [key, description] of Object.entries(TEAM_ROLE_DESCRIPTIONS)) {
        await this.run(`INSERT OR IGNORE INTO roles (id, key, description, created_at)
				 VALUES (?, ?, ?, ?)`, [randomUUID(), key, description, timestamp]);
    }
}
