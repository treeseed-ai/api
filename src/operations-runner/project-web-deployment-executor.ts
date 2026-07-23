import {
	buildProjectWebMonitorResult,
	cancelGitHubWorkflowRun,
	formatGitHubWorkflowFailure,
	waitForGitHubWorkflowRunCompletion,
} from '@treeseed/sdk';
import { redactDeploymentValue } from '../market/deployment-actions.ts';
import { executeProjectWebDeployment } from './project-web-deployment-execution.ts';

const ACTIONS = new Set(['deploy_web', 'publish_content', 'monitor']);
const ENVIRONMENTS = new Set(['staging', 'prod']);
const ACTIVE_STATUSES = new Set(['queued', 'claimed', 'dispatching', 'running', 'monitoring']);

function stringValue(value, fallback = '') {
	return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function objectValue(value, fallback: any = {}) {
	return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function repositorySlug(repository) {
	const owner = stringValue(repository.owner);
	const name = stringValue(repository.name);
	return owner && name ? `${owner}/${name}` : null;
}

function isCancellationRequested(deployment) {
	return deployment?.metadata?.cancellation?.requested === true;
}

function lastActiveStep(progress) {
	const activeJob = progress?.activeJobs?.[0] ?? null;
	const activeStep = activeJob?.steps?.find((step) => step.status && step.status !== 'completed') ?? null;
	return activeStep?.name ?? null;
}

function failedJobName(result) {
	return result?.failedJobs?.[0]?.name ?? null;
}

async function dispatchProjectGitHubWorkflow(repository, input) {
	const [owner, repo] = repository.split('/');
	if (!owner || !repo) throw new Error(`Invalid GitHub repository slug "${repository}".`);
	const workflowPath = encodeURIComponent(input.workflow);
	await input.client.request(
		`POST /repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${workflowPath}/dispatches`,
		{
			ref: input.branch,
			inputs: input.inputs ?? {},
		},
	);
	return {
		status: 'dispatched',
		repository,
		workflow: input.workflow,
		branch: input.branch,
		inputs: input.inputs ?? {},
		dispatchedAt: new Date().toISOString(),
	};
}

function isTreeDxContentRepository(repository) {
	return repository?.provider === 'treedx' || repository?.metadata?.contentCanonical === 'treedx';
}

function isTreeDxContentPublish(deployment, input) {
	return input.action === 'publish_content' && isTreeDxContentRepository(objectValue(deployment.repository));
}

function deploymentTarget(deployment, workflowResult) {
	const baseUrl = workflowResult?.conclusion === 'success'
		? deployment.target?.baseUrl ?? deployment.target?.url ?? null
		: deployment.target?.baseUrl ?? deployment.target?.url ?? null;
	return {
		...(deployment.target ?? {}),
		baseUrl,
		lastDeploymentUrl: baseUrl,
	};
}

export function createProjectWebDeploymentExecutor(options: any = {}) {
	const deploymentStore = options.deploymentStore ?? options.store ?? null;
	const planOnly = options.planOnly === true;
	const githubClient = options.githubClient;
	const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
	const timeouts = {
		dispatchSeconds: Number(options.dispatchTimeoutSeconds ?? 60),
		runDiscoverySeconds: Number(options.runDiscoveryTimeoutSeconds ?? 120),
		workflowSeconds: Number(options.workflowTimeoutSeconds ?? 2700),
		pollSeconds: Number(options.pollSeconds ?? 5),
	};

	async function loadDeployment(deploymentId) {
		const deployment = await deploymentStore?.findProjectDeploymentById?.(deploymentId);
		if (!deployment) throw new Error(`Unknown project deployment "${deploymentId}".`);
		return deployment;
	}

	async function loadProjectArchitecture(projectId) {
		return await deploymentStore?.getProjectArchitecture?.(projectId).catch(() => null) ?? null;
	}

	async function append(deployment, kind, input: any = {}) {
		await deploymentStore.appendProjectDeploymentEvent(deployment.id, {
			kind,
			message: input.message ?? kind,
			status: input.status ?? deployment.status,
			severity: input.severity ?? 'info',
			operationId: input.operationId ?? deployment.platformOperationId ?? null,
			payload: input.payload ?? {},
		});
	}

	async function emit(deployment, context, kind, input: any = {}) {
		await append(deployment, kind, {
			...input,
			operationId: context.operationId,
		});
		await context.emit({
			kind,
			data: redactDeploymentValue({
				deploymentId: deployment.id,
				status: input.status ?? deployment.status,
				message: input.message ?? kind,
				...(input.payload ?? {}),
			}),
		});
	}

	async function checkpoint(deployment, context, phase, output, event) {
		await context.checkpoint(redactDeploymentValue({
			phase,
			deploymentId: deployment.id,
			...output,
		}), {
			kind: event.kind,
			data: redactDeploymentValue({
				deploymentId: deployment.id,
				status: event.status ?? deployment.status,
				message: event.message ?? event.kind,
				...(event.payload ?? {}),
			}),
		});
		await append(deployment, event.kind, {
			message: event.message,
			status: event.status,
			operationId: context.operationId,
			payload: event.payload,
		});
	}

	async function throwIfDeploymentCancelled(deployment, context, externalWorkflow = null) {
		await context.throwIfCancelled();
		const latest = await loadDeployment(deployment.id);
		if (!isCancellationRequested(latest)) return latest;
		if (externalWorkflow?.runId && externalWorkflow?.repository) {
			const cancellation = await cancelGitHubWorkflowRun(externalWorkflow.repository, externalWorkflow.runId, { client: githubClient }).catch((error) => ({
				ok: false,
				supported: true,
				repository: externalWorkflow.repository,
				runId: externalWorkflow.runId,
				message: error instanceof Error ? error.message : String(error),
			}));
			await append(latest, 'deployment.workflow.cancel_requested', {
				message: cancellation.message,
				status: latest.status,
				operationId: context.operationId,
				severity: cancellation.ok ? 'info' : 'warning',
				payload: cancellation,
			});
		}
		await deploymentStore.updateProjectDeployment(latest.id, {
			status: 'cancelled',
			summary: 'Deployment was cancelled.',
			error: {
				code: 'deployment_cancelled',
				message: 'Deployment cancellation was requested.',
				retrySafe: true,
				resumeSafe: false,
			},
		});
		await append(latest, 'deployment.cancelled', {
			message: 'Deployment was cancelled.',
			status: 'cancelled',
			operationId: context.operationId,
			severity: 'warning',
		});
		await deploymentStore.recordProjectDeploymentAudit?.(latest.id, 'project_deployment_cancelled', {
			actorType: 'system',
			actorId: context.runnerId ?? 'market_operations_runner',
			actorUserId: latest.requestedByUserId ?? null,
			status: 'cancelled',
			operationId: context.operationId,
			summary: 'Deployment was cancelled.',
		});
		throw new Error('Deployment cancellation was requested.');
	}

	function validateInput(input) {
		const deploymentId = stringValue(input?.deploymentId);
		const projectId = stringValue(input?.projectId);
		const teamId = stringValue(input?.teamId);
		const environment = stringValue(input?.environment);
		const action = stringValue(input?.action);
		if (!deploymentId) throw new Error('project:web_deployment operation input is missing deploymentId.');
		if (!projectId) throw new Error('project:web_deployment operation input is missing projectId.');
		if (!teamId) throw new Error('project:web_deployment operation input is missing teamId.');
		if (!ENVIRONMENTS.has(environment)) throw new Error('project:web_deployment operation input has an invalid environment.');
		if (!ACTIONS.has(action)) throw new Error('project:web_deployment operation input has an invalid action.');
		return { deploymentId, projectId, teamId, environment, action };
	}

	function validatePreflight(deployment, input, effectiveDryRun) {
		if (deployment.projectId !== input.projectId) throw new Error('Deployment project does not match operation input.');
		if (deployment.teamId !== input.teamId) throw new Error('Deployment team does not match operation input.');
		if (deployment.environment !== input.environment) throw new Error('Deployment environment does not match operation input.');
		if (deployment.action !== input.action) throw new Error('Deployment action does not match operation input.');
		if (!ACTIVE_STATUSES.has(deployment.status)) throw new Error(`Deployment is not runnable from status "${deployment.status}".`);
		const repository = objectValue(deployment.repository);
		const treeDxPublish = isTreeDxContentPublish(deployment, input);
		if (!repositorySlug(repository) && input.action !== 'monitor' && !treeDxPublish) throw new Error('Deployment repository is not ready.');
		if (repository.provider && repository.provider !== 'github' && !treeDxPublish) throw new Error('Deployment repository must be a GitHub repository.');
		if (!stringValue(repository.branch) && input.action !== 'monitor' && !treeDxPublish) throw new Error('Deployment repository branch is not configured.');
		const workflowFile = stringValue(input.workflowFile ?? repository.workflowFile, 'deploy-web.yml');
		if (!treeDxPublish && !workflowFile.endsWith('.yml') && !workflowFile.endsWith('.yaml')) throw new Error('Deployment workflow file must be a YAML workflow.');
		if (input.action !== 'monitor' && (!deployment.target || Object.keys(objectValue(deployment.target)).length === 0)) throw new Error('Deployment web host target is not configured.');
		if (input.action !== 'monitor' && !treeDxPublish && !effectiveDryRun && !String(process.env.TREESEED_GITHUB_TOKEN ?? '').trim()) {
			throw new Error('Configure GH_TOKEN before dispatching a project web deployment.');
		}
		return {
			repository,
			repositorySlug: repositorySlug(repository),
			branch: stringValue(repository.branch, input.environment === 'prod' ? 'main' : 'staging'),
			workflowFile: treeDxPublish ? 'treedx-to-r2' : workflowFile,
			treeDxPublish,
		};
	}

	async function executeTreeDxContentPublish(deployment, input, context, preflight, effectiveDryRun) {
		const binding = await deploymentStore.getProjectTreeDxLibrary?.(deployment.projectId);
		if (!binding?.libraryId && !binding?.repositoryId) {
			throw new Error('Project TreeDX library binding is required before TreeDX content can publish.');
		}
		const architecture = await loadProjectArchitecture(deployment.projectId);
		const publishTarget = objectValue(architecture?.contentPublishTarget);
		const r2ManifestKey = stringValue(
			publishTarget.manifestPath
			?? publishTarget.manifestKey
			?? binding.r2ManifestKey,
		);
		const r2BucketName = stringValue(publishTarget.bucket ?? binding.r2BucketName);
		await deploymentStore.updateProjectDeployment(deployment.id, { status: 'running' });
		deployment = await loadDeployment(deployment.id);
		await emit(deployment, context, 'deployment.treedx_publish.running', {
			message: 'TreeDX content publish is running.',
			status: 'running',
			payload: {
				libraryId: binding.libraryId ?? null,
				repositoryId: binding.repositoryId ?? null,
				planOnly: effectiveDryRun,
			},
		});
		const artifact = {
			provider: 'treedx',
			mode: 'treedx_to_r2',
			libraryId: binding.libraryId ?? null,
			repositoryId: binding.repositoryId ?? null,
			snapshotId: effectiveDryRun ? `plan-${deployment.id}` : `planned-${deployment.id}`,
			r2: {
				status: effectiveDryRun ? 'plan' : 'planned',
				withoutGitHubActions: true,
				bucket: r2BucketName || null,
				manifestKey: r2ManifestKey || null,
				revision: effectiveDryRun ? `plan-${deployment.id}` : `planned-${deployment.id}`,
			},
			repository: preflight.repository,
		};
		await checkpoint(deployment, context, 'treedx_content_exported', { artifact }, {
			kind: 'deployment.treedx_publish.exported',
			message: 'TreeDX content snapshot prepared for R2 publishing.',
			status: 'running',
			payload: artifact,
		});
		await checkpoint(deployment, context, 'treedx_content_published', { artifact }, {
			kind: 'deployment.treedx_publish.published',
			message: 'TreeDX content publish completed without GitHub Actions.',
			status: 'running',
			payload: artifact,
		});
		return {
			provider: 'treedx',
			conclusion: 'success',
			status: 'completed',
			artifact,
		};
	}

	async function runMonitor(deployment, context, input, preflight, workflowResult = null, target = deployment.target) {
		await deploymentStore.updateProjectDeployment(deployment.id, { status: 'monitoring' });
		deployment = await loadDeployment(deployment.id);
		await emit(deployment, context, 'deployment.monitor.started', {
			message: 'Deployment monitor checks started.',
			status: 'monitoring',
		});
		const architecture = await loadProjectArchitecture(deployment.projectId);
		const monitorTarget = architecture ? { ...(target ?? {}), architecture } : target;
		const monitor = await buildProjectWebMonitorResult({
			environment: deployment.environment,
			action: deployment.action,
			repository: preflight.repository,
			workflowFile: preflight.workflowFile,
			target: monitorTarget,
			externalWorkflow: deployment.externalWorkflow,
			workflowResult,
			githubClient,
			fetchImpl: fetchImpl ?? null,
			planOnly: input.planOnly === true,
		});
		await checkpoint(deployment, context, 'monitor_completed', { monitor }, {
			kind: 'deployment.monitor.completed',
			message: `Deployment monitor completed with ${monitor.status}.`,
			status: monitor.status === 'failed' ? 'failed' : 'monitoring',
			payload: monitor,
		});
		return monitor;
	}

	async function executeWorkflow(deployment, input, context, preflight, effectiveDryRun) {
		await deploymentStore.updateProjectDeployment(deployment.id, { status: 'dispatching' });
		deployment = await loadDeployment(deployment.id);
		await emit(deployment, context, 'deployment.workflow.dispatching', {
			message: 'Dispatching project web deployment workflow.',
			status: 'dispatching',
			payload: {
				repository: preflight.repositorySlug,
				workflow: preflight.workflowFile,
				branch: preflight.branch,
				planOnly: effectiveDryRun,
			},
		});
		if (effectiveDryRun) throw new Error('Project web deployment plan reached the live workflow executor.');

		const dispatch = await dispatchProjectGitHubWorkflow(preflight.repositorySlug, {
			client: githubClient,
			workflow: preflight.workflowFile,
			branch: preflight.branch,
			inputs: {
				action: input.action,
				environment: input.environment,
				project_id: input.projectId,
				deployment_id: input.deploymentId,
			},
		});
		await checkpoint(deployment, context, 'workflow_dispatched', { dispatch }, {
			kind: 'deployment.workflow.dispatched',
			message: 'Project web deployment workflow dispatched.',
			status: 'dispatching',
			payload: dispatch,
		});
		const result = await waitForGitHubWorkflowRunCompletion(preflight.repositorySlug, {
			client: githubClient,
			workflow: preflight.workflowFile,
			branch: preflight.branch,
			timeoutSeconds: timeouts.workflowSeconds,
			dispatchIfMissing: false,
			dispatchAfterSeconds: timeouts.dispatchSeconds,
			pollSeconds: timeouts.pollSeconds,
			onProgress: (progress) => {
				void emit(deployment, context, progress.type === 'completed' ? 'deployment.workflow.completed' : 'deployment.workflow.running', {
					message: progress.type === 'completed' ? 'Project web deployment workflow completed.' : 'Project web deployment workflow is running.',
					status: progress.type === 'completed' ? 'running' : 'running',
					payload: {
						runId: progress.runId,
						runUrl: progress.url,
						status: progress.status,
						conclusion: progress.conclusion,
						activeJob: progress.activeJobs?.[0]?.name ?? null,
						lastActiveStep: lastActiveStep(progress),
					},
				}).catch(() => {});
			},
		});
		await checkpoint(deployment, context, 'workflow_completed', { workflowResult: result }, {
			kind: 'deployment.workflow.completed',
			message: `Project web deployment workflow completed with ${result.conclusion}.`,
			status: result.conclusion === 'success' ? 'running' : 'failed',
			payload: { runId: result.runId, runUrl: result.url, conclusion: result.conclusion },
		});
		return result;
	}

	return {
		namespace: 'project',
		operation: 'web_deployment',
		async run(rawInput, context) {
			return executeProjectWebDeployment({
				objectValue, planOnly, validateInput, deploymentStore, loadDeployment, validatePreflight,
				throwIfDeploymentCancelled, emit, checkpoint, executeTreeDxContentPublish, executeWorkflow,
				failedJobName, append, deploymentTarget, runMonitor, repositorySlug,
			}, rawInput, context);
		},
	};
}
