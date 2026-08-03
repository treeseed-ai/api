import { executePlatformRepositoryOperation } from '@treeseed/sdk';
import { objectValue,treeDxRailway,treeDxRailwayNames,treeDxSecretBase } from '../index.js';
import { createFeedbackExecutors } from '../../feedback/executors.ts';
import { createKnowledgePublicationExecutor } from '../../knowledge/publication-executor.ts';
import { createKnowledgePackCleanupExecutor, createKnowledgePackExecutor } from '../../knowledge/pack-executor.ts';
import { createGitHubWorkflowExecutor } from '../../workflows/github-workflow-executor.ts';
import { createGitHubConfigurationExecutor } from '../../workflows/github-configuration-executor.ts';

export function createExecutors() {
    return createExecutorsForOptions({});
}

export function createExecutorsForOptions(options: any = {}) {
    const workflowExecutor = createGitHubWorkflowExecutor({ controlPlaneStore: options.controlPlaneStore, fetchImpl: options.fetchImpl });
    const workflowConfigurationExecutor = createGitHubConfigurationExecutor({ controlPlaneStore: options.controlPlaneStore, fetchImpl: options.fetchImpl });
    const noop = {
        namespace: 'market',
        operation: 'noop',
        async run(_input, context) {
            await context.checkpoint({ phase: 'diagnostic' }, { kind: 'market.noop', data: { runnerId: process.env.TREESEED_PLATFORM_RUNNER_ID ?? null } });
            return {
                ok: true,
                message: 'Treeseed operations runner diagnostic completed.',
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
				operationId: context.operationId,
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
    const treeDxProvisionExecutor = {
        namespace: 'treedx',
        operation: 'provision',
        async run(input, context) {
            if (!options.controlPlaneStore) {
                throw new Error('TreeDX provisioning requires a Treeseed control-plane store.');
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
            const team = await options.controlPlaneStore.getTeam?.(teamId);
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
            await options.controlPlaneStore.updateTreeDxDeployment(deploymentId, {
                status: 'running',
                imageRef,
                volumeMountPath,
                result: {
                    operationId: context.operation.id,
                    phase: payload.planOnly === true ? 'railway_service_planned' : 'railway_service_provisioning',
                    scope: names.scope,
                },
            });
            let railwayRefs: {
                workspaceId?: string | null;
                projectId?: string;
                projectName?: string;
                serviceId?: string;
                serviceName?: string;
                environmentId?: string;
                environmentName?: string;
                volumeId?: string | null;
                volumeName?: string | null;
                domainId?: string | null;
                domain?: string | null;
                deploymentId?: string | null;
            } = {};
            let baseUrl = typeof payload.baseUrl === 'string' && payload.baseUrl.trim() ? payload.baseUrl.trim() : null;
            let externalDeploymentId = null;
            if (payload.planOnly !== true) {
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
                const variables: Record<string, string> = {
                    TREESEED_TREEDX_DATA_DIR: volumeMountPath,
                    ...(names.scope === 'public_federation' ? { TREESEED_TREEDX_FEDERATION_MODE: 'connected_library' } : {}),
                    PORT: '4000',
                    PHX_SERVER: 'true',
                    PHX_HOST: `${names.serviceName}.railway.app`,
                    TREESEED_TREEDX_SCOPE: names.scope,
                };
                if (!currentVariables.TREESEED_TREEDX_SECRET_KEY_BASE && !currentVariables.SECRET_KEY_BASE) {
                    variables.TREESEED_TREEDX_SECRET_KEY_BASE = treeDxSecretBase();
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
                    TREESEED_TREEDX_DATA_DIR: '/data',
                    PORT: '4000',
                    PHX_SERVER: 'true',
                    TREESEED_TREEDX_SECRET_KEY_BASE: 'railway:TREESEED_TREEDX_SECRET_KEY_BASE',
                },
                planOnly: payload.planOnly === true,
            };
            await options.controlPlaneStore.upsertTeamTreeDx(teamId, {
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
                        TREESEED_TREEDX_SECRET_KEY_BASE: 'service-variable',
                    },
                    planOnly: payload.planOnly === true,
                },
            });
            const deployment = await options.controlPlaneStore.updateTreeDxDeployment(deploymentId, {
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
                    health: payload.planOnly === true ? 'plan_planned' : 'deployment_started',
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
        repositoryExecutor('initialize_linked_repository'),
        repositoryExecutor('write_content_record'),
        repositoryExecutor('create_related_content'),
        repositoryExecutor('create_decision_from_proposals'),
		treeDxProvisionExecutor,
		...createFeedbackExecutors(options),
		createKnowledgePublicationExecutor(options),
		createKnowledgePackExecutor(options),
		createKnowledgePackCleanupExecutor(options),
		workflowExecutor,
		workflowConfigurationExecutor,
    ].filter((executor) => !options.operationKey || `${executor.namespace}:${executor.operation}` === options.operationKey);
}
