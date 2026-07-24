import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolveApiDatabaseUrl } from '@treeseed/sdk/api';
import { readArg } from '../index.js';

export function env(name, fallback = null) {
    const value = process.env[name];
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export function isLoopbackUrl(value) {
    if (typeof value !== 'string' || !value.trim())
        return false;
    try {
        const parsed = new URL(value);
        return ['127.0.0.1', 'localhost', '0.0.0.0'].includes(parsed.hostname);
    }
    catch {
        return /(?:^|@|\/\/)(?:127\.0\.0\.1|localhost)(?::|\/|$)/u.test(value);
    }
}

export async function packageVersion() {
    try {
        const raw = await readFile(resolve(process.cwd(), 'package.json'), 'utf8');
        return JSON.parse(raw).version ?? '0.0.0';
    }
    catch {
        return '0.0.0';
    }
}

export async function loadConfig({ requireSecrets = true }: any = {}) {
    const marketId = readArg('--market') ?? env('TREESEED_MANAGER_ID', 'local');
    const apiTransport = env('TREESEED_PLATFORM_RUNNER_API_TRANSPORT', 'database');
    const forceHttpTransport = apiTransport === 'http';
    const apiDatabaseUrl = forceHttpTransport
        ? null
        : resolveApiDatabaseUrl(process.env, env('TREESEED_API_BASE_URL') ?? 'http://127.0.0.1:3000');
    const config = {
        marketUrl: env('TREESEED_API_BASE_URL') ?? env('TREESEED_URL'),
        apiDatabaseUrl,
        marketId,
        runnerId: env('TREESEED_PLATFORM_RUNNER_ID', marketId === 'prod' ? 'treeseed-ops-prod-1' : marketId === 'staging' ? 'treeseed-ops-staging-1' : 'treeseed-ops-local-1'),
        runnerSecret: env('TREESEED_PLATFORM_RUNNER_SECRET'),
        dataDir: env('TREESEED_PLATFORM_RUNNER_DATA_DIR', resolve(process.cwd(), '.treeseed/operations-runner')),
        environment: env('TREESEED_PLATFORM_RUNNER_ENVIRONMENT', marketId === 'prod' ? 'production' : marketId),
        port: Number(env('PORT', '0')),
        capacityWorkdayMaintenanceIntervalMs: Math.max(1000, Number(env('TREESEED_CAPACITY_WORKDAY_MAINTENANCE_INTERVAL_MS', '30000')) || 30000),
    };
    if (requireSecrets) {
        const missing = config.apiDatabaseUrl
            ? []
            : Object.entries({
                TREESEED_API_BASE_URL: config.marketUrl,
                TREESEED_PLATFORM_RUNNER_SECRET: config.runnerSecret,
            }).filter(([, value]) => !value).map(([key]) => key);
        if (missing.length > 0) {
            throw new Error(`Missing required Treeseed operations runner environment: ${missing.join(', ')}`);
        }
    }
    await mkdir(config.dataDir, { recursive: true });
    const probe = resolve(config.dataDir, '.treeseed-runner-write-check');
    await writeFile(probe, 'ok\n', 'utf8');
    await rm(probe, { force: true });
    return config;
}

export function loadHealthConfig() {
    return {
        port: Number(env('PORT', '0')),
        dataDir: env('TREESEED_PLATFORM_RUNNER_DATA_DIR', resolve(process.cwd(), '.treeseed/operations-runner')),
    };
}
