import { runPlatformOperationOnce } from '@treeseed/sdk';
import { CapacityWorkdayMaintenanceScheduler } from '../../../api/capacity/services/capacity/workdays/lifecycle/workday-maintenance-service.js';
import { FeedbackRetentionScheduler } from '../../feedback/retention-scheduler.js';
import { createClient,createControlPlaneStore,createExecutorsForOptions,loadConfig,packageVersion,registerAndHeartbeat } from '../index.js';

export async function runOnceWithClient(config, client, version, options: any = {}) {
    const controlPlaneStore = options.controlPlaneStore ?? options.store ?? null;
    await registerAndHeartbeat(client, config, version, { ...options, controlPlaneStore, config });
    const result = await runPlatformOperationOnce({
        client,
        runnerId: config.runnerId,
        workspaceRoot: config.dataDir,
        environment: config.environment,
        executors: createExecutorsForOptions({ ...options, controlPlaneStore, config }),
        operationId: options.operationId ?? null,
        limit: Math.max(1, Number(options.maxJobs ?? 1) || 1),
        leaseSeconds: 300,
    });
    console.log(JSON.stringify(result));
    if (!result.ok) {
        process.exitCode = 1;
        return result;
    }
    return result;
}

export async function runOnce(options: any = {}) {
    const config = await loadConfig();
    const version = await packageVersion();
    const client = await createClient(config);
    const controlPlaneStore = options.controlPlaneStore ?? createControlPlaneStore(config);
    try {
        const result = await runOnceWithClient(config, client, version, { ...options, controlPlaneStore });
        if (controlPlaneStore) {
            const maintenance = new CapacityWorkdayMaintenanceScheduler(controlPlaneStore, config.capacityWorkdayMaintenanceIntervalMs);
            await maintenance.runIfDue();
			const feedbackRetention = new FeedbackRetentionScheduler(controlPlaneStore, config.feedbackRetentionIntervalMs);
			await feedbackRetention.runIfDue();
        }
        return result;
    }
    finally {
        if ('close' in client && typeof client.close === 'function')
            await client.close();
        await controlPlaneStore?.db?.close?.();
    }
}
