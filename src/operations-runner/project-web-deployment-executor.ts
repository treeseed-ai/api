// @ts-nocheck
import {
	buildProjectWebMonitorResult,
	cancelGitHubWorkflowRun,
	formatGitHubWorkflowFailure,
	waitForGitHubWorkflowRunCompletion,
} from '@treeseed/sdk';
import { redactDeploymentValue } from '../market/deployment-actions.ts';

const ACTIONS = new Set(['deploy_web', 'publish_content', 'monitor']);
const ENVIRONMENTS = new Set(['staging', 'prod']);
const ACTIVE_STATUSES = new Set(['queued', 'claimed', 'dispatching', 'running', 'monitoring']);

function stringValue(value, fallback = '') {
	return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function objectValue(value, fallback = {}) {
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

function mockWorkflowResult(deployment, input, result) {
	const repository = repositorySlug(deployment.repository) ?? 'local-acceptance/project';
	const branch = stringValue(deployment.repository?.branch, input.environment === 'prod' ? 'main' : 'staging');
	const runId = input.mockRunId ?? 9001;
	const runUrl = `https://github.com/${repository}/actions/runs/${runId}`;
	return {
		status: 'completed',
		repository,
		workflow: stringValue(input.workflowFile, 'deploy-web.yml'),
		runId,
		headSha: input.mockHeadSha ?? 'local-acceptance-head-sha',
		branch,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		conclusion: result === 'failure' ? 'failure' : 'success',
		url: runUrl,
		jobs: [{
			id: 1,
			name: 'deploy',
			status: 'completed',
			conclusion: result === 'failure' ? 'failure' : 'success',
			url: `${runUrl}/job/1`,
			steps: [{
				name: result === 'failure' ? 'Deploy web' : 'Publish result',
				status: 'completed',
				conclusion: result === 'failure' ? 'failure' : 'success',
			}],
		}],
		failedJobs: result === 'failure'
			? [{ id: 1, name: 'deploy', status: 'completed', conclusion: 'failure', url: `${runUrl}/job/1` }]
			: [],
	};
}

function deploymentTarget(deployment, workflowResult) {
	const baseUrl = workflowResult?.conclusion === 'success'
		? deployment.target?.baseUrl ?? deployment.target?.url ?? `https://${deployment.projectId}.example.test`
		: deployment.target?.baseUrl ?? deployment.target?.url ?? null;
	return {
		...(deployment.target ?? {}),
		baseUrl,
		lastDeploymentUrl: baseUrl,
	};
}

export function createProjectWebDeploymentExecutor(options = {}) {
	const deploymentStore = options.deploymentStore ?? options.store ?? null;
	const mockExternal = options.mockExternal === true;
	const mockResult = options.mockResult === 'failure' ? 'failure' : 'success';
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

	async function append(deployment, kind, input = {}) {
		await deploymentStore.appendProjectDeploymentEvent(deployment.id, {
			kind,
			message: input.message ?? kind,
			status: input.status ?? deployment.status,
			severity: input.severity ?? 'info',
			operationId: input.operationId ?? deployment.platformOperationId ?? null,
			payload: input.payload ?? {},
		});
	}

	async function emit(deployment, context, kind, input = {}) {
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
		if (externalWorkflow?.runId && externalWorkflow?.repository && !mockExternal) {
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
		if (input.action !== 'monitor' && !treeDxPublish && !mockExternal && !effectiveDryRun && !String(process.env.TREESEED_GITHUB_TOKEN ?? process.env.TREESEED_GITHUB_TOKEN ?? '').trim()) {
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
			snapshotId: effectiveDryRun || mockExternal ? `plan-${deployment.id}` : `planned-${deployment.id}`,
			r2: {
				status: effectiveDryRun || mockExternal ? 'plan' : 'planned',
				withoutGitHubActions: true,
				bucket: r2BucketName || null,
				manifestKey: r2ManifestKey || null,
			},
			repository: preflight.repository,
		};
		artifact.r2.revision = artifact.snapshotId;
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
			githubClient: mockExternal ? null : githubClient,
			fetchImpl: fetchImpl ?? null,
			mockExternal,
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
				mockExternal,
				planOnly: effectiveDryRun,
			},
		});
		if (mockExternal || effectiveDryRun) {
			const result = mockWorkflowResult(deployment, input, mockResult);
			const externalWorkflow = {
				provider: 'github',
				repository: result.repository,
				workflow: result.workflow,
				runId: result.runId,
				runUrl: result.url,
				headSha: result.headSha,
				branch: result.branch,
				status: 'queued',
				conclusion: null,
				localAcceptanceDriver: mockExternal,
				planOnly: effectiveDryRun,
			};
			await deploymentStore.updateProjectDeployment(deployment.id, { externalWorkflow });
			deployment = await loadDeployment(deployment.id);
			await checkpoint(deployment, context, 'workflow_dispatched', { externalWorkflow }, {
				kind: 'deployment.workflow.dispatched',
				message: 'Project web deployment workflow dispatched.',
				status: 'dispatching',
				payload: externalWorkflow,
			});
			await throwIfDeploymentCancelled(deployment, context, externalWorkflow);
			await deploymentStore.updateProjectDeployment(deployment.id, { status: 'running' });
			deployment = await loadDeployment(deployment.id);
			await emit(deployment, context, 'deployment.workflow.running', {
				message: 'Project web deployment workflow is running.',
				status: 'running',
				payload: { runId: result.runId, runUrl: result.url, activeJob: 'deploy' },
			});
			await checkpoint(deployment, context, 'workflow_run_discovered', { externalWorkflow: { ...externalWorkflow, status: 'in_progress' } }, {
				kind: 'deployment.workflow.run_discovered',
				message: 'Project web deployment workflow run discovered.',
				status: 'running',
				payload: { runId: result.runId, runUrl: result.url },
			});
			await throwIfDeploymentCancelled(deployment, context, externalWorkflow);
			await checkpoint(deployment, context, 'workflow_completed', { workflowResult: result }, {
				kind: 'deployment.workflow.completed',
				message: `Project web deployment workflow completed with ${result.conclusion}.`,
				status: result.conclusion === 'success' ? 'running' : 'failed',
				payload: { runId: result.runId, runUrl: result.url, conclusion: result.conclusion },
			});
			return result;
		}

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
			const input = { ...objectValue(rawInput), planOnly: planOnly || rawInput?.planOnly === true };
			const normalizedInput = validateInput(input);
			const effectiveDryRun = input.planOnly === true;
			if (!deploymentStore) {
				if (!mockExternal && !effectiveDryRun) {
					throw new Error('Project web deployment executor requires the Market control-plane store for live deployments.');
				}
				const deployment = {
					id: normalizedInput.deploymentId,
					projectId: normalizedInput.projectId,
					teamId: normalizedInput.teamId,
					environment: normalizedInput.environment,
					action: normalizedInput.action,
					repository: {
						owner: input.repositoryOwner ?? 'mock',
						name: input.repositoryName ?? normalizedInput.projectId,
						branch: input.branch ?? (normalizedInput.environment === 'prod' ? 'main' : 'staging'),
					},
					target: input.target ?? {},
				};
				const workflowResult = normalizedInput.action === 'monitor'
					? null
					: mockWorkflowResult(deployment, input, mockResult);
				const terminalStatus = workflowResult?.conclusion === 'failure' ? 'failed' : 'succeeded';
				const target = workflowResult ? deploymentTarget(deployment, workflowResult) : deployment.target;
				const monitor = {
					status: terminalStatus === 'failed' ? 'failed' : 'passed',
					checks: [],
					mockExternal,
					planOnly: effectiveDryRun,
				};
				const summary = normalizedInput.action === 'monitor'
					? `monitor for ${normalizedInput.environment} completed with ${monitor.status}.`
					: `${normalizedInput.action} for ${normalizedInput.environment} ${terminalStatus}.`;
				await context.checkpoint?.({
					phase: 'mock_deployment_completed',
					deploymentId: normalizedInput.deploymentId,
					status: terminalStatus,
					externalWorkflow: workflowResult,
					target,
					monitor,
				}, {
					kind: terminalStatus === 'failed' ? 'deployment.failed' : 'deployment.succeeded',
					data: {
						deploymentId: normalizedInput.deploymentId,
						status: terminalStatus,
						message: summary,
						mockExternal,
						planOnly: effectiveDryRun,
					},
				});
				if (terminalStatus === 'failed') {
					throw new Error(summary);
				}
				return {
					ok: true,
					status: terminalStatus,
					deploymentId: normalizedInput.deploymentId,
					projectId: normalizedInput.projectId,
					teamId: normalizedInput.teamId,
					environment: normalizedInput.environment,
					action: normalizedInput.action,
					externalWorkflow: workflowResult,
					target,
					monitor,
					summary,
				};
			}
			let deployment = await loadDeployment(normalizedInput.deploymentId);
			let externalWorkflow = null;
			try {
				await throwIfDeploymentCancelled(deployment, context);
				deployment = await deploymentStore.updateProjectDeployment(deployment.id, {
					status: 'claimed',
					summary: `Runner claimed ${deployment.action} for ${deployment.environment}.`,
				});
				await emit(deployment, context, 'deployment.preflight.started', {
					message: 'Deployment preflight checks started.',
					status: 'claimed',
				});
				const preflight = validatePreflight(deployment, normalizedInput, effectiveDryRun);
				await checkpoint(deployment, context, 'preflight_completed', {
					repository: preflight.repositorySlug,
					workflowFile: preflight.workflowFile,
					branch: preflight.branch,
					mockExternal,
					planOnly: effectiveDryRun,
				}, {
					kind: 'deployment.preflight.completed',
					message: 'Deployment preflight checks completed.',
					status: 'claimed',
					payload: {
						repository: preflight.repositorySlug,
						workflowFile: preflight.workflowFile,
						branch: preflight.branch,
						mockExternal,
					},
				});
				await throwIfDeploymentCancelled(deployment, context);
				let workflowResult = null;
				if (deployment.action !== 'monitor') {
					workflowResult = preflight.treeDxPublish
						? await executeTreeDxContentPublish(deployment, input, context, preflight, effectiveDryRun)
						: await executeWorkflow(deployment, input, context, preflight, effectiveDryRun);
					externalWorkflow = preflight.treeDxPublish
						? null
						: {
							provider: 'github',
							repository: workflowResult.repository,
							workflow: workflowResult.workflow,
							runId: workflowResult.runId,
							runUrl: workflowResult.url,
							headSha: workflowResult.headSha,
							branch: workflowResult.branch,
							status: workflowResult.status,
							conclusion: workflowResult.conclusion,
							mock: mockExternal,
							planOnly: effectiveDryRun,
						};
					deployment = await loadDeployment(deployment.id);
					await throwIfDeploymentCancelled(deployment, context, externalWorkflow);
				}
				if (workflowResult && workflowResult.conclusion !== 'success') {
					const failure = formatGitHubWorkflowFailure({
						repository: workflowResult.repository,
						workflow: workflowResult.workflow,
						runId: workflowResult.runId,
						runUrl: workflowResult.url,
						conclusion: workflowResult.conclusion,
						failedJobName: failedJobName(workflowResult),
					});
					await deploymentStore.updateProjectDeployment(deployment.id, {
						status: 'failed',
						externalWorkflow,
						summary: failure.summary,
						error: failure,
					});
					await append(deployment, 'deployment.failed', {
						message: failure.summary,
						status: 'failed',
						severity: 'error',
						operationId: context.operationId,
						payload: failure,
					});
					await deploymentStore.recordProjectDeploymentAudit?.(deployment.id, 'project_deployment_failed', {
						actorType: 'system',
						actorId: context.runnerId ?? 'market_operations_runner',
						actorUserId: deployment.requestedByUserId ?? null,
						status: 'failed',
						operationId: context.operationId,
						summary: failure.summary,
					});
					throw new Error(failure.summary);
				}
				const target = workflowResult && !preflight.treeDxPublish ? deploymentTarget(deployment, workflowResult) : {
					...(deployment.target ?? {}),
					contentPublish: preflight.treeDxPublish ? workflowResult?.artifact ?? null : deployment.target?.contentPublish ?? null,
				};
				const monitor = await runMonitor(deployment, context, input, preflight, workflowResult, target);
				if (deployment.action !== 'monitor') {
					await deploymentStore.upsertProjectEnvironment?.(deployment.projectId, {
						environment: deployment.environment,
						deploymentProfile: target.kind ?? target.profile ?? 'web',
						baseUrl: target.baseUrl ?? null,
						metadata: {
							lastDeploymentId: deployment.id,
							lastOperationId: context.operationId,
							externalWorkflow,
						},
					});
					await checkpoint(deployment, context, 'environment_updated', { environment: deployment.environment, target }, {
						kind: 'deployment.environment.updated',
						message: 'Project environment state updated.',
						status: 'monitoring',
						payload: { environment: deployment.environment, target },
					});
				}
				const terminalStatus = monitor.status === 'failed' ? 'failed' : 'succeeded';
				const summary = deployment.action === 'monitor'
					? `monitor for ${deployment.environment} completed with ${monitor.status}.`
					: `${deployment.action} for ${deployment.environment} succeeded.`;
				const succeeded = await deploymentStore.updateProjectDeployment(deployment.id, {
					status: terminalStatus,
					externalWorkflow: externalWorkflow ?? deployment.externalWorkflow,
					target,
					monitor,
					summary,
					error: monitor.status === 'failed'
						? {
							code: 'project_web_monitor_failed',
							message: summary,
							checks: monitor.checks.filter((check) => check.status === 'failed'),
							retrySafe: true,
							resumeSafe: false,
						}
						: {},
				});
				await append(succeeded, terminalStatus === 'failed' ? 'deployment.failed' : 'deployment.succeeded', {
					message: summary,
					status: terminalStatus,
					operationId: context.operationId,
					payload: { externalWorkflow, target, monitor },
				});
				await deploymentStore.recordProjectDeploymentAudit?.(succeeded, 'project_monitor_completed', {
					actorType: 'system',
					actorId: context.runnerId ?? 'market_operations_runner',
					actorUserId: succeeded.requestedByUserId ?? null,
					status: terminalStatus,
					operationId: context.operationId,
					summary: `Monitor completed with ${monitor.status}.`,
				});
				await deploymentStore.recordProjectDeploymentAudit?.(succeeded, terminalStatus === 'failed' ? 'project_deployment_failed' : 'project_deployment_succeeded', {
					actorType: 'system',
					actorId: context.runnerId ?? 'market_operations_runner',
					actorUserId: succeeded.requestedByUserId ?? null,
					status: terminalStatus,
					operationId: context.operationId,
					summary,
				});
				if (terminalStatus === 'failed') {
					throw new Error(summary);
				}
				return {
					ok: true,
					deploymentId: succeeded.id,
					projectId: succeeded.projectId,
					environment: succeeded.environment,
					action: succeeded.action,
					externalWorkflow,
					target,
					monitor,
					summary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const latest = await loadDeployment(normalizedInput.deploymentId).catch(() => deployment);
				if (latest && !['failed', 'cancelled', 'timed_out', 'succeeded'].includes(latest.status)) {
					const failure = message.toLowerCase().includes('cancel')
						? {
							code: 'deployment_cancelled',
							message,
							retrySafe: true,
							resumeSafe: false,
						}
						: formatGitHubWorkflowFailure({
							repository: externalWorkflow?.repository ?? repositorySlug(latest.repository),
							workflow: externalWorkflow?.workflow ?? input.workflowFile ?? latest.repository?.workflowFile,
							runId: externalWorkflow?.runId ?? null,
							runUrl: externalWorkflow?.runUrl ?? null,
							message,
							blockerCode: 'deployment_runner_failed',
						});
					await deploymentStore.updateProjectDeployment(latest.id, {
						status: failure.code === 'deployment_cancelled' ? 'cancelled' : 'failed',
						summary: failure.summary ?? failure.message,
						error: failure,
					});
					await append(latest, failure.code === 'deployment_cancelled' ? 'deployment.cancelled' : 'deployment.failed', {
						message: failure.summary ?? failure.message,
						status: failure.code === 'deployment_cancelled' ? 'cancelled' : 'failed',
						severity: failure.code === 'deployment_cancelled' ? 'warning' : 'error',
						operationId: context.operationId,
						payload: failure,
					});
					await deploymentStore.recordProjectDeploymentAudit?.(latest.id, failure.code === 'deployment_cancelled' ? 'project_deployment_cancelled' : 'project_deployment_failed', {
						actorType: 'system',
						actorId: context.runnerId ?? 'market_operations_runner',
						actorUserId: latest.requestedByUserId ?? null,
						status: failure.code === 'deployment_cancelled' ? 'cancelled' : 'failed',
						operationId: context.operationId,
						summary: failure.summary ?? failure.message,
					});
				}
				throw error;
			}
		},
	};
}
