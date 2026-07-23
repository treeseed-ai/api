import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlatformRunnerClient, TreeseedOperationsSdk, deployRailwayServiceInstance, ensureRailwayEnvironment, ensureRailwayGeneratedServiceDomain, ensureRailwayProject, ensureRailwayService, ensureRailwayServiceInstanceConfiguration, ensureRailwayServiceVolume, executeProjectHostBindingOperation, executePlatformRepositoryOperation, listRailwayVariables, normalizeRailwayEnvironmentName, runPlatformOperationOnce, upsertRailwayVariables, } from '@treeseed/sdk';
import { resolveApiDatabaseUrl } from '@treeseed/sdk/api';
import { createPlatformOperationStoreFromEnv, } from '@treeseed/sdk/platform-operation-store';
import { createMarketPostgresDatabase } from '../../api/market-postgres.js';
import { MarketControlPlaneStore } from '../../api/store.js';
import { CapacityWorkdayMaintenanceScheduler } from '../../api/capacity/services/workday-maintenance-service.js';
import { createCapacityControlPlane } from '../../api/capacity/control-plane.js';
import { applyHubLaunchFailure, applyHubLaunchResult } from '../../api/hub-launch-application.js';
import { createProjectWebDeploymentExecutor } from '../project-web-deployment-executor.js';
import { drainNotificationEmailOutbox } from '../../notifications/service.js';
import { createExecutorsForOptions, registerAndHeartbeat, runOnceWithClient, objectValue, SENSITIVE_OUTPUT_KEY_PATTERN, SENSITIVE_OUTPUT_VALUE_PATTERN, redactProjectHostOperationValue, runnerRuntimeFromOptions, addCredentialOverlayAliases, consumeProjectHostCredentialOverlay, projectHostMetadataPatchFromResult, mergeHostBindingOperationMetadata, persistProjectHostOperationResult, consumeLaunchCredentialSession, credentialSessionSecretForRunner, decryptCredentialSessionPayloadForRunner, prepareLaunchIntentForMarketRunner, runManagedLaunchJobs, runOnce, startHealthServer, runLoop, main } from './index.js';

export function readArg(name, fallback = null) {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

export function hasArg(name) {
    return process.argv.includes(name);
}

export function readNumberArg(name, fallback) {
    const value = readArg(name);
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseOperationKey(value) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized)
        return null;
    const [namespace, operation] = normalized.split(':');
    if (!namespace || !operation) {
        throw new Error(`Invalid --operation value "${normalized}". Expected namespace:operation.`);
    }
    return `${namespace}:${operation}`;
}

export function parseRunnerOptions() {
    return {
        once: hasArg('--once'),
        watch: hasArg('--watch'),
        operationId: readArg('--operation-id'),
        operationKey: parseOperationKey(readArg('--operation')),
        pollIntervalMs: readNumberArg('--poll-interval-ms', 5000),
        maxJobs: readNumberArg('--max-jobs', 1),
        planOnly: hasArg('--plan'),
    };
}

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

export function createClient(config) {
    if (config.apiDatabaseUrl) {
        return createPlatformOperationStoreFromEnv({
            databaseUrl: config.apiDatabaseUrl,
            initializeSchema: true,
        });
    }
    return new PlatformRunnerClient({
        marketUrl: config.marketUrl,
        marketId: config.marketId,
        runnerSecret: config.runnerSecret,
        userAgent: `treeseed-api-operations-runner/${process.version}`,
    });
}

export function createDeploymentStore(config) {
    if (!config.apiDatabaseUrl)
        return null;
    const db = createMarketPostgresDatabase(config.apiDatabaseUrl);
    return createCapacityControlPlane(new MarketControlPlaneStore(config, db));
}

export function treeDxSlug(value, fallback = 'treedx') {
    const slug = String(value ?? '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/gu, '')
        .replace(/[^a-z0-9-]+/giu, '-')
        .toLowerCase()
        .replace(/-+/gu, '-')
        .replace(/^-|-$/gu, '')
        .slice(0, 56);
    return slug || fallback;
}

export function treeDxRailwayEnvironment(value) {
    return normalizeRailwayEnvironmentName(value || process.env.TREESEED_PLATFORM_RUNNER_ENVIRONMENT || 'staging') || 'staging';
}

export function treeDxEnvironmentNeutralProjectName(value, fallback) {
    const projectName = String(value || fallback || '').trim();
    if (!projectName)
        return fallback;
    return projectName
        .replace(/^(treeseed-team-[a-z0-9-]+-treedx)-(?:staging|prod|production)$/iu, '$1');
}

export function treeDxRailwayNames({ team, teamId, publicRead, environment }) {
    const envName = treeDxRailwayEnvironment(environment);
    if (publicRead) {
        return {
            projectName: treeDxEnvironmentNeutralProjectName(process.env.TREESEED_PUBLIC_TREEDX_RAILWAY_PROJECT_NAME, 'treeseed-api'),
            serviceName: process.env.TREESEED_PUBLIC_TREEDX_RAILWAY_SERVICE_NAME || 'public-treedx-node-01',
            volumeName: process.env.TREESEED_PUBLIC_TREEDX_RAILWAY_VOLUME_NAME || 'public-treedx-node-01-volume',
            environmentName: envName,
            scope: 'public_federation',
        };
    }
    const teamSlug = treeDxSlug(team?.slug ?? team?.name ?? teamId, 'team');
    return {
        projectName: treeDxEnvironmentNeutralProjectName(null, `treeseed-team-${teamSlug}-treedx`),
        serviceName: 'treedx',
        volumeName: 'treedx-data',
        environmentName: envName,
        scope: 'private_team',
    };
}

export function treeDxSecretBase() {
    return randomBytes(48).toString('base64url');
}

export function treeDxRailway(options: any = {}) {
    return {
        ensureProject: options.ensureProject ?? ensureRailwayProject,
        ensureEnvironment: options.ensureEnvironment ?? ensureRailwayEnvironment,
        ensureService: options.ensureService ?? ensureRailwayService,
        ensureServiceInstanceConfiguration: options.ensureServiceInstanceConfiguration ?? ensureRailwayServiceInstanceConfiguration,
        ensureServiceVolume: options.ensureServiceVolume ?? ensureRailwayServiceVolume,
        ensureGeneratedServiceDomain: options.ensureGeneratedServiceDomain ?? ensureRailwayGeneratedServiceDomain,
        listVariables: options.listVariables ?? listRailwayVariables,
        upsertVariables: options.upsertVariables ?? upsertRailwayVariables,
        deployServiceInstance: options.deployServiceInstance ?? deployRailwayServiceInstance,
    };
}

export function createExecutors() {
    return createExecutorsForOptions({});
}
