import { MarketControlPlaneStore } from "../../../persistence/store.ts";
export function ensureInitializedMethod(this: MarketControlPlaneStore) {
    if (!this.initializationPromise) {
		this.initializationPromise = Promise.resolve()
			.then(() => this.db.migrate?.())
			.then(() => this.seedTeamRoles())
			.then(() => this.syncPlatformAdminOwners());
    }
    return this.initializationPromise;
}
