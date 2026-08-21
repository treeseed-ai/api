import { PlatformRunnerClient } from '@treeseed/sdk';
import { createPlatformOperationStoreFromEnv } from '@treeseed/sdk/platform-operation-store';
import { createCapacityControlPlane } from '../../../api/capacity/control-plane.js';
import { ControlPlaneStore } from '../../../api/persistence/store.js';
import { createControlPlanePostgresDatabase } from '../../../api/support/control-plane-postgres.js';

export function createClient(config) {
    if (config.apiDatabaseUrl) {
        return createPlatformOperationStoreFromEnv({
            databaseUrl: config.apiDatabaseUrl,
            initializeSchema: true,
        });
    }
    return new PlatformRunnerClient({
        marketUrl: config.serverUrl,
        marketId: config.serverId,
        runnerSecret: config.runnerSecret,
        userAgent: `treeseed-api-operations-runner/${process.version}`,
    });
}

export function createControlPlaneStore(config) {
    if (!config.apiDatabaseUrl)
        return null;
    const db = createControlPlanePostgresDatabase(config.apiDatabaseUrl);
    return createCapacityControlPlane(new ControlPlaneStore(config, db));
}
