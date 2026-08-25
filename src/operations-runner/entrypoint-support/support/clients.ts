import { createCapacityControlPlane } from '../../../api/capacity/control-plane.js';
import { ControlPlaneStore } from '../../../api/persistence/store.js';
import { createControlPlanePostgresDatabase } from '../../../api/support/control-plane-postgres.js';
import { DirectControlPlaneRunnerClient } from '../../client/direct-control-plane-runner-client.js';

export function createClient(config) {
    const store = createControlPlaneStore(config);
    if (!store) throw new Error('API database URL is required for the operations runner.');
    return new DirectControlPlaneRunnerClient(store);
}

export function createControlPlaneStore(config) {
    if (!config.apiDatabaseUrl)
        return null;
    const db = createControlPlanePostgresDatabase(config.apiDatabaseUrl);
    return createCapacityControlPlane(new ControlPlaneStore(config, db));
}
