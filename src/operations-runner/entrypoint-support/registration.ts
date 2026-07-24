import { createExecutorsForOptions } from './index.js';

export async function registerAndHeartbeat(client, config, version, options: any = {}) {
    const executors = createExecutorsForOptions({ ...options, config });
    const payload = {
        runnerId: config.runnerId,
        name: config.runnerId,
        environment: config.environment,
        version,
        capabilities: executors.map((executor) => `${executor.namespace}:${executor.operation}`),
        maxConcurrentJobs: Math.max(1, Number(options.maxJobs ?? 1) || 1),
        metadata: {
            dataDir: config.dataDir,
            process: 'operations-runner',
            queue: {
                activeJobCount: 0,
                maxConcurrentJobs: Math.max(1, Number(options.maxJobs ?? 1) || 1),
            },
            planOnly: options.planOnly === true,
        },
    };
    await client.register(payload);
    await client.heartbeat({
        runnerId: config.runnerId,
        environment: config.environment,
        version,
        activeJobCount: 0,
        maxConcurrentJobs: payload.maxConcurrentJobs,
        capabilities: payload.capabilities,
    });
}
