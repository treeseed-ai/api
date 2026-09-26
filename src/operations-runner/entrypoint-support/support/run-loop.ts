import { CapacityWorkdayMaintenanceScheduler } from '../../../api/capacity/services/capacity/workdays/lifecycle/workday-maintenance-service.js';
import { ContextQueryCheckMaintenanceScheduler } from '../../../api/capacity/services/capacity/agents/context-query-check-maintenance-service.js';
import { ContextQueryCheckService } from '../../../api/capacity/services/capacity/agents/context-query-check-service.js';
import { randomUUID } from 'node:crypto';
import { drainNotificationEmailOutbox } from '../../../notifications/service.js';
import { FeedbackRetentionScheduler } from '../../feedback/retention-scheduler.js';
import { TreeDxCommitReplicationScheduler } from '../../treedx/commit-replication-scheduler.js';
import { TreeDxRemoteHeadReconciliationScheduler } from '../../treedx/remote-head-reconciliation-scheduler.js';
import { createClient,createControlPlaneStore,loadConfig,loadHealthConfig,packageVersion,parseRunnerOptions,registerAndHeartbeat,runOnceWithClient,startHealthServer } from '../index.js';

export function startWorkdayMaintenanceClock(scheduler: Pick<CapacityWorkdayMaintenanceScheduler, 'runIfDue'>, intervalMs: number) {
	const tick = () => { void scheduler.runIfDue().catch((error: unknown) => {
		console.error(JSON.stringify({ ok: false, event: 'workday.maintenance.failed',
			error: error instanceof Error ? error.message : String(error) }));
	}); };
	tick();
	const timer = setInterval(tick, intervalMs);
	timer.unref();
	return timer;
}

export async function runLoop() {
    const healthState = { ready: false, status: 'booting', error: null };
    const healthServer = startHealthServer(loadHealthConfig(), healthState);
    const version = await packageVersion();
    const options = parseRunnerOptions();
    let stopping = false;
    const stop = () => { stopping = true; healthState.ready = false; healthState.status = 'draining'; };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    let client = null;
    let config = null;
    let controlPlaneStore = null;
    let capacityWorkdayMaintenance = null;
	let capacityWorkdayTimer: ReturnType<typeof setInterval> | null = null;
	let feedbackRetention = null;
	let contextQueryCheckMaintenance = null;
	let treeDxCommitReplication = null;
	let treeDxRemoteHeadReconciliation = null;
	let operationRunnerId = null;
    while (!stopping) {
        let claimed = false;
        try {
			if (!config) {
				config = await loadConfig();
				operationRunnerId = `${config.runnerId}:process:${process.pid}:${randomUUID()}`;
            }
            if (!client) {
                controlPlaneStore = createControlPlaneStore(config);
                client = await createClient(config, controlPlaneStore);
                capacityWorkdayMaintenance = controlPlaneStore
                    ? new CapacityWorkdayMaintenanceScheduler(controlPlaneStore, config.capacityWorkdayMaintenanceIntervalMs)
                    : null;
				if (capacityWorkdayMaintenance && !capacityWorkdayTimer) {
					// A hosted operation may run longer than a planning turn. Workday
					// admission must continue independently of that operation poll.
					capacityWorkdayTimer = startWorkdayMaintenanceClock(capacityWorkdayMaintenance,
						config.capacityWorkdayMaintenanceIntervalMs);
				}
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
			const operationResult = await runOnceWithClient(config, client, version, { ...options, controlPlaneStore, operationRunnerId });
			claimed = operationResult?.claimed === true;
            if (controlPlaneStore)
                await drainNotificationEmailOutbox(controlPlaneStore);
			await contextQueryCheckMaintenance?.runIfDue();
			await feedbackRetention?.runIfDue();
			await treeDxCommitReplication?.runIfDue();
			await treeDxRemoteHeadReconciliation?.runIfDue();
        }
        catch (error) {
			if (capacityWorkdayTimer) clearInterval(capacityWorkdayTimer);
			capacityWorkdayTimer = null;
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
        // Drain known work without imposing the idle polling interval between
        // operations. The one-operation claim remains the concurrency fence.
        if (!claimed) await new Promise((resolveSleep) => setTimeout(resolveSleep, options.pollIntervalMs));
    }
	if (capacityWorkdayTimer) clearInterval(capacityWorkdayTimer);
    try { if (client && config) {
        await client.heartbeat({
            runnerId: config.runnerId,
            environment: config.environment,
            version,
            status: 'offline',
            activeJobCount: 0,
        }).catch(() => { });
        await client.close?.();
        await controlPlaneStore?.db?.close?.();
    } } finally {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
        healthServer?.close();
    }
}
