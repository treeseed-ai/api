import { runPlatformOperationOnce } from '@treeseed/sdk';
import { CapacityWorkdayMaintenanceScheduler } from '../../api/capacity/services/workday-maintenance-service.js';
import { createExecutorsForOptions, registerAndHeartbeat, runManagedLaunchJobs, packageVersion, loadConfig, createClient, createDeploymentStore } from './index.js';

export async function runOnceWithClient(config, client, version, options: any = {}) {
    const deploymentStore = options.deploymentStore ?? options.store ?? null;
    await registerAndHeartbeat(client, config, version, { ...options, deploymentStore, config });
    const result = await runPlatformOperationOnce({
        client,
        runnerId: config.runnerId,
        workspaceRoot: config.dataDir,
        environment: config.environment,
        executors: createExecutorsForOptions({ ...options, deploymentStore, config }),
        operationId: options.operationId ?? null,
        limit: Math.max(1, Number(options.maxJobs ?? 1) || 1),
        leaseSeconds: 300,
        throwIfCancelled: async (operation) => {
            if (!deploymentStore || operation.namespace !== 'project' || operation.operation !== 'web_deployment')
                return;
            const deploymentId = operation.input?.deploymentId;
            if (typeof deploymentId !== 'string' || !deploymentId)
                return;
            const deployment = await deploymentStore.findProjectDeploymentById(deploymentId);
            if (!deployment?.metadata?.cancellation?.requested)
                return;
            await deploymentStore.updateProjectDeployment(deployment.id, {
                status: 'cancelled',
                summary: 'Deployment was cancelled.',
                error: {
                    code: 'deployment_cancelled',
                    message: 'Deployment cancellation was requested.',
                    retrySafe: true,
                    resumeSafe: false,
                },
            });
            await deploymentStore.appendProjectDeploymentEvent(deployment.id, {
                kind: 'deployment.cancelled',
                message: 'Deployment was cancelled.',
                status: 'cancelled',
                severity: 'warning',
                operationId: operation.id,
            });
            await deploymentStore.recordProjectDeploymentAudit?.(deployment.id, 'project_deployment_cancelled', {
                actorType: 'system',
                actorId: config.runnerId,
                actorUserId: deployment.requestedByUserId ?? null,
                status: 'cancelled',
                operationId: operation.id,
                summary: 'Deployment was cancelled.',
            });
            throw new Error('Deployment cancellation was requested.');
        },
    });
    console.log(JSON.stringify(result));
    if (!result.ok) {
        process.exitCode = 1;
        return result;
    }
    const launchResult = await runManagedLaunchJobs(config, deploymentStore, version, options);
    if (launchResult.processed > 0 || launchResult.failed > 0) {
        const combined = {
            ...result,
            managedLaunch: launchResult,
        };
        console.log(JSON.stringify(combined));
        if (!launchResult.ok)
            process.exitCode = 1;
        return combined;
    }
    return result;
}

export async function runOnce(options: any = {}) {
    const config = await loadConfig();
    const version = await packageVersion();
    const client = await createClient(config);
    const deploymentStore = options.deploymentStore ?? createDeploymentStore(config);
    try {
        const result = await runOnceWithClient(config, client, version, { ...options, deploymentStore });
        if (deploymentStore) {
            const maintenance = new CapacityWorkdayMaintenanceScheduler(deploymentStore, config.capacityWorkdayMaintenanceIntervalMs);
            await maintenance.runIfDue();
        }
        return result;
    }
    finally {
        if ('close' in client && typeof client.close === 'function')
            await client.close();
        await deploymentStore?.db?.close?.();
    }
}
