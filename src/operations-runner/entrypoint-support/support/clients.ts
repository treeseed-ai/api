import { createCapacityControlPlane } from '../../../api/capacity/control-plane.js';
import { ControlPlaneStore } from '../../../api/persistence/store.js';
import { createControlPlanePostgresDatabase } from '../../../api/support/control-plane-postgres.js';
import { ControlPlaneRunnerClient } from '../../client/control-plane-runner-client.js';
import { DirectControlPlaneRunnerClient } from '../../client/direct-control-plane-runner-client.js';

export function createClient(config) {
    if (config.apiDatabaseUrl) {
        const store = createControlPlaneStore(config);
        if (!store) throw new Error('API database URL is required for a direct operations runner.');
        return new DirectControlPlaneRunnerClient(store);
    }
    return new ControlPlaneRunnerClient({
        serverUrl: config.serverUrl,
        serverId: config.serverId,
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
