import { formatGitHubWorkflowFailure } from '@treeseed/sdk';

export async function executeProjectWebDeployment(runtime, rawInput, context) {
	const {
		objectValue, planOnly, validateInput, deploymentStore, loadDeployment, validatePreflight,
		throwIfDeploymentCancelled, emit, checkpoint, executeTreeDxContentPublish, executeWorkflow,
		failedJobName, append, deploymentTarget, runMonitor, repositorySlug,
	} = runtime;
			const input = { ...objectValue(rawInput), planOnly: planOnly || rawInput?.planOnly === true };
			const normalizedInput = validateInput(input);
			const effectiveDryRun = input.planOnly === true;
			if (!deploymentStore) {
				if (!effectiveDryRun) {
					throw new Error('Project web deployment executor requires the Market control-plane store for live deployments.');
				}
				return {
					ok: true,
					status: 'planned',
					deploymentId: normalizedInput.deploymentId,
					projectId: normalizedInput.projectId,
					teamId: normalizedInput.teamId,
					environment: normalizedInput.environment,
					action: normalizedInput.action,
					plan: {
						repositoryOwner: input.repositoryOwner ?? null,
						repositoryName: input.repositoryName ?? null,
						branch: input.branch ?? (normalizedInput.environment === 'prod' ? 'main' : 'staging'),
						target: input.target ?? {},
					},
					summary: `${normalizedInput.action} for ${normalizedInput.environment} is planned; no provider was called.`,
				};
			}
			let deployment = await loadDeployment(normalizedInput.deploymentId);
			if (effectiveDryRun) {
				const preflight = validatePreflight(deployment, normalizedInput, true);
				return {
					ok: true,
					status: 'planned',
					deploymentId: deployment.id,
					projectId: deployment.projectId,
					teamId: deployment.teamId,
					environment: deployment.environment,
					action: deployment.action,
					plan: { repository: preflight.repositorySlug, workflowFile: preflight.workflowFile, branch: preflight.branch, treeDxPublish: preflight.treeDxPublish },
					summary: `${deployment.action} for ${deployment.environment} is planned; no durable or provider state changed.`,
				};
			}
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
					planOnly: false,
				}, {
					kind: 'deployment.preflight.completed',
					message: 'Deployment preflight checks completed.',
					status: 'claimed',
					payload: {
						repository: preflight.repositorySlug,
						workflowFile: preflight.workflowFile,
						branch: preflight.branch,
					},
				});
				await throwIfDeploymentCancelled(deployment, context);
				let workflowResult = null;
				if (deployment.action !== 'monitor') {
					workflowResult = preflight.treeDxPublish
						? await executeTreeDxContentPublish(deployment, input, context, preflight, false)
						: await executeWorkflow(deployment, input, context, preflight, false);
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
							planOnly: false,
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
							summary: message,
							message,
							retrySafe: true,
							resumeSafe: false,
						}
						: (() => {
							const githubFailure = formatGitHubWorkflowFailure({
								repository: externalWorkflow?.repository ?? repositorySlug(latest.repository),
								workflow: externalWorkflow?.workflow ?? input.workflowFile ?? latest.repository?.workflowFile,
								runId: externalWorkflow?.runId ?? null,
								runUrl: externalWorkflow?.runUrl ?? null,
								message,
								blockerCode: 'deployment_runner_failed',
							});
							return {
								...githubFailure,
								code: githubFailure.blockerCode,
								message: githubFailure.summary,
							};
						})();
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
}
