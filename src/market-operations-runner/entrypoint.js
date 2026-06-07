#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	PlatformRunnerClient,
	TreeseedOperationsSdk,
	deployRailwayServiceInstance,
	ensureRailwayEnvironment,
	ensureRailwayGeneratedServiceDomain,
	ensureRailwayProject,
	ensureRailwayService,
	ensureRailwayServiceInstanceConfiguration,
	ensureRailwayServiceVolume,
	executeProjectHostBindingOperation,
	executePlatformRepositoryOperation,
	listRailwayVariables,
	normalizeRailwayEnvironmentName,
	runPlatformOperationOnce,
	upsertRailwayVariables,
} from '@treeseed/sdk';
import {
	createPlatformOperationStoreFromEnv,
} from '@treeseed/sdk/platform-operation-store';
import { createMarketPostgresDatabase } from '../api/market-postgres.js';
import { MarketControlPlaneStore } from '../api/store.js';
import { applyHubLaunchFailure, applyHubLaunchResult } from '../api/hub-launch-application.js';
import { createProjectWebDeploymentExecutor } from './project-web-deployment-executor.js';

function readArg(name, fallback = null) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function hasArg(name) {
	return process.argv.includes(name);
}

function readNumberArg(name, fallback) {
	const value = readArg(name);
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOperationKey(value) {
	const normalized = typeof value === 'string' ? value.trim() : '';
	if (!normalized) return null;
	const [namespace, operation] = normalized.split(':');
	if (!namespace || !operation) {
		throw new Error(`Invalid --operation value "${normalized}". Expected namespace:operation.`);
	}
	return `${namespace}:${operation}`;
}

function parseRunnerOptions() {
	return {
		once: hasArg('--once'),
		watch: hasArg('--watch'),
		operationId: readArg('--operation-id'),
		operationKey: parseOperationKey(readArg('--operation')),
		pollIntervalMs: readNumberArg('--poll-interval-ms', 5000),
		maxJobs: readNumberArg('--max-jobs', 1),
		dryRun: hasArg('--dry-run'),
		mockExternal: hasArg('--mock-external'),
		mockResult: readArg('--mock-result', 'success') === 'failure' ? 'failure' : 'success',
	};
}

function env(name, fallback = null) {
	const value = process.env[name];
	return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function isLoopbackUrl(value) {
	if (typeof value !== 'string' || !value.trim()) return false;
	try {
		const parsed = new URL(value);
		return ['127.0.0.1', 'localhost', '0.0.0.0'].includes(parsed.hostname);
	} catch {
		return /(?:^|@|\/\/)(?:127\.0\.0\.1|localhost)(?::|\/|$)/u.test(value);
	}
}

async function packageVersion() {
	try {
		const raw = await readFile(resolve(process.cwd(), 'package.json'), 'utf8');
		return JSON.parse(raw).version ?? '0.0.0';
	} catch {
		return '0.0.0';
	}
}

async function loadConfig({ requireSecrets = true } = {}) {
	const marketId = readArg('--market') ?? env('TREESEED_MARKET_ID', 'local');
	const config = {
		marketUrl: env('TREESEED_MARKET_API_BASE_URL') ?? env('TREESEED_MARKET_URL'),
		marketDatabaseUrl: env('TREESEED_MARKET_DATABASE_URL'),
		marketId,
		runnerId: env('TREESEED_PLATFORM_RUNNER_ID', marketId === 'prod' ? 'market-ops-prod-1' : marketId === 'staging' ? 'market-ops-staging-1' : 'market-ops-local-1'),
		runnerSecret: env('TREESEED_PLATFORM_RUNNER_SECRET'),
		dataDir: env('TREESEED_PLATFORM_RUNNER_DATA_DIR', resolve(process.cwd(), '.treeseed/market-operations-runner')),
		environment: env('TREESEED_PLATFORM_RUNNER_ENVIRONMENT', marketId === 'prod' ? 'production' : marketId),
		port: Number(env('PORT', '0')),
	};
	if (requireSecrets) {
		const missing = Object.entries({
			TREESEED_MARKET_DATABASE_URL: config.marketDatabaseUrl,
		}).filter(([, value]) => !value).map(([key]) => key);
		if (missing.length > 0) {
			throw new Error(`Missing required market operations runner environment: ${missing.join(', ')}`);
		}
	}
	await mkdir(config.dataDir, { recursive: true });
	const probe = resolve(config.dataDir, '.treeseed-runner-write-check');
	await writeFile(probe, 'ok\n', 'utf8');
	await rm(probe, { force: true });
	return config;
}

function loadHealthConfig() {
	return {
		port: Number(env('PORT', '0')),
		dataDir: env('TREESEED_PLATFORM_RUNNER_DATA_DIR', resolve(process.cwd(), '.treeseed/market-operations-runner')),
	};
}

function createClient(config) {
	if (config.marketDatabaseUrl) {
		return createPlatformOperationStoreFromEnv({
			databaseUrl: config.marketDatabaseUrl,
			initializeSchema: true,
		});
	}
	return new PlatformRunnerClient({
		marketUrl: config.marketUrl,
		marketId: config.marketId,
		runnerSecret: config.runnerSecret,
		userAgent: `treeseed-market-operations-runner/${process.version}`,
	});
}

function createDeploymentStore(config) {
	if (!config.marketDatabaseUrl) return null;
	const db = createMarketPostgresDatabase(config.marketDatabaseUrl);
	return new MarketControlPlaneStore(config, db);
}

function treeDxSlug(value, fallback = 'treedx') {
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

function treeDxRailwayEnvironment(value) {
	return normalizeRailwayEnvironmentName(value || process.env.TREESEED_PLATFORM_RUNNER_ENVIRONMENT || 'staging') || 'staging';
}

function treeDxEnvironmentNeutralProjectName(value, fallback) {
	const projectName = String(value || fallback || '').trim();
	if (!projectName) return fallback;
	return projectName
		.replace(/^(treeseed-public-treedx)-(?:staging|prod|production)$/iu, '$1')
		.replace(/^(treeseed-team-[a-z0-9-]+-treedx)-(?:staging|prod|production)$/iu, '$1');
}

function treeDxRailwayNames({ team, teamId, publicRead, environment }) {
	const envName = treeDxRailwayEnvironment(environment);
	if (publicRead) {
		return {
			projectName: treeDxEnvironmentNeutralProjectName(
				process.env.TREESEED_PUBLIC_TREEDX_RAILWAY_PROJECT_NAME,
				'treeseed-public-treedx',
			),
			serviceName: process.env.TREESEED_PUBLIC_TREEDX_RAILWAY_SERVICE_NAME || 'public-federation',
			volumeName: process.env.TREESEED_PUBLIC_TREEDX_RAILWAY_VOLUME_NAME || 'public-treedx-data',
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

function treeDxSecretBase() {
	return randomBytes(48).toString('base64url');
}

function treeDxRailway(options = {}) {
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

export function createExecutorsForOptions(options = {}) {
	const noop = {
		namespace: 'market',
		operation: 'noop',
		async run(_input, context) {
			await context.checkpoint({ phase: 'diagnostic' }, { kind: 'market.noop', data: { runnerId: process.env.TREESEED_PLATFORM_RUNNER_ID ?? null } });
			return {
				ok: true,
				message: 'Market operations runner diagnostic completed.',
			};
		},
	};
	const diagnostic = {
		...noop,
		operation: 'diagnostic',
	};
	const repositoryExecutor = (operation) => ({
		namespace: 'repository',
		operation,
		async run(input, context) {
			await context.checkpoint({
				phase: 'repository.sync',
				operation,
				projectId: input?.projectId ?? null,
			}, {
				kind: 'repository.sync_started',
				data: { operation, projectId: input?.projectId ?? null },
			});
			const result = await executePlatformRepositoryOperation(operation, input, {
				workspaceRoot: context.workspaceRoot,
				environment: context.environment,
			}).catch(async (error) => {
				if (error?.verification) {
					await context.emit({
						kind: 'repository.verification_failed',
						data: {
							status: error.verification.status,
							commands: error.verification.commands?.map((command) => ({
								command: command.command,
								args: command.args,
								cwd: command.cwd,
								exitCode: command.exitCode,
							})) ?? [],
						},
					});
				}
				throw error;
			});
			await context.checkpoint({
				phase: 'repository.written',
				changedPaths: result.changedPaths,
				branch: result.branch,
				commitSha: result.commitSha,
				verification: result.verification,
			}, {
				kind: 'repository.written',
				data: {
					changedPaths: result.changedPaths,
					branch: result.branch,
					commitSha: result.commitSha,
					verificationStatus: result.verification?.status ?? 'skipped',
				},
			});
			if (result.commitSha) {
				await context.checkpoint({
					phase: 'repository.committed',
					branch: result.branch,
					commitSha: result.commitSha,
				}, {
					kind: 'repository.committed',
					data: { branch: result.branch, commitSha: result.commitSha },
				});
			}
			if (input?.repository?.push === true) {
				await context.checkpoint({
					phase: 'repository.push_ready',
					branch: result.branch,
				}, {
					kind: 'repository.push_ready',
					data: { branch: result.branch },
				});
			}
			return result;
		},
	});
	const projectHostExecutor = (kind) => ({
		namespace: 'project_hosts',
		operation: `host_binding_${kind}`,
		async run(input, context) {
			if (!options.deploymentStore) {
				throw new Error('Project host operations require a Market control-plane store.');
			}
			await context.checkpoint({
				phase: 'project_hosts.started',
				kind,
				projectId: input?.projectId ?? null,
				requirementKey: input?.requirementKey ?? null,
			}, {
				kind: 'project_hosts.started',
				data: { kind, projectId: input?.projectId ?? null, requirementKey: input?.requirementKey ?? null },
			});
			const runtime = runnerRuntimeFromOptions(options);
			const valuesOverlay = await consumeProjectHostCredentialOverlay(options.deploymentStore, runtime, context.operation.id, input?.credentialSessions);
			const result = await executeProjectHostBindingOperation({
				...objectValue(input),
				kind,
			}, {
				workspaceRoot: context.workspaceRoot,
				environment: context.environment,
				valuesOverlay,
				onProgress: async (event) => {
					await context.emit({
						kind: 'project_hosts.secret_sync_progress',
						data: event,
					});
				},
			});
			await context.checkpoint({
				phase: 'project_hosts.repository_complete',
				kind,
				projectId: input?.projectId ?? null,
				requirementKey: input?.requirementKey ?? null,
				repository: result.repository,
			}, {
				kind: 'project_hosts.repository_complete',
				data: {
					kind,
					projectId: input?.projectId ?? null,
					requirementKey: input?.requirementKey ?? null,
					changedPaths: result.repository.changedPaths,
					commitSha: result.repository.commitSha,
				},
			});
			if (result.summary.requiresSecretSync) {
				await context.checkpoint({
					phase: 'project_hosts.secret_sync_complete',
					kind,
					projectId: input?.projectId ?? null,
					requirementKey: input?.requirementKey ?? null,
					secretSync: result.secretSync,
				}, {
					kind: 'project_hosts.secret_sync_complete',
					data: {
						kind,
						projectId: input?.projectId ?? null,
						requirementKey: input?.requirementKey ?? null,
						ok: result.secretSync?.ok ?? false,
						providers: result.secretSync?.providers ?? [],
					},
				});
			}
			await persistProjectHostOperationResult(options.deploymentStore, input, result, context.operation);
			if (!result.ok) {
				throw new Error('Project host operation failed during host-bound secret sync.');
			}
			return redactProjectHostOperationValue(result);
		},
	});
	const treeDxProvisionExecutor = {
		namespace: 'treedx',
		operation: 'provision',
		async run(input, context) {
			if (!options.deploymentStore) {
				throw new Error('TreeDX provisioning requires a Market control-plane store.');
			}
			const payload = objectValue(input);
			const teamId = typeof payload.teamId === 'string' ? payload.teamId : null;
			const instanceId = typeof payload.instanceId === 'string' ? payload.instanceId : null;
			const deploymentId = typeof payload.deploymentId === 'string' ? payload.deploymentId : null;
			if (!teamId || !instanceId || !deploymentId) {
				throw new Error('TreeDX provisioning input must include teamId, instanceId, and deploymentId.');
			}
			const imageRef = typeof payload.imageRef === 'string' && payload.imageRef.trim() ? payload.imageRef.trim() : 'treeseed/treedx:latest';
			const volumeMountPath = typeof payload.volumeMountPath === 'string' && payload.volumeMountPath.trim() ? payload.volumeMountPath.trim() : '/data';
			const publicRead = payload.publicRead === true;
			const team = await options.deploymentStore.getTeam?.(teamId);
			const names = treeDxRailwayNames({
				team,
				teamId,
				publicRead,
				environment: options.config?.environment ?? context.operation?.environment ?? process.env.TREESEED_PLATFORM_RUNNER_ENVIRONMENT,
			});
			const railway = treeDxRailway(options.railway);
			await context.checkpoint({
				phase: 'treedx.provision.started',
				teamId,
				instanceId,
				deploymentId,
				imageRef,
				volumeMountPath,
				publicRead,
				projectName: names.projectName,
				serviceName: names.serviceName,
			}, {
				kind: 'treedx.provision.started',
				data: { teamId, instanceId, deploymentId, imageRef, volumeMountPath, publicRead, projectName: names.projectName, serviceName: names.serviceName },
			});
			await options.deploymentStore.updateTreeDxDeployment(deploymentId, {
				status: 'running',
				imageRef,
				volumeMountPath,
				result: {
					operationId: context.operation.id,
					phase: payload.dryRun === true ? 'railway_service_planned' : 'railway_service_provisioning',
					scope: names.scope,
				},
			});
			let railwayRefs = {};
			let baseUrl = typeof payload.baseUrl === 'string' && payload.baseUrl.trim() ? payload.baseUrl.trim() : null;
			let externalDeploymentId = null;
			if (payload.dryRun !== true) {
				const ensuredProject = await railway.ensureProject({
					projectName: names.projectName,
					defaultEnvironmentName: names.environmentName,
				});
				const ensuredEnvironment = await railway.ensureEnvironment({
					projectId: ensuredProject.project.id,
					environmentName: names.environmentName,
				});
				const ensuredService = await railway.ensureService({
					projectId: ensuredProject.project.id,
					environmentId: ensuredEnvironment.environment.id,
					serviceName: names.serviceName,
					imageRef,
				});
				const currentVariables = await railway.listVariables({
					projectId: ensuredProject.project.id,
					environmentId: ensuredEnvironment.environment.id,
					serviceId: ensuredService.service.id,
				}).catch(() => ({}));
				const variables = {
					TREEDX_DATA_DIR: volumeMountPath,
					PORT: '4000',
					PHX_SERVER: 'true',
					PHX_HOST: `${names.serviceName}.railway.app`,
					TREESEED_TREEDX_SCOPE: names.scope,
				};
				if (!currentVariables.SECRET_KEY_BASE) {
					variables.SECRET_KEY_BASE = treeDxSecretBase();
				}
				await railway.upsertVariables({
					projectId: ensuredProject.project.id,
					environmentId: ensuredEnvironment.environment.id,
					serviceId: ensuredService.service.id,
					variables,
				});
				await railway.ensureServiceInstanceConfiguration({
					serviceId: ensuredService.service.id,
					environmentId: ensuredEnvironment.environment.id,
					healthcheckPath: '/api/v1/health',
					healthcheckTimeoutSeconds: 30,
					runtimeMode: 'replicated',
				});
				const ensuredVolume = await railway.ensureServiceVolume({
					projectId: ensuredProject.project.id,
					environmentId: ensuredEnvironment.environment.id,
					serviceId: ensuredService.service.id,
					name: names.volumeName,
					mountPath: volumeMountPath,
				});
				const ensuredDomain = await railway.ensureGeneratedServiceDomain({
					projectId: ensuredProject.project.id,
					environmentId: ensuredEnvironment.environment.id,
					serviceId: ensuredService.service.id,
					targetPort: 4000,
				}).catch(async (error) => {
					await context.emit({
						kind: 'treedx.provision.domain_skipped',
						data: {
							projectId: ensuredProject.project.id,
							environmentId: ensuredEnvironment.environment.id,
							serviceId: ensuredService.service.id,
							message: error instanceof Error ? error.message : String(error ?? 'unknown error'),
						},
					});
					return { domain: null, created: false };
				});
				if (ensuredDomain.domain?.domain) {
					baseUrl = `https://${ensuredDomain.domain.domain}`;
					await railway.upsertVariables({
						projectId: ensuredProject.project.id,
						environmentId: ensuredEnvironment.environment.id,
						serviceId: ensuredService.service.id,
						variables: { PHX_HOST: ensuredDomain.domain.domain },
					});
				}
				const deployment = await railway.deployServiceInstance({
					serviceId: ensuredService.service.id,
					environmentId: ensuredEnvironment.environment.id,
				});
				externalDeploymentId = deployment.deploymentId ?? null;
				railwayRefs = {
					workspaceId: ensuredProject.workspace?.id ?? null,
					projectId: ensuredProject.project.id,
					projectName: ensuredProject.project.name,
					environmentId: ensuredEnvironment.environment.id,
					environmentName: ensuredEnvironment.environment.name,
					serviceId: ensuredService.service.id,
					serviceName: ensuredService.service.name,
					volumeId: ensuredVolume.volume?.id ?? null,
					volumeName: ensuredVolume.volume?.name ?? names.volumeName,
					domainId: ensuredDomain.domain?.id ?? null,
					domain: ensuredDomain.domain?.domain ?? null,
					deploymentId: externalDeploymentId,
				};
			}
			baseUrl = baseUrl ?? `https://${names.serviceName}.railway.app`;
			const serviceRefs = {
				provider: 'railway',
				projectName: names.projectName,
				serviceName: names.serviceName,
				imageRef,
				volumeMountPath,
				railway: railwayRefs,
				env: {
					TREEDX_DATA_DIR: '/data',
					PORT: '4000',
					PHX_SERVER: 'true',
					SECRET_KEY_BASE: 'railway:SECRET_KEY_BASE',
				},
				dryRun: payload.dryRun === true,
			};
			await options.deploymentStore.upsertTeamTreeDx(teamId, {
				id: instanceId,
				kind: publicRead ? 'managed_public_federation' : 'managed_private',
				provider: 'railway',
				status: 'active',
				baseUrl,
				registryUrl: baseUrl,
				imageRef,
				volumeMountPath,
				railwayProjectId: railwayRefs.projectId ?? null,
				railwayServiceId: railwayRefs.serviceId ?? null,
				railwayEnvironmentId: railwayRefs.environmentId ?? null,
				publicRead,
				metadata: {
					lastProvisionOperationId: context.operation.id,
					projectName: names.projectName,
					serviceName: names.serviceName,
					dataDirEnv: '/data',
					deploymentScope: names.scope,
					railwaySecretRefs: {
						SECRET_KEY_BASE: 'service-variable',
					},
					dryRun: payload.dryRun === true,
				},
			});
			const deployment = await options.deploymentStore.updateTreeDxDeployment(deploymentId, {
				status: 'succeeded',
				imageRef,
				volumeMountPath,
				serviceRefs,
				result: {
					operationId: context.operation.id,
					baseUrl,
					mode: publicRead ? 'public_federation' : 'managed_private',
					provider: 'railway',
					scope: names.scope,
					health: payload.dryRun === true ? 'dry_run_planned' : 'deployment_started',
					externalDeploymentId,
				},
				clearError: true,
			});
			await context.checkpoint({
				phase: 'treedx.provision.completed',
				teamId,
				instanceId,
				deploymentId,
				baseUrl,
				projectName: names.projectName,
				serviceName: names.serviceName,
			}, {
				kind: 'treedx.provision.completed',
				data: { teamId, instanceId, deploymentId, baseUrl, projectName: names.projectName, serviceName: names.serviceName },
			});
			return {
				ok: true,
				teamId,
				instanceId,
				deploymentId,
				baseUrl,
				imageRef,
				volumeMountPath,
				deployment,
			};
		},
	};
	return [
		noop,
		diagnostic,
		repositoryExecutor('write_content_record'),
		repositoryExecutor('create_related_content'),
		repositoryExecutor('create_decision_from_proposals'),
		projectHostExecutor('audit'),
		projectHostExecutor('resync'),
		projectHostExecutor('replace'),
		projectHostExecutor('rotate'),
		treeDxProvisionExecutor,
		createProjectWebDeploymentExecutor({
			deploymentStore: options.deploymentStore,
			mockExternal: options.mockExternal,
			mockResult: options.mockResult,
			dryRun: options.dryRun,
			pollSeconds: Math.max(0, Math.round(Number(options.pollIntervalMs ?? 5000) / 1000)),
		}),
	].filter((executor) => !options.operationKey || `${executor.namespace}:${executor.operation}` === options.operationKey);
}

export async function registerAndHeartbeat(client, config, version, options = {}) {
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
			process: 'market-operations-runner',
			queue: {
				activeJobCount: 0,
				maxConcurrentJobs: Math.max(1, Number(options.maxJobs ?? 1) || 1),
			},
			dryRun: options.dryRun === true,
			mockExternal: options.mockExternal === true,
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

export async function runOnceWithClient(config, client, version, options = {}) {
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
			if (!deploymentStore || operation.namespace !== 'project' || operation.operation !== 'web_deployment') return;
			const deploymentId = operation.input?.deploymentId;
			if (typeof deploymentId !== 'string' || !deploymentId) return;
			const deployment = await deploymentStore.findProjectDeploymentById(deploymentId);
			if (!deployment?.metadata?.cancellation?.requested) return;
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
		if (!launchResult.ok) process.exitCode = 1;
		return combined;
	}
	return result;
}

function objectValue(value) {
	return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

const SENSITIVE_OUTPUT_KEY_PATTERN = /(?:^|[_-])(?:token|password|passphrase|api[_-]?key|private[_-]?key|credential|secret)(?:$|[_-])|(?:token|password|passphrase|apiKey|privateKey|credential)$/iu;
const SENSITIVE_OUTPUT_VALUE_PATTERN = /(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|[A-Za-z0-9+/=]{48,})/gu;

function redactProjectHostOperationValue(value, key = '') {
	if (SENSITIVE_OUTPUT_KEY_PATTERN.test(key)) return '[redacted]';
	if (typeof value === 'string') return value.replace(SENSITIVE_OUTPUT_VALUE_PATTERN, '[redacted]');
	if (Array.isArray(value)) return value.map((entry) => redactProjectHostOperationValue(entry));
	if (!value || typeof value !== 'object') return value;
	const output = {};
	for (const [entryKey, entryValue] of Object.entries(value)) {
		output[entryKey] = redactProjectHostOperationValue(entryValue, entryKey);
	}
	return output;
}

function runnerRuntimeFromOptions(options = {}) {
	const config = objectValue(options.config);
	return {
		resolved: {
			config: {
				baseUrl: config.marketUrl ?? null,
				marketUrl: config.marketUrl ?? null,
				marketDatabaseUrl: config.marketDatabaseUrl ?? null,
				environment: config.environment ?? process.env.TREESEED_PLATFORM_RUNNER_ENVIRONMENT ?? null,
				credentialSessionSecret: config.credentialSessionSecret ?? null,
			},
		},
	};
}

function addCredentialOverlayAliases(overlay, session) {
	const config = objectValue(session?.config);
	for (const [key, value] of Object.entries(config)) {
		if (typeof value === 'string' && value.trim()) overlay[key] = value;
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

async function consumeProjectHostCredentialOverlay(store, runtime, operationId, credentialSessions) {
	const overlay = {};
	const sessions = objectValue(credentialSessions);
	for (const sessionInfo of Object.values(sessions)) {
		const sessionId = typeof sessionInfo === 'string'
			? sessionInfo
			: typeof sessionInfo?.id === 'string'
				? sessionInfo.id
				: '';
		if (!sessionId.trim()) continue;
		const session = await consumeLaunchCredentialSession(store, runtime, operationId, sessionId.trim());
		addCredentialOverlayAliases(overlay, session);
	}
	return overlay;
}

function projectHostMetadataPatchFromResult(input, result, operation) {
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

function mergeHostBindingOperationMetadata(existing, patch) {
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

async function persistProjectHostOperationResult(store, input, result, operation) {
	const projectId = typeof input?.projectId === 'string' ? input.projectId : null;
	if (!projectId) return;
	const details = await store.getProjectDetails(projectId).catch(() => null);
	if (!details?.project) return;
	const patch = redactProjectHostOperationValue(projectHostMetadataPatchFromResult(input, result, operation));
	await store.updateProject(projectId, {
		metadata: mergeHostBindingOperationMetadata(details.project.metadata, patch),
	});
	const refreshedHosting = details.hosting ?? await store.getProjectHosting(projectId).catch(() => null);
	if (refreshedHosting) {
		await store.run(
			`UPDATE project_hosting SET metadata_json = ?, updated_at = ? WHERE project_id = ?`,
			[
				JSON.stringify(mergeHostBindingOperationMetadata(refreshedHosting.metadata, patch)),
				new Date().toISOString(),
				projectId,
			],
		).catch(() => null);
	}
	const refreshedConnection = details.connection ?? await store.getProjectConnection(projectId).catch(() => null);
	if (refreshedConnection) {
		await store.run(
			`UPDATE project_connections SET metadata_json = ?, updated_at = ? WHERE project_id = ?`,
			[
				JSON.stringify(mergeHostBindingOperationMetadata(refreshedConnection.metadata, patch)),
				new Date().toISOString(),
				projectId,
			],
		).catch(() => null);
	}
	const deployments = await store.listProjectDeployments(projectId, { limit: 10 }).catch(() => []);
	for (const deployment of deployments) {
		await store.updateProjectDeployment(deployment.id, {
			metadata: mergeHostBindingOperationMetadata(deployment.metadata, patch),
		}).catch(() => null);
	}
}

async function consumeLaunchCredentialSession(store, runtime, jobId, sessionId) {
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

function credentialSessionSecretForRunner(runtime) {
	const configured = process.env.TREESEED_MARKET_CREDENTIAL_SESSION_SECRET
		?? runtime?.resolved?.config?.credentialSessionSecret
		?? null;
	if (configured && String(configured).trim()) return String(configured);
	const runtimeConfig = runtime?.resolved?.config ?? {};
	const environment = String(runtimeConfig.environment ?? process.env.TREESEED_API_ENVIRONMENT ?? process.env.TREESEED_ENVIRONMENT ?? '').trim().toLowerCase();
	const localDatabase = isLoopbackUrl(runtimeConfig.marketDatabaseUrl ?? process.env.TREESEED_MARKET_DATABASE_URL ?? '');
	const localBaseUrl = isLoopbackUrl(runtimeConfig.baseUrl ?? runtimeConfig.marketUrl ?? process.env.TREESEED_MARKET_API_BASE_URL ?? process.env.TREESEED_SITE_URL ?? process.env.BETTER_AUTH_URL ?? '');
	if (
		process.env.NODE_ENV === 'test'
		|| process.env.TREESEED_LOCAL_DEV_MODE
		|| environment === 'local'
		|| localDatabase
		|| localBaseUrl
	) {
		return 'treeseed-local-test-credential-session-secret';
	}
	throw new Error('TREESEED_MARKET_CREDENTIAL_SESSION_SECRET is required for provider credential sessions.');
}

function decryptCredentialSessionPayloadForRunner(runtime, envelope) {
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

async function prepareLaunchIntentForMarketRunner(store, runtime, job) {
	const launchJobInput = objectValue(job.input);
	const launchIntent = objectValue(launchJobInput.launchIntent);
	const nextIntent = JSON.parse(JSON.stringify(launchIntent));
	const execution = objectValue(nextIntent.execution);
	const providerLaunchInput = objectValue(execution.providerLaunchInput);
	const sessions = objectValue(launchJobInput.credentialSessions);
	if (Object.keys(sessions).length > 0) {
		throw new Error('launch_project jobs must not contain provider credential sessions. Project launch credentials are bootstrapped by the Market API only.');
	}
	const envOverlay = {};
	const consume = async (key) => {
		const sessionId = typeof sessions[key] === 'string' ? sessions[key].trim() : '';
		if (!sessionId) return null;
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
			if (typeof value === 'string' && value.trim()) envOverlay[key] = value;
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
			if (typeof value === 'string' && value.trim()) envOverlay[key] = value;
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

async function runManagedLaunchJobs(config, store, _version, options = {}) {
	if (!store) return { ok: true, processed: 0, failed: 0 };
	const runtime = { resolved: { config: { baseUrl: config.marketUrl ?? null, marketDatabaseUrl: config.marketDatabaseUrl ?? null, environment: config.environment } } };
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
				summary: 'Market operations runner claimed the project launch job.',
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
			const result = options.mockExternal === true
				? {
					mode: 'inline',
					payload: mockedManagedLaunchResult(prepared.intent),
				}
				: await new TreeseedOperationsSdk().execute({
					operationName: prepared.resume ? 'hub.resume_launch' : 'hub.execute_launch',
					input: prepared.intent,
				}, {
					cwd: env('TREESEED_MARKET_REPO_ROOT', process.cwd()),
					env: {
						...process.env,
						...prepared.envOverlay,
					},
					transport: 'sdk',
					onProgress: async (event) => {
						if (event.kind !== 'hub_launch_phase') return;
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
		} catch (error) {
			failed += 1;
			const message = error instanceof Error ? error.message : String(error);
			errors.push({ jobId: job.id, message });
			await applyHubLaunchFailure(store, job, {
				code: 'market_operations_runner_failed',
				message,
			}).catch(() => {});
			await store.failJob(job.id, {
				code: 'market_operations_runner_failed',
				message,
			});
		}
	}
	return { ok: failed === 0, processed, failed, errors };
}

function mockedManagedLaunchResult(intent) {
	const hub = objectValue(intent.hub);
	const repository = objectValue(intent.repository);
	const slug = String(hub.slug ?? hub.id ?? 'project');
	const owner = String(repository.owner ?? 'treeseed-ai');
	return {
		plan: {
			repository: {
				hostId: repository.hostId ?? 'platform:github:hosted-hubs',
				topology: repository.topology ?? 'split_software_content',
			},
			contentResolution: {},
		},
		repository: {
			slug: `${owner}/${slug}`,
			owner,
			name: slug,
			url: `https://github.com/${owner}/${slug}`,
			defaultBranch: 'main',
			stagingBranch: 'staging',
			visibility: repository.visibility ?? 'private',
		},
		repositories: [{
			role: 'software',
			owner,
			name: `${slug}-site`,
			url: `https://github.com/${owner}/${slug}-site`,
			defaultBranch: 'main',
			create: true,
		}, {
			role: 'content',
			owner,
			name: `${slug}-content`,
			url: `https://github.com/${owner}/${slug}-content`,
			defaultBranch: 'main',
			create: true,
		}],
		cloudflare: {
			staging: { siteUrl: `https://${slug}-staging.pages.dev` },
			prod: { siteUrl: `https://${slug}.pages.dev` },
		},
		railway: { services: [], deployments: [], schedules: [] },
		projectApiBaseUrl: `https://${slug}-api.example.test`,
		projectSiteUrl: `https://${slug}.pages.dev`,
		projectMetadata: { mocked: true },
		phases: [
			{ phase: 'repo_provision', status: 'completed', detail: 'Mocked repository provisioning completed.' },
			{ phase: 'runtime_connection', status: 'completed', detail: 'Mocked runtime connection completed.' },
		],
	};
}

async function runOnce(options = {}) {
	const config = await loadConfig();
	const version = await packageVersion();
	const client = await createClient(config);
	const deploymentStore = options.deploymentStore ?? createDeploymentStore(config);
	try {
		return await runOnceWithClient(config, client, version, { ...options, deploymentStore });
	} finally {
		await client.close?.();
		await deploymentStore?.db?.close?.();
	}
}

function startHealthServer(config, state = {}) {
	if (!config.port) return null;
	const server = createServer((request, response) => {
		if (request.url === '/healthz') {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ ok: true, service: 'market-operations-runner', state: state.status ?? 'booting' }));
			return;
		}
		if (request.url === '/readyz') {
			const ready = state.ready === true;
			response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
			response.end(JSON.stringify({
				ok: ready,
				service: 'market-operations-runner',
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

async function runLoop() {
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
	while (!stopping) {
		try {
			if (!config) {
				config = await loadConfig();
			}
			if (!client) {
				client = await createClient(config);
				deploymentStore = options.deploymentStore ?? createDeploymentStore(config);
				await registerAndHeartbeat(client, config, version, { ...options, deploymentStore });
			}
			healthState.ready = true;
			healthState.status = 'running';
			healthState.error = null;
			await runOnceWithClient(config, client, version, { ...options, deploymentStore });
		} catch (error) {
			healthState.ready = false;
			healthState.status = 'degraded';
			healthState.error = error instanceof Error ? error.message : String(error);
			console.error(JSON.stringify({
				ok: false,
				error: healthState.error,
			}));
			if (client?.close) {
				await client.close().catch(() => {});
			}
			await deploymentStore?.db?.close?.().catch?.(() => {});
			client = null;
			deploymentStore = null;
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
		}).catch(() => {});
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
			name: 'market-operations-runner',
			version: await packageVersion(),
		}));
		return;
	}
	if (command === 'healthcheck') {
		const config = await loadConfig({ requireSecrets: false });
		console.log(JSON.stringify({
			ok: true,
			service: 'market-operations-runner',
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
	console.error('Usage: market-operations-runner <version|healthcheck|once|run>');
	process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	await main().catch((error) => {
		console.error(JSON.stringify({
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		}));
		process.exitCode = 1;
	});
}
