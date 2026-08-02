import { CapacityWorkdayMaintenanceScheduler } from '../../../api/capacity/services/capacity/workdays/lifecycle/workday-maintenance-service.js';
import { drainNotificationEmailOutbox } from '../../../notifications/service.js';
import { runSecretOperationExecutor } from '../../security/secret-operation-executor.js';
import { FeedbackRetentionScheduler } from '../../feedback/retention-scheduler.js';
import { createClient,createControlPlaneStore,loadConfig,loadHealthConfig,packageVersion,parseRunnerOptions,registerAndHeartbeat,runOnceWithClient,startHealthServer } from '../index.js';

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
    let controlPlaneStore = null;
    let capacityWorkdayMaintenance = null;
	let feedbackRetention = null;
    while (!stopping) {
        try {
            if (!config) {
                config = await loadConfig();
            }
            if (!client) {
                client = await createClient(config);
                controlPlaneStore = createControlPlaneStore(config);
                capacityWorkdayMaintenance = controlPlaneStore
                    ? new CapacityWorkdayMaintenanceScheduler(controlPlaneStore, config.capacityWorkdayMaintenanceIntervalMs)
                    : null;
				feedbackRetention = controlPlaneStore ? new FeedbackRetentionScheduler(controlPlaneStore, config.feedbackRetentionIntervalMs) : null;
                await registerAndHeartbeat(client, config, version, { ...options, controlPlaneStore });
            }
            healthState.ready = true;
            healthState.status = 'running';
            healthState.error = null;
            await runOnceWithClient(config, client, version, { ...options, controlPlaneStore });
            if (controlPlaneStore)
                await runSecretOperationExecutor(controlPlaneStore);
            if (controlPlaneStore)
                await drainNotificationEmailOutbox(controlPlaneStore);
            await capacityWorkdayMaintenance?.runIfDue();
			await feedbackRetention?.runIfDue();
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
            await controlPlaneStore?.db?.close?.().catch?.(() => { });
            client = null;
            controlPlaneStore = null;
            capacityWorkdayMaintenance = null;
			feedbackRetention = null;
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
        await controlPlaneStore?.db?.close?.();
    }
}
