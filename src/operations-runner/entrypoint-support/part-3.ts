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
import { readArg, hasArg, readNumberArg, parseOperationKey, parseRunnerOptions, env, isLoopbackUrl, packageVersion, loadConfig, loadHealthConfig, createClient, createDeploymentStore, treeDxSlug, treeDxRailwayEnvironment, treeDxEnvironmentNeutralProjectName, treeDxRailwayNames, treeDxSecretBase, treeDxRailway, createExecutors, createExecutorsForOptions, registerAndHeartbeat, startHealthServer, runLoop, main } from './index.js';

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

export function objectValue(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export const SENSITIVE_OUTPUT_KEY_PATTERN = /(?:^|[_-])(?:token|password|passphrase|api[_-]?key|private[_-]?key|credential|secret)(?:$|[_-])|(?:token|password|passphrase|apiKey|privateKey|credential)$/iu;

export const SENSITIVE_OUTPUT_VALUE_PATTERN = /(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|[A-Za-z0-9+/=]{48,})/gu;

export function redactProjectHostOperationValue(value, key = '') {
    if (SENSITIVE_OUTPUT_KEY_PATTERN.test(key))
        return '[redacted]';
    if (typeof value === 'string')
        return value.replace(SENSITIVE_OUTPUT_VALUE_PATTERN, '[redacted]');
    if (Array.isArray(value))
        return value.map((entry) => redactProjectHostOperationValue(entry));
    if (!value || typeof value !== 'object')
        return value;
    const output = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
        output[entryKey] = redactProjectHostOperationValue(entryValue, entryKey);
    }
    return output;
}

export function runnerRuntimeFromOptions(options: any = {}) {
    const config = objectValue(options.config);
    return {
        resolved: {
            config: {
                baseUrl: config.marketUrl ?? null,
                marketUrl: config.marketUrl ?? null,
                apiDatabaseUrl: config.apiDatabaseUrl ?? null,
                environment: config.environment ?? process.env.TREESEED_PLATFORM_RUNNER_ENVIRONMENT ?? null,
                credentialSessionSecret: config.credentialSessionSecret ?? null,
            },
        },
    };
}

export function addCredentialOverlayAliases(overlay, session) {
    const config = objectValue(session?.config);
    for (const [key, value] of Object.entries(config)) {
        if (typeof value === 'string' && value.trim())
            overlay[key] = value;
    }
    const token = config.GH_TOKEN ?? config.GITHUB_TOKEN ?? config.githubToken ?? config.token;
    if (session?.hostKind === 'repository_host' && typeof token === 'string' && token.trim()) {
        overlay.GH_TOKEN = token;
        overlay.GITHUB_TOKEN = config.GITHUB_TOKEN ?? token;
        overlay.token = token;
    }
    const cloudflareToken = config.CLOUDFLARE_API_TOKEN ?? config.cloudflareApiToken ?? config.apiToken ?? config.token;
    if (session?.hostKind === 'web_host' && session?.provider === 'cloudflare' && typeof cloudflareToken === 'string' && cloudflareToken.trim()) {
        overlay.CLOUDFLARE_API_TOKEN = cloudflareToken;
        overlay.cloudflareApiToken = cloudflareToken;
        overlay.apiToken = cloudflareToken;
        overlay.token = cloudflareToken;
    }
    const accountId = config.CLOUDFLARE_ACCOUNT_ID ?? config.cloudflareAccountId ?? config.accountId;
    if (session?.hostKind === 'web_host' && session?.provider === 'cloudflare' && typeof accountId === 'string' && accountId.trim()) {
        overlay.CLOUDFLARE_ACCOUNT_ID = accountId;
        overlay.cloudflareAccountId = accountId;
        overlay.accountId = accountId;
    }
    if (session?.hostKind === 'email_host') {
        for (const [source, target] of [
            ['SMTP_HOST', 'smtpHost'],
            ['SMTP_PORT', 'smtpPort'],
            ['SMTP_USERNAME', 'smtpUsername'],
            ['SMTP_PASSWORD', 'smtpPassword'],
        ]) {
            const value = config[source] ?? config[target];
            if (typeof value === 'string' && value.trim()) {
                overlay[source] = value;
                overlay[target] = value;
            }
        }
    }
}

export async function consumeProjectHostCredentialOverlay(store, runtime, operationId, credentialSessions) {
    const overlay: Record<string, string> = {};
    const sessions = objectValue(credentialSessions);
    for (const sessionInfo of Object.values(sessions)) {
        const sessionId = typeof sessionInfo === 'string'
            ? sessionInfo
            : typeof (sessionInfo as Record<string, unknown> | null)?.id === 'string'
                ? (sessionInfo as { id: string }).id
                : '';
        if (!sessionId.trim())
            continue;
        const session = await consumeLaunchCredentialSession(store, runtime, operationId, sessionId.trim());
        addCredentialOverlayAliases(overlay, session);
    }
    return overlay;
}

export function projectHostMetadataPatchFromResult(input, result, operation) {
    const timestamp = new Date().toISOString();
    const operationSummary = {
        id: operation.id,
        kind: result.kind,
        requirementKey: result.requirementKey ?? input?.requirementKey ?? null,
        status: 'succeeded',
        queuedAt: operation.createdAt ?? null,
        completedAt: timestamp,
        commitSha: result.repository?.commitSha ?? null,
        changedPaths: result.repository?.changedPaths ?? [],
        auditStatus: result.repository?.audit?.status ?? null,
        secretSyncStatus: result.secretSync ? (result.secretSync.ok ? 'completed' : 'failed') : 'skipped',
    };
    return {
        hostBindings: result.hostBindings,
        hostBindingPlans: result.hostBindingPlans,
        hostBindingAudit: {
            checkedAt: timestamp,
            summary: input?.audit?.summary ?? null,
            diagnostics: input?.audit?.diagnostics ?? [],
            repository: result.repository?.audit ?? null,
            config: result.repository?.config ?? null,
        },
        hostBindingSecretSync: result.secretSync ?? null,
        lastHostOperation: operationSummary,
        hostBindingOperationResult: {
            kind: result.kind,
            requirementKey: result.requirementKey ?? input?.requirementKey ?? null,
            repository: result.repository,
            secretSync: result.secretSync,
            summary: result.summary,
        },
        hostBindingOperations: [operationSummary],
    };
}

export function mergeHostBindingOperationMetadata(existing, patch) {
    const previous = objectValue(existing);
    const operations = [
        ...(Array.isArray(patch.hostBindingOperations) ? patch.hostBindingOperations : []),
        ...(Array.isArray(previous.hostBindingOperations) ? previous.hostBindingOperations : []),
    ].slice(0, 10);
    return {
        ...previous,
        ...patch,
        hostBindingOperations: operations,
    };
}

export async function persistProjectHostOperationResult(store, input, result, operation) {
    const projectId = typeof input?.projectId === 'string' ? input.projectId : null;
    if (!projectId)
        return;
    const details = await store.getProjectDetails(projectId).catch(() => null);
    if (!details?.project)
        return;
    const patch = redactProjectHostOperationValue(projectHostMetadataPatchFromResult(input, result, operation));
    await store.updateProject(projectId, {
        metadata: mergeHostBindingOperationMetadata(details.project.metadata, patch),
    });
    const refreshedHosting = details.hosting ?? await store.getProjectHosting(projectId).catch(() => null);
    if (refreshedHosting) {
        await store.run(`UPDATE project_hosting SET metadata_json = ?, updated_at = ? WHERE project_id = ?`, [
            JSON.stringify(mergeHostBindingOperationMetadata(refreshedHosting.metadata, patch)),
            new Date().toISOString(),
            projectId,
        ]).catch(() => null);
    }
    const refreshedConnection = details.connection ?? await store.getProjectConnection(projectId).catch(() => null);
    if (refreshedConnection) {
        await store.run(`UPDATE project_connections SET metadata_json = ?, updated_at = ? WHERE project_id = ?`, [
            JSON.stringify(mergeHostBindingOperationMetadata(refreshedConnection.metadata, patch)),
            new Date().toISOString(),
            projectId,
        ]).catch(() => null);
    }
    const deployments = await store.listProjectDeployments(projectId, { limit: 10 }).catch(() => []);
    for (const deployment of deployments) {
        await store.updateProjectDeployment(deployment.id, {
            metadata: mergeHostBindingOperationMetadata(deployment.metadata, patch),
        }).catch(() => null);
    }
}

export async function consumeLaunchCredentialSession(store, runtime, jobId, sessionId) {
    const consumed = await store.consumeProviderCredentialSession(jobId, sessionId);
    if (!consumed.ok) {
        throw new Error(`Unable to consume provider credential session: ${consumed.error}`);
    }
    const session = consumed.payload;
    const payload = decryptCredentialSessionPayloadForRunner(runtime, session.encryptedPayload);
    return {
        id: session.id,
        hostKind: session.hostKind,
        hostId: session.hostId,
        purpose: session.purpose,
        provider: payload.provider ?? null,
        config: payload.config && typeof payload.config === 'object' ? payload.config : {},
    };
}

export function credentialSessionSecretForRunner(runtime) {
    const configured = process.env.TREESEED_CREDENTIAL_SESSION_SECRET
        ?? runtime?.resolved?.config?.credentialSessionSecret
        ?? null;
    if (configured && String(configured).trim())
        return String(configured);
    const runtimeConfig = runtime?.resolved?.config ?? {};
    const environment = String(runtimeConfig.environment ?? process.env.TREESEED_API_ENVIRONMENT ?? process.env.TREESEED_ENVIRONMENT ?? '').trim().toLowerCase();
    const localDatabase = isLoopbackUrl(runtimeConfig.apiDatabaseUrl ?? process.env.TREESEED_DATABASE_URL ?? '');
    const localBaseUrl = isLoopbackUrl(runtimeConfig.baseUrl ?? runtimeConfig.marketUrl ?? process.env.TREESEED_API_BASE_URL ?? process.env.TREESEED_SITE_URL ?? process.env.TREESEED_BETTER_AUTH_URL ?? '');
    if (process.env.NODE_ENV === 'test'
        || process.env.TREESEED_LOCAL_DEV_MODE
        || environment === 'local'
        || localDatabase
        || localBaseUrl) {
        return 'treeseed-local-test-credential-session-secret';
    }
    throw new Error('TREESEED_CREDENTIAL_SESSION_SECRET is required for provider credential sessions.');
}

export function decryptCredentialSessionPayloadForRunner(runtime, envelope) {
    if (!envelope || typeof envelope !== 'object') {
        throw new Error('Credential session payload is missing.');
    }
    const key = createHash('sha256').update(credentialSessionSecretForRunner(runtime)).digest();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(String(envelope.iv ?? ''), 'base64url'));
    decipher.setAuthTag(Buffer.from(String(envelope.tag ?? ''), 'base64url'));
    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(String(envelope.ciphertext ?? ''), 'base64url')),
        decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf8'));
}

export async function prepareLaunchIntentForMarketRunner(store, runtime, job) {
    const launchJobInput = objectValue(job.input);
    const launchIntent = objectValue(launchJobInput.launchIntent);
    const nextIntent = JSON.parse(JSON.stringify(launchIntent));
    const execution = objectValue(nextIntent.execution);
    const providerLaunchInput = objectValue(execution.providerLaunchInput);
    const sessions = objectValue(launchJobInput.credentialSessions);
    if (Object.keys(sessions).length > 0) {
        throw new Error('launch_project jobs must not contain provider credential sessions. Project launch credentials are bootstrapped by the API only.');
    }
    const envOverlay: Record<string, unknown> = {};
    const consume = async (key) => {
        const sessionId = typeof sessions[key] === 'string' ? sessions[key].trim() : '';
        if (!sessionId)
            return null;
        return consumeLaunchCredentialSession(store, runtime, job.id, sessionId);
    };
    const repositorySession = await consume('repositoryHost');
    if (repositorySession?.config) {
        const token = repositorySession.config.GH_TOKEN ?? repositorySession.config.GITHUB_TOKEN;
        if (token) {
            envOverlay.GH_TOKEN = token;
            envOverlay.GITHUB_TOKEN = repositorySession.config.GITHUB_TOKEN ?? token;
        }
        const owner = repositorySession.config.organizationOrOwner ?? repositorySession.config.owner;
        if (owner) {
            envOverlay.TREESEED_GITHUB_IDENTITY_MODE = 'account';
            envOverlay.TREESEED_HOSTED_HUBS_GITHUB_OWNER = owner;
            nextIntent.repository = {
                ...objectValue(nextIntent.repository),
                owner,
            };
            providerLaunchInput.repoOwner = owner;
        }
    }
    const webSession = await consume('webHost');
    if (webSession?.config) {
        const webConfig = objectValue(webSession.config);
        for (const [key, value] of Object.entries(webConfig)) {
            if (typeof value === 'string' && value.trim())
                envOverlay[key] = value;
        }
        providerLaunchInput.cloudflareHost = {
            ...objectValue(providerLaunchInput.cloudflareHost),
            config: webConfig,
        };
    }
    const emailSession = await consume('emailHost');
    if (emailSession?.config) {
        const emailConfig = objectValue(emailSession.config);
        for (const [key, value] of Object.entries(emailConfig)) {
            if (typeof value === 'string' && value.trim())
                envOverlay[key] = value;
        }
        providerLaunchInput.emailHost = {
            ...objectValue(providerLaunchInput.emailHost),
            config: emailConfig,
        };
    }
    nextIntent.execution = {
        ...execution,
        providerLaunchInput,
    };
    return { intent: nextIntent, envOverlay, resume: launchJobInput.resume === true };
}

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
            const result = await new TreeseedOperationsSdk().execute({
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
