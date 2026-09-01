import { CapacityWorkdayMaintenanceScheduler } from '../../../api/capacity/services/capacity/workdays/lifecycle/workday-maintenance-service.js';
import { ContextQueryCheckMaintenanceScheduler } from '../../../api/capacity/services/capacity/agents/context-query-check-maintenance-service.js';
import { ContextQueryCheckService } from '../../../api/capacity/services/capacity/agents/context-query-check-service.js';
import { randomUUID } from 'node:crypto';
import { drainNotificationEmailOutbox } from '../../../notifications/service.js';
import { FeedbackRetentionScheduler } from '../../feedback/retention-scheduler.js';
import { TreeDxCommitReplicationScheduler } from '../../treedx/commit-replication-scheduler.js';
import { TreeDxRemoteHeadReconciliationScheduler } from '../../treedx/remote-head-reconciliation-scheduler.js';
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
	let contextQueryCheckMaintenance = null;
	let treeDxCommitReplication = null;
	let treeDxRemoteHeadReconciliation = null;
	let operationRunnerId = null;
    while (!stopping) {
        try {
			if (!config) {
				config = await loadConfig();
				operationRunnerId = `${config.runnerId}:process:${process.pid}:${randomUUID()}`;
            }
            if (!client) {
                client = await createClient(config);
                controlPlaneStore = createControlPlaneStore(config);
                capacityWorkdayMaintenance = controlPlaneStore
                    ? new CapacityWorkdayMaintenanceScheduler(controlPlaneStore, config.capacityWorkdayMaintenanceIntervalMs)
                    : null;
				contextQueryCheckMaintenance = controlPlaneStore
					? new ContextQueryCheckMaintenanceScheduler(new ContextQueryCheckService(controlPlaneStore), config.capacityWorkdayMaintenanceIntervalMs)
					: null;
				feedbackRetention = controlPlaneStore ? new FeedbackRetentionScheduler(controlPlaneStore, config.feedbackRetentionIntervalMs) : null;
				treeDxCommitReplication = controlPlaneStore ? new TreeDxCommitReplicationScheduler(controlPlaneStore) : null;
				treeDxRemoteHeadReconciliation = controlPlaneStore ? new TreeDxRemoteHeadReconciliationScheduler(controlPlaneStore) : null;
                await registerAndHeartbeat(client, config, version, { ...options, controlPlaneStore });
            }
            healthState.ready = true;
            healthState.status = 'running';
            healthState.error = null;
			await runOnceWithClient(config, client, version, { ...options, controlPlaneStore, operationRunnerId });
            if (controlPlaneStore)
                await drainNotificationEmailOutbox(controlPlaneStore);
            await capacityWorkdayMaintenance?.runIfDue();
			await contextQueryCheckMaintenance?.runIfDue();
			await feedbackRetention?.runIfDue();
			await treeDxCommitReplication?.runIfDue();
			await treeDxRemoteHeadReconciliation?.runIfDue();
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
			contextQueryCheckMaintenance = null;
			feedbackRetention = null;
			treeDxCommitReplication = null;
			treeDxRemoteHeadReconciliation = null;
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
