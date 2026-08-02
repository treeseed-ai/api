import { PlatformRunnerClient } from '@treeseed/sdk';
import { createPlatformOperationStoreFromEnv } from '@treeseed/sdk/platform-operation-store';
import { createCapacityControlPlane } from '../../../api/capacity/control-plane.js';
import { MarketControlPlaneStore } from '../../../api/persistence/store.js';
import { createMarketPostgresDatabase } from '../../../api/support/market-postgres.js';

export function createClient(config) {
    if (config.apiDatabaseUrl) {
        return createPlatformOperationStoreFromEnv({
            databaseUrl: config.apiDatabaseUrl,
            initializeSchema: true,
        });
    }
    return new PlatformRunnerClient({
        marketUrl: config.marketUrl,
        marketId: config.marketId,
        runnerSecret: config.runnerSecret,
        userAgent: `treeseed-api-operations-runner/${process.version}`,
    });
}

export function createControlPlaneStore(config) {
    if (!config.apiDatabaseUrl)
        return null;
    const db = createMarketPostgresDatabase(config.apiDatabaseUrl);
    return createCapacityControlPlane(new MarketControlPlaneStore(config, db));
}
