import { ControlPlaneStore } from "../../../persistence/store.ts";
export function ensureInitializedMethod(this: ControlPlaneStore) {
    if (!this.initializationPromise) {
		this.initializationPromise = Promise.resolve()
			.then(() => this.db.migrate?.())
			.then(() => process.env.TREESEED_DEVELOPMENT_MODE === 'live' ? undefined : this.seedTeamRoles())
			.then(() => process.env.TREESEED_DEVELOPMENT_MODE === 'live' ? undefined : this.syncPlatformAdminOwners());
    }
    return this.initializationPromise;
}
