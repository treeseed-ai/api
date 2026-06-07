import {
	buildProjectDeploymentActionAvailability,
	buildProjectDeploymentReadiness,
	resolveRunnerDisplay,
	selectProjectWebTarget,
} from './deployment-readiness.ts';

function safeArray(value: unknown): any[] {
	return Array.isArray(value) ? value : [];
}

const ACTIVE_LAUNCH_STATUSES = new Set([
	'queued',
	'repository_provisioning',
	'content_bootstrap',
	'workflow_installing',
	'cloudflare_provisioning',
	'initial_deploy_running',
	'monitoring',
]);
const TERMINAL_LAUNCH_STATUSES = new Set(['complete', 'failed', 'cancelled']);

function text(value: unknown, fallback = ''): string {
	return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function latestByEnvironment(deployments: any[], environment: 'staging' | 'prod', action?: string) {
	return safeArray(deployments).find((deployment) => {
		if (deployment.environment !== environment) return false;
		return action ? deployment.action === action : true;
	}) ?? null;
}

function activeDeployments(deployments: any[]) {
	return safeArray(deployments).filter((deployment) => (
		deployment.action !== 'launch_project'
		&& ['queued', 'claimed', 'dispatching', 'running', 'monitoring'].includes(deployment.status)
	));
}

function hasMonitor(deployment: any) {
	return deployment?.monitor && typeof deployment.monitor === 'object' && Object.keys(deployment.monitor).length > 0;
}

function latestMonitorByEnvironment(deployments: any[], environment: 'staging' | 'prod') {
	const explicitMonitor = latestByEnvironment(deployments, environment, 'monitor');
	if (hasMonitor(explicitMonitor)) return explicitMonitor.monitor;
	return safeArray(deployments).find((deployment) => deployment.environment === environment && hasMonitor(deployment))?.monitor ?? null;
}

function launchStatusFromPhase(launch: any): string {
	if (!launch) return 'not_started';
	const state = text(launch.state ?? launch.status).toLowerCase();
	const phase = text(launch.currentPhase ?? launch.phase).toLowerCase();
	if (['complete', 'completed', 'succeeded', 'success'].includes(state)) return 'complete';
	if (['failed', 'cancelled'].includes(state)) return state;
	if (phase.includes('repository')) return 'repository_provisioning';
	if (phase.includes('content')) return 'content_bootstrap';
	if (phase.includes('workflow')) return 'workflow_installing';
	if (phase.includes('cloudflare') || phase.includes('host') || phase.includes('dns')) return 'cloudflare_provisioning';
	if (phase.includes('initial_deploy') || phase.includes('initial-deploy') || phase.includes('deploy')) return 'initial_deploy_running';
	if (phase.includes('monitor')) return 'monitoring';
	if (['queued', 'pending', 'running'].includes(state) || phase.includes('queued') || phase.includes('resume') || phase.includes('retry')) return 'queued';
	if (!state && !phase) return 'unknown';
	return state || 'unknown';
}

function launchSummary(status: string, launch: any): string {
	const errorSummary = text(launch?.error?.summary ?? launch?.error?.message);
	if (errorSummary) return errorSummary;
	if (status === 'not_started') return 'Launch records appear once project setup queues repository, workflow, or host work.';
	if (status === 'complete') return 'Project launch completed. Staging deployment is the next step when no deployment is recorded.';
	if (status === 'failed') return 'Project launch failed. Retry or resume the launch from the existing launch job.';
	if (status === 'cancelled') return 'Project launch was cancelled. Retry or resume when the setup should continue.';
	if (ACTIVE_LAUNCH_STATUSES.has(status)) return 'Project setup is preparing repository, workflow, or host resources.';
	return 'Latest project launch activity is recorded.';
}

function normalizeLaunchEvent(event: any, index: number) {
	const status = text(event?.status, 'recorded');
	return {
		id: text(event?.id, `launch-event-${index}`),
		sequence: Number(event?.seq ?? event?.sequence ?? index + 1),
		phase: text(event?.phase, text(event?.kind, 'launch_event')),
		status,
		title: text(event?.title, text(event?.kind, 'Launch event').replace(/[._-]+/gu, ' ')),
		summary: text(event?.summary ?? event?.message, 'Launch event recorded.'),
		error: event?.error && typeof event.error === 'object'
			? {
				code: text(event.error.code, 'launch_error'),
				message: text(event.error.summary ?? event.error.message, 'Launch event failed.'),
			}
			: null,
		createdAt: event?.createdAt ?? event?.timestamp ?? null,
		startedAt: event?.startedAt ?? null,
		finishedAt: event?.finishedAt ?? null,
	};
}

function buildLaunchRecoveryActions(status: string, launch: any, job: any) {
	if (!launch?.jobId || !['failed', 'cancelled'].includes(status) || !['failed', 'cancelled'].includes(job?.status)) {
		return [];
	}
	const jobId = encodeURIComponent(launch.jobId);
	return [
		{
			action: 'retry_launch',
			label: 'Retry launch',
			method: 'POST',
			url: `/v1/jobs/${jobId}/retry`,
			description: 'Queue the original launch job again.',
		},
		{
			action: 'resume_launch',
			label: 'Resume launch',
			method: 'POST',
			url: `/v1/jobs/${jobId}/resume`,
			description: 'Resume from the latest durable launch phase when possible.',
		},
	];
}

function normalizeLaunch(launch: any, events: any[], job: any, projectId: string, deploymentId: string | null = null) {
	if (!launch) {
		return {
			id: null,
			jobId: null,
			status: 'not_started',
			rawState: null,
			currentPhase: null,
			summary: launchSummary('not_started', null),
			active: false,
			terminal: false,
			deployHref: `/app/projects/${encodeURIComponent(projectId)}/deploy`,
			actions: [],
			inspect: null,
			error: null,
			events: [],
			createdAt: null,
			updatedAt: null,
			completedAt: null,
		};
	}
	const status = launchStatusFromPhase(launch);
	const error = launch.error && typeof launch.error === 'object'
		? {
			code: text(launch.error.code, 'launch_failed'),
			summary: text(launch.error.summary ?? launch.error.message, 'Project launch failed.'),
			provider: text(launch.error.provider, ''),
			inspectCommand: text(launch.error.inspectCommand ?? launch.error.command, ''),
		}
		: null;
	return {
		id: launch.id,
		jobId: launch.jobId ?? null,
		status,
		rawState: launch.state ?? null,
		currentPhase: launch.currentPhase ?? null,
		lastSuccessfulPhase: launch.lastSuccessfulPhase ?? null,
		summary: launchSummary(status, launch),
		active: ACTIVE_LAUNCH_STATUSES.has(status),
		terminal: TERMINAL_LAUNCH_STATUSES.has(status),
		deployHref: deploymentId
			? `/app/projects/deployment/${encodeURIComponent(deploymentId)}`
			: `/app/projects/${encodeURIComponent(projectId)}/deploy?launch=${encodeURIComponent(launch.id)}`,
		actions: buildLaunchRecoveryActions(status, launch, job),
		inspect: error ? {
			summary: error.summary,
			command: error.inspectCommand || null,
		} : null,
		error,
		events: safeArray(events).map(normalizeLaunchEvent).slice(-10),
		createdAt: launch.createdAt ?? null,
		updatedAt: launch.updatedAt ?? null,
		completedAt: launch.completedAt ?? null,
	};
}

function firstDeployGuidance(input: { launch: any; activeOperations: any[]; deployments: any[]; readiness: any }) {
	const activeDeployment = safeArray(input.activeOperations)[0] ?? null;
	if (activeDeployment) {
		return {
			code: 'deployment_active',
			label: 'Deployment in progress',
			description: activeDeployment.summary ?? 'Follow the active deployment timeline.',
			action: null,
			environment: activeDeployment.environment ?? null,
		};
	}
	if (input.launch?.status === 'failed' || input.launch?.status === 'cancelled') {
		return {
			code: 'launch_recovery',
			label: input.launch.status === 'failed' ? 'Launch failed' : 'Launch cancelled',
			description: input.launch.summary,
			action: input.launch.actions?.[0]?.action ?? null,
			environment: null,
		};
	}
	if (input.launch?.active) {
		return {
			code: 'launch_active',
			label: 'Launch in progress',
			description: input.launch.summary,
			action: null,
			environment: null,
		};
	}
	const hasStagingDeployment = safeArray(input.deployments).some((deployment) => deployment.environment === 'staging' && deployment.action === 'deploy_web');
	if (input.launch?.status === 'complete' && !hasStagingDeployment) {
		return {
			code: 'deploy_staging',
			label: 'Deploy staging',
			description: input.readiness?.ready ? 'Launch is complete. Queue the first staging deployment.' : 'Launch is complete. Resolve readiness blockers before the first staging deployment.',
			action: 'deploy_web',
			environment: 'staging',
		};
	}
	return {
		code: 'deployment_ready',
		label: input.readiness?.ready ? 'Deployment ready' : 'Resolve blockers',
		description: input.readiness?.ready ? 'Queue staging, production, publish, or monitor work from the environment cards.' : 'Readiness blockers must be resolved before deployment actions can run.',
		action: input.readiness?.ready ? 'deploy_web' : null,
		environment: input.readiness?.ready ? 'staging' : null,
	};
}

export async function buildProjectDeploymentState(input: {
	store: any;
	projectId: string;
	details?: any;
}) {
	const store = input.store;
	const details = input.details ?? await store.getProjectDetails(input.projectId);
	if (!details) return null;
	const teamId = details.project.teamId;
	const [teamWebHosts, runners, deployments, launchJob] = await Promise.all([
		store.listTeamWebHosts?.(teamId).catch?.(() => []) ?? [],
		store.listMarketOperationRunners?.({ limit: 10 }).catch?.(() => []) ?? [],
		store.listProjectDeployments(input.projectId, { limit: 100 }),
		details.latestLaunch?.jobId && store.findJobById ? store.findJobById(details.latestLaunch.jobId).catch(() => null) : null,
	]);
	const activeOperations = activeDeployments(deployments);
	const readiness = buildProjectDeploymentReadiness({
		details,
		teamWebHosts,
		activeOperations,
		runners,
	});
	const actions = buildProjectDeploymentActionAvailability({
		details,
		teamWebHosts,
		activeOperations,
		runners,
	});
	const launchDeployment = safeArray(deployments).find((deployment) => (
		deployment.action === 'launch_project'
		&& deployment.environment === 'staging'
		&& (!details.latestLaunch?.jobId || deployment.platformOperationId === details.latestLaunch.jobId)
	)) ?? safeArray(deployments).find((deployment) => (
		deployment.action === 'launch_project'
		&& (!details.latestLaunch?.jobId || deployment.platformOperationId === details.latestLaunch.jobId)
	)) ?? null;
	const launch = normalizeLaunch(details.latestLaunch, details.latestLaunchEvents, launchJob, input.projectId, launchDeployment?.id ?? null);
	return {
		ok: true,
		project: details.project,
		launch,
		environments: safeArray(details.environments),
		repositories: safeArray(details.repositories),
		hosts: teamWebHosts.map((host: any) => ({
			id: host.id,
			provider: host.provider,
			ownership: host.ownership,
			name: host.name,
			status: host.status,
		})),
		runner: resolveRunnerDisplay(runners),
		latestDeployments: {
			staging: latestByEnvironment(deployments, 'staging'),
			prod: latestByEnvironment(deployments, 'prod'),
			},
			latestMonitors: {
				staging: latestMonitorByEnvironment(deployments, 'staging'),
				prod: latestMonitorByEnvironment(deployments, 'prod'),
			},
		activeOperations,
		recentDeployments: deployments.slice(0, 25),
		readiness: {
			ready: readiness.ready,
			blockers: readiness.blockers,
			checks: readiness.checks,
		},
		actions,
		target: selectProjectWebTarget(details, teamWebHosts),
		nextAction: firstDeployGuidance({ launch, activeOperations, deployments, readiness }),
	};
}
