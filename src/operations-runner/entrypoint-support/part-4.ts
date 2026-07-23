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
import { readArg, hasArg, readNumberArg, parseOperationKey, parseRunnerOptions, env, isLoopbackUrl, packageVersion, loadConfig, loadHealthConfig, createClient, createDeploymentStore, treeDxSlug, treeDxRailwayEnvironment, treeDxEnvironmentNeutralProjectName, treeDxRailwayNames, treeDxSecretBase, treeDxRailway, createExecutors, createExecutorsForOptions, registerAndHeartbeat, runOnceWithClient, objectValue, SENSITIVE_OUTPUT_KEY_PATTERN, SENSITIVE_OUTPUT_VALUE_PATTERN, redactProjectHostOperationValue, runnerRuntimeFromOptions, addCredentialOverlayAliases, consumeProjectHostCredentialOverlay, projectHostMetadataPatchFromResult, mergeHostBindingOperationMetadata, persistProjectHostOperationResult, consumeLaunchCredentialSession, credentialSessionSecretForRunner, decryptCredentialSessionPayloadForRunner, prepareLaunchIntentForMarketRunner, runManagedLaunchJobs, runOnce } from './index.js';

export function startHealthServer(config, state: any = {}) {
    if (!config.port)
        return null;
    const server = createServer((request, response) => {
        if (request.url === '/healthz') {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ ok: true, service: 'operations-runner', state: state.status ?? 'booting' }));
            return;
        }
        if (request.url === '/readyz') {
            const ready = state.ready === true;
            response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
            response.end(JSON.stringify({
                ok: ready,
                service: 'operations-runner',
                state: state.status ?? 'booting',
                error: state.error ?? null,
            }));
            return;
        }
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error: 'Not found.' }));
    });
    server.listen(config.port);
    return server;
}

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

export async function main() {
    const command = process.argv[2] ?? 'help';
    const runnerOptions = parseRunnerOptions();
    if (runnerOptions.once) {
        await runOnce(runnerOptions);
        return;
    }
    if (runnerOptions.watch) {
        await runLoop();
        return;
    }
    if (command === 'version') {
        console.log(JSON.stringify({
            ok: true,
            name: 'operations-runner',
            version: await packageVersion(),
        }));
        return;
    }
    if (command === 'healthcheck') {
        const config = await loadConfig({ requireSecrets: false });
        console.log(JSON.stringify({
            ok: true,
            service: 'operations-runner',
            dataDir: config.dataDir,
        }));
        return;
    }
    if (command === 'once') {
        await runOnce(runnerOptions);
        return;
    }
    if (command === 'run') {
        await runLoop();
        return;
    }
    console.error('Usage: operations-runner <version|healthcheck|once|run>');
    process.exitCode = 2;
}
