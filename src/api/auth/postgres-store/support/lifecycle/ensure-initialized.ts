import { PostgresAuthStore } from "../../../postgres-store.ts";
export function ensureInitializedMethod(this: PostgresAuthStore) {
    if (!this.initializationPromise) {
        this.initializationPromise = this.ensureAuthSchema()
            .then(() => this.seedCatalog())
            .then(() => this.reconcileBootstrapAdmins())
            .then(() => this.seedConfiguredServices());
    }
    return this.initializationPromise;
}

