function resourceRowsFromLaunch(projectId, launch) {
	const rows = [];
	for (const [environment, summary] of [['staging', launch.cloudflare?.staging], ['prod', launch.cloudflare?.prod]]) {
		if (!summary) continue;
		rows.push(
			{
				projectId,
				environment,
				provider: 'cloudflare',
				resourceKind: 'pages',
				logicalName: 'site',
				locator: summary.pages?.url ?? summary.siteUrl ?? null,
				metadata: summary.pages ?? {},
			},
			{
				projectId,
				environment,
				provider: 'cloudflare',
				resourceKind: 'worker',
				logicalName: 'worker',
				locator: summary.workerName ?? null,
				metadata: { workerName: summary.workerName ?? null },
			},
			{
				projectId,
				environment,
				provider: 'cloudflare',
				resourceKind: 'kv',
				logicalName: 'form_guard',
				locator: summary.formGuardKv?.id ?? summary.formGuardKv?.name ?? null,
				metadata: summary.formGuardKv ?? {},
			},
			{
				projectId,
				environment,
				provider: 'cloudflare',
				resourceKind: 'turnstile-widget',
				logicalName: 'form_guard_turnstile',
				locator: summary.turnstileWidget?.sitekey ?? null,
				metadata: summary.turnstileWidget ?? {},
			},
			{
				projectId,
				environment,
				provider: 'cloudflare',
				resourceKind: 'r2',
				logicalName: 'content',
				locator: summary.content?.bucketName ?? null,
				metadata: summary.content ?? {},
			},
			{
				projectId,
				environment,
				provider: 'cloudflare',
				resourceKind: 'd1',
				logicalName: 'site_data',
				locator: summary.siteDataDb?.databaseId ?? summary.siteDataDb?.databaseName ?? null,
				metadata: summary.siteDataDb ?? {},
			},
			{
				projectId,
				environment,
				provider: 'cloudflare',
				resourceKind: 'queue',
				logicalName: 'agent_work',
				locator: summary.queue?.queueId ?? summary.queue?.name ?? null,
				metadata: summary.queue ?? {},
			},
		);
		if (summary.queue?.dlqName || summary.queue?.dlqId) {
			rows.push({
				projectId,
				environment,
				provider: 'cloudflare',
				resourceKind: 'dlq',
				logicalName: 'agent_work_dlq',
				locator: summary.queue?.dlqId ?? summary.queue?.dlqName ?? null,
				metadata: summary.queue ?? {},
			});
		}
	}
	for (const service of launch.railway?.services ?? []) {
		rows.push({
			projectId,
			environment: service.scope ?? 'prod',
			provider: 'railway',
			resourceKind: 'railway_service',
			logicalName: service.key,
			locator: service.publicBaseUrl ?? service.serviceName ?? service.serviceId ?? null,
			metadata: service,
		});
		if (service.projectName || service.projectId) {
			rows.push({
				projectId,
				environment: service.scope ?? 'prod',
				provider: 'railway',
				resourceKind: 'railway_project',
				logicalName: service.key,
				locator: service.projectId ?? service.projectName ?? null,
				metadata: {
					projectId: service.projectId ?? null,
					projectName: service.projectName ?? null,
				},
			});
		}
	}
	for (const schedule of launch.railway?.schedules ?? []) {
		rows.push({
			projectId,
			environment: 'prod',
			provider: 'railway',
			resourceKind: 'railway_schedule',
			logicalName: schedule.logicalName ?? schedule.service ?? 'schedule',
			locator: schedule.id ?? null,
			metadata: schedule,
		});
	}
	return rows.filter((row) => row.locator || row.metadata);
}

async function projectAppHref(_store, _teamId, projectSlug, section) {
	if (section === 'share') return '/app/knowledge/artifacts';
	return projectSlug ? `/app/projects/${encodeURIComponent(projectSlug)}` : '/app/projects';
}

function unwrapLaunchOperationOutput(output) {
	if (output?.operation === 'hub.execute_launch' && output.payload) return output.payload;
	if (output?.plan?.repository && output?.repository && output?.cloudflare) return output;
	return null;
}

async function appendLaunchPhaseProjection(store, launchId, jobId, phase) {
	const event = {
		phase: phase.phase,
		status: phase.status,
		title: phase.title ?? String(phase.phase ?? '').replace(/_/gu, ' '),
		summary: phase.summary ?? phase.detail ?? null,
		startedAt: phase.startedAt ?? (phase.status === 'running' ? new Date().toISOString() : null),
		finishedAt: phase.finishedAt ?? (phase.status === 'completed' || phase.status === 'failed' ? new Date().toISOString() : null),
		error: phase.error ?? (phase.status === 'failed' ? { message: phase.summary ?? phase.detail ?? 'Launch phase failed.' } : null),
		data: phase.data ?? {},
	};
	const existingEvents = await store.listHubLaunchEvents(launchId);
	const duplicate = existingEvents.some((existing) => (
		existing.phase === event.phase
		&& existing.status === event.status
		&& (existing.summary ?? null) === (event.summary ?? null)
	));
	if (duplicate) return null;
	await store.appendHubLaunchEvent(launchId, event);
	await store.appendJobEvent(jobId, 'phase', event);
	if (phase.status === 'completed' || phase.status === 'failed' || phase.status === 'running') {
		await store.updateHubLaunch(launchId, {
			state: phase.status === 'failed' ? 'failed' : phase.status === 'completed' ? 'running' : 'running',
			currentPhase: phase.phase,
			lastSuccessfulPhase: phase.status === 'completed' ? phase.phase : undefined,
		});
	}
	return event;
}

async function updateLaunchDeployments(store, job, patch) {
	const deployments = await store.listProjectDeployments(job.projectId, { limit: 100 }).catch(() => []);
	for (const deployment of deployments.filter((entry) => entry.platformOperationId === job.id)) {
		const updated = await store.updateProjectDeployment(deployment.id, {
			...patch,
			metadata: {
				...(deployment.metadata ?? {}),
				...(patch.metadata ?? {}),
			},
		});
		await store.appendProjectDeploymentEvent(deployment.id, {
			kind: patch.status === 'succeeded' ? 'launch.succeeded' : patch.status === 'failed' ? 'launch.failed' : 'launch.updated',
			message: patch.summary ?? (patch.status === 'succeeded' ? 'Initial project launch completed.' : patch.status === 'failed' ? 'Initial project launch failed.' : 'Initial project launch updated.'),
			status: updated?.status ?? patch.status ?? deployment.status,
			severity: patch.status === 'failed' ? 'error' : 'info',
			operationId: job.id,
			payload: {
				launchJobId: job.id,
				error: patch.error ?? null,
			},
		}).catch(() => null);
	}
}

function hubRepositoryPolicies(role) {
	if (role === 'content') {
		return {
			releasePolicy: {
				track: 'content_publish',
				softwareReleaseRequired: false,
				approvalRule: 'content_policy_approver',
			},
			publishPolicy: {
				track: 'content_publish',
				target: 'r2_published_artifacts',
				approvalRule: 'content_policy_approver',
			},
		};
	}
	if (role === 'parent_workspace') {
		return {
			releasePolicy: {
				track: 'parent_workspace_pointer',
				approvalRule: 'technical_steward',
			},
			publishPolicy: {
				disabled: true,
				reason: 'Parent workspace repositories are updated through workspace pointer jobs.',
			},
		};
	}
	return {
		releasePolicy: {
			track: 'software_release',
			approvalRule: 'technical_steward_or_release_approver',
		},
		publishPolicy: {
			disabled: true,
			reason: 'Software repositories do not publish content artifacts.',
		},
	};
}

export async function applyHubLaunchResult(store, runtime, job, output, principal = null) {
	const launchResult = unwrapLaunchOperationOutput(output);
	if (!launchResult) return null;
	const hubLaunch = await store.getHubLaunchByJobId(job.id);
	const project = await store.getProject(job.projectId);
	if (!project || !hubLaunch) return null;
	for (const phase of launchResult.phases ?? []) {
		await appendLaunchPhaseProjection(store, hubLaunch.id, job.id, phase);
	}
	for (const repository of launchResult.repositories ?? []) {
		await store.upsertHubRepository(project.id, {
			teamId: project.teamId,
			role: repository.role,
			repositoryHostId: launchResult.plan?.repository?.hostId ?? null,
			provider: 'github',
			owner: repository.owner,
			name: repository.name,
			url: repository.url ?? null,
			defaultBranch: repository.defaultBranch ?? 'main',
			currentBranch: repository.defaultBranch ?? 'main',
			status: repository.url ? 'active' : 'queued',
			...hubRepositoryPolicies(repository.role),
			metadata: {
				topology: launchResult.plan?.repository?.topology ?? null,
				create: repository.create === true,
			},
		});
	}
	const contentRepository = (await store.listHubRepositories(project.id)).find((repository) => repository.role === 'content') ?? null;
	await store.upsertHubContentSource(project.id, {
		teamId: project.teamId,
		contentRepositoryId: contentRepository?.id ?? null,
		productionSource: 'r2_published_artifacts',
		overlayPolicy: 'src_content_when_present',
		r2BucketName: launchResult.cloudflare?.prod?.content?.bucketName ?? null,
		r2ManifestKey: launchResult.cloudflare?.prod?.content?.manifestKey ?? null,
		r2PublicBaseUrl: launchResult.cloudflare?.prod?.content?.publicBaseUrl ?? null,
		metadata: launchResult.plan?.contentResolution ?? {},
	});
	const mergedMetadata = {
		...(project.metadata ?? {}),
		...(launchResult.projectMetadata ?? {}),
		launchJobId: job.id,
		launchPhase: 'completed',
		lastSuccessfulPhase: 'runtime_connection',
		repositoryTopology: launchResult.plan?.repository?.topology ?? 'split_software_content',
		repositories: launchResult.repositories ?? [],
		repository: launchResult.repository,
		contentRepository: launchResult.contentRepository ?? null,
		workflows: launchResult.workflows,
		cloudflare: launchResult.cloudflare,
		railway: launchResult.railway,
		contentResolution: launchResult.plan?.contentResolution ?? null,
	};
	await store.updateProject(project.id, {
		description: project.description ?? null,
		metadata: mergedMetadata,
	});
	await store.upsertCatalogItem(project.teamId, {
		id: project.id,
		kind: 'project',
		slug: project.slug,
		title: project.name,
		summary: project.description ?? null,
		visibility: 'team',
		listingEnabled: false,
		offerMode: mergedMetadata.offerMode ?? 'free',
		searchText: [project.name, project.description].filter(Boolean).join(' ').trim() || null,
		metadata: mergedMetadata,
	});
	if (launchResult.repository) {
		await store.upsertProjectHosting(project.id, {
			kind: 'hosted_project',
			registration: 'none',
			marketBaseUrl: runtime.resolved.config.baseUrl ?? null,
			sourceRepoOwner: launchResult.repository.owner,
			sourceRepoName: launchResult.repository.name,
			sourceRepoUrl: launchResult.repository.url,
			sourceRepoWorkflowPath: '.github/workflows/deploy-web.yml',
			projectApiBaseUrl: launchResult.projectApiBaseUrl,
			executionOwner: 'project_runner',
			metadata: {
				launchPhase: 'completed',
				lastSuccessfulPhase: 'runtime_connection',
				repository: launchResult.repository,
				repositories: launchResult.repositories ?? [],
				contentResolution: launchResult.plan?.contentResolution ?? null,
			},
		});
	}
	await store.upsertProjectConnection(project.id, {
		mode: 'hosted',
		projectApiBaseUrl: launchResult.projectApiBaseUrl ?? null,
		executionOwner: 'project_runner',
		metadata: {
			internalPrefix: '/internal/core',
			launchPhase: 'completed',
			lastSuccessfulPhase: 'runtime_connection',
			repository: launchResult.repository ?? null,
			repositories: launchResult.repositories ?? [],
		},
	});
	const railwayApiService = (launchResult.railway?.services ?? []).find((service) => service.key === 'api') ?? null;
	await store.upsertProjectEnvironment(project.id, {
		environment: 'local',
		deploymentProfile: 'hosted_project',
		baseUrl: 'http://127.0.0.1:4321',
		railwayProjectName: railwayApiService?.projectName ?? null,
		metadata: {
			launchPhase: 'completed',
			projectApiBaseUrl: 'http://127.0.0.1:3000',
		},
	});
	for (const [environment, summary] of [['staging', launchResult.cloudflare?.staging], ['prod', launchResult.cloudflare?.prod]]) {
		await store.upsertProjectEnvironment(project.id, {
			environment,
			deploymentProfile: 'hosted_project',
			baseUrl: environment === 'prod' ? launchResult.projectSiteUrl : summary?.pages?.url ?? summary?.siteUrl ?? null,
			cloudflareAccountId: summary?.accountId ?? null,
			pagesProjectName: summary?.pages?.projectName ?? null,
			workerName: summary?.workerName ?? null,
			r2BucketName: summary?.content?.bucketName ?? null,
			d1DatabaseName: summary?.siteDataDb?.databaseName ?? null,
			queueName: summary?.queue?.name ?? null,
			railwayProjectName: environment === 'prod' ? railwayApiService?.projectName ?? null : null,
			metadata: {
				launchPhase: 'completed',
				projectApiBaseUrl: launchResult.projectApiBaseUrl ?? null,
				siteUrl: summary?.siteUrl ?? null,
			},
		});
	}
	for (const resource of resourceRowsFromLaunch(project.id, launchResult)) {
		await store.upsertProjectInfrastructureResource(project.id, resource);
	}
	if (railwayApiService) {
		await store.upsertAgentPool(project.id, {
			teamId: project.teamId,
			environment: 'prod',
			name: 'managed-default',
			registrationIdentity: `market:${project.id}`,
			serviceBaseUrl: railwayApiService.publicBaseUrl ?? null,
			status: 'active',
			autoscale: {
				minWorkers: Number(process.env.TREESEED_AGENT_POOL_MIN_WORKERS ?? 1),
				maxWorkers: Number(process.env.TREESEED_AGENT_POOL_MAX_WORKERS ?? 3),
				targetQueueDepth: Number(process.env.TREESEED_AGENT_POOL_TARGET_QUEUE_DEPTH ?? 3),
				cooldownSeconds: Number(process.env.TREESEED_AGENT_POOL_COOLDOWN_SECONDS ?? 120),
			},
			metadata: {
				source: 'hub_launch_worker',
				services: launchResult.railway?.services ?? [],
			},
		});
	}
	await store.updateHubLaunch(hubLaunch.id, {
		state: 'completed',
		currentPhase: 'launch_completed',
		lastSuccessfulPhase: 'launch_completed',
		result: launchResult,
		error: null,
		completedAt: new Date().toISOString(),
	});
	await store.appendHubLaunchEvent(hubLaunch.id, {
		phase: 'launch_completed',
		status: 'completed',
		title: 'Launch completed',
		summary: 'The Knowledge Hub is ready.',
		data: {
			projectApiBaseUrl: launchResult.projectApiBaseUrl ?? null,
			projectSiteUrl: launchResult.projectSiteUrl ?? null,
		},
	});
	await updateLaunchDeployments(store, job, {
		status: 'succeeded',
		finishedAt: new Date().toISOString(),
		summary: 'Initial project launch completed.',
		metadata: {
			launchPhase: 'completed',
			projectApiBaseUrl: launchResult.projectApiBaseUrl ?? null,
			projectSiteUrl: launchResult.projectSiteUrl ?? null,
		},
	});
	await store.deleteTeamInboxItemsByItemKey(project.teamId, `launch:${project.id}`);
	const projectSummary = await store.getProjectSummary(project.id, principal);
	if (projectSummary) {
		await store.upsertProjectSummarySnapshot(project.id, project.teamId, projectSummary);
	}
	return launchResult;
}

export async function applyHubLaunchFailure(store, job, input) {
	const hubLaunch = await store.getHubLaunchByJobId(job.id);
	const project = await store.getProject(job.projectId);
	if (!hubLaunch || !project) return null;
	const error = {
		code: input.code ?? 'launch_failed',
		message: input.message,
	};
	await store.updateHubLaunch(hubLaunch.id, {
		state: 'failed',
		currentPhase: hubLaunch.currentPhase ?? 'launch_failed',
		error,
	});
	await store.appendHubLaunchEvent(hubLaunch.id, {
		phase: 'launch_failed',
		status: 'failed',
		title: 'Launch failed',
		summary: input.message,
		data: { code: error.code },
	});
	await store.updateProject(project.id, {
		metadata: {
			...(project.metadata ?? {}),
			launchJobId: job.id,
			launchPhase: 'failed',
			launchFailure: error,
		},
	});
	await updateLaunchDeployments(store, job, {
		status: 'failed',
		finishedAt: new Date().toISOString(),
		summary: input.message,
		error,
		metadata: {
			launchPhase: 'failed',
			launchFailure: error,
		},
	});
	await store.upsertTeamInboxItem(project.teamId, {
		id: `launch-failure:${project.id}`,
		projectId: project.id,
		kind: 'launch_failure',
		state: 'open',
		title: `${project.name}: launch failed`,
		summary: input.message,
		severity: 'high',
		actionHref: await projectAppHref(store, project.teamId, project.slug, 'overview'),
		itemKey: `launch:${project.id}`,
		metadata: error,
	});
	return error;
}
