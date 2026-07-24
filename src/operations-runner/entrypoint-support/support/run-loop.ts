import { CapacityWorkdayMaintenanceScheduler } from '../../../api/capacity/services/capacity/workdays/lifecycle/workday-maintenance-service.js';
import { drainNotificationEmailOutbox } from '../../../notifications/service.js';
import { registerAndHeartbeat, runOnceWithClient, startHealthServer, parseRunnerOptions, packageVersion, loadConfig, loadHealthConfig, createClient, createDeploymentStore } from '../index.js';

export async function runLoop() {
    const healthState = { ready: false, status: 'booting', error: null };
    startHealthServer(loadHealthConfig(), healthState);
    const version = await packageVersion();
    const options = parseRunnerOptions();
    let stopping = false;
    process.once('SIGINT', () => { stopping = true; });
    process.once('SIGTERM', () => { stopping = true; });
    let client = null;
    let config = null;
    let deploymentStore = null;
    let capacityWorkdayMaintenance = null;
    while (!stopping) {
        try {
            if (!config) {
                config = await loadConfig();
            }
            if (!client) {
                client = await createClient(config);
                deploymentStore = createDeploymentStore(config);
                capacityWorkdayMaintenance = deploymentStore
                    ? new CapacityWorkdayMaintenanceScheduler(deploymentStore, config.capacityWorkdayMaintenanceIntervalMs)
                    : null;
                await registerAndHeartbeat(client, config, version, { ...options, deploymentStore });
            }
            healthState.ready = true;
            healthState.status = 'running';
            healthState.error = null;
            await runOnceWithClient(config, client, version, { ...options, deploymentStore });
            if (deploymentStore)
                await drainNotificationEmailOutbox(deploymentStore);
            await capacityWorkdayMaintenance?.runIfDue();
        }
        catch (error) {
            healthState.ready = false;
            healthState.status = 'degraded';
            healthState.error = error instanceof Error ? error.message : String(error);
            console.error(JSON.stringify({
                ok: false,
                error: healthState.error,
            }));
            if (client?.close) {
                await client.close().catch(() => { });
            }
            await deploymentStore?.db?.close?.().catch?.(() => { });
            client = null;
            deploymentStore = null;
            capacityWorkdayMaintenance = null;
        }
        await new Promise((resolveSleep) => setTimeout(resolveSleep, options.pollIntervalMs));
    }
    if (client && config) {
        await client.heartbeat({
            runnerId: config.runnerId,
            environment: config.environment,
            version,
            status: 'offline',
            activeJobCount: 0,
        }).catch(() => { });
        await client.close?.();
        await deploymentStore?.db?.close?.();
    }
}
