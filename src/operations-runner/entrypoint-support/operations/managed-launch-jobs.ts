import { OperationsSdk } from '@treeseed/sdk';
import { applyHubLaunchFailure, applyHubLaunchResult } from '../../../api/support/hub-launch-application.js';
import { prepareLaunchIntentForMarketRunner, env } from '../index.js';

export async function runManagedLaunchJobs(config, store, _version, options: any = {}) {
    if (!store)
        return { ok: true, processed: 0, failed: 0 };
    const runtime = { resolved: { config: { baseUrl: config.marketUrl ?? null, apiDatabaseUrl: config.apiDatabaseUrl ?? null, environment: config.environment } } };
    const jobs = await store.pullManagedLaunchJobs({
        runnerId: config.runnerId,
        limit: Math.max(1, Number(options.maxJobs ?? 1) || 1),
    });
    let processed = 0;
    let failed = 0;
    const errors = [];
    for (const job of jobs) {
        try {
            await store.recordJobProgress(job.id, {
                summary: 'Treeseed operations runner claimed the project launch job.',
                data: {
                    runnerId: config.runnerId,
                    phase: 'launch_claimed',
                    status: 'running',
                    title: 'Launch job claimed',
                },
            });
            const prepared = await prepareLaunchIntentForMarketRunner(store, runtime, job);
            await store.recordJobProgress(job.id, {
                summary: 'Executing managed project launch.',
                data: {
                    runnerId: config.runnerId,
                    phase: 'launch_execution_running',
                    status: 'running',
                    title: 'Executing launch',
                },
            });
            const result = await new OperationsSdk().execute({
                operationName: prepared.resume ? 'hub.resume_launch' : 'hub.execute_launch',
                input: prepared.intent,
            }, {
                cwd: env('TREESEED_MARKET_REPO_ROOT', process.cwd()),
                env: {
                    ...process.env,
                    ...prepared.envOverlay as NodeJS.ProcessEnv,
                },
                transport: 'sdk',
                onProgress: async (event) => {
                    if (event.kind !== 'hub_launch_phase')
                        return;
                    await store.recordJobProgress(job.id, {
                        summary: typeof event.summary === 'string' ? event.summary : null,
                        data: {
                            ...event,
                            runnerId: config.runnerId,
                        },
                    });
                },
            });
            await applyHubLaunchResult(store, runtime, job, result.mode === 'inline' ? result.payload : result, {
                id: config.runnerId,
                type: 'service',
            });
            await store.completeJob(job.id, {
                output: result.mode === 'inline' ? result.payload : result,
            });
            processed += 1;
        }
        catch (error) {
            failed += 1;
            const message = error instanceof Error ? error.message : String(error);
            errors.push({ jobId: job.id, message });
            await applyHubLaunchFailure(store, job, {
                code: 'market_operations_runner_failed',
                message,
            }).catch(() => { });
            await store.failJob(job.id, {
                code: 'market_operations_runner_failed',
                message,
            });
        }
    }
    return { ok: failed === 0, processed, failed, errors };
}
