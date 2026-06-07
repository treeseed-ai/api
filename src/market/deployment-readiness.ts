import {
	PROJECT_DEPLOYMENT_ENVIRONMENTS,
	PROJECT_WEB_DEPLOYMENT_ACTIONS,
	type ProjectDeploymentEnvironment,
	type ProjectWebDeploymentAction,
} from './deployment-actions.ts';

function safeArray(value: unknown): any[] {
	return Array.isArray(value) ? value : [];
}

export function selectProjectDeploymentRepository(details: any, action?: ProjectWebDeploymentAction | null) {
	const repositories = safeArray(details?.repositories);
	if (action === 'publish_content') {
		return repositories.find((repository) => repository?.role === 'content' && (repository?.provider === 'treedx' || repository?.metadata?.contentCanonical === 'treedx'))
			?? repositories.find((repository) => repository?.role === 'content')
			?? repositories.find((repository) => repository?.provider === 'treedx')
			?? repositories.find((repository) => repository?.provider === 'github')
			?? repositories[0]
			?? null;
	}
	return repositories.find((repository) => ['software', 'primary', 'package'].includes(repository?.role))
		?? repositories.find((repository) => repository?.provider === 'github')
		?? repositories[0]
		?? null;
}

function repositoryReadyForAction(repository: any, action?: ProjectWebDeploymentAction) {
	if (action === 'publish_content' && (repository?.provider === 'treedx' || repository?.metadata?.contentCanonical === 'treedx')) return true;
	return Boolean(repository?.provider === 'github' && repository?.owner && repository?.name);
}

function workflowReadyForAction(repository: any, action?: ProjectWebDeploymentAction) {
	if (action === 'publish_content' && (repository?.provider === 'treedx' || repository?.metadata?.contentCanonical === 'treedx')) return true;
	return Boolean(repository?.provider === 'github');
}

export function selectProjectWebTarget(details: any, teamWebHosts: any[] = []) {
	const environments = safeArray(details?.environments);
	const staging = environments.find((environment) => environment?.environment === 'staging') ?? environments[0] ?? null;
	const configuredHost = safeArray(teamWebHosts).find((host) => host?.status !== 'deleted') ?? null;
	const cloudflareHost = details?.project?.metadata?.cloudflareHost && typeof details.project.metadata.cloudflareHost === 'object'
		? details.project.metadata.cloudflareHost
		: null;
	return {
		provider: staging?.deploymentProfile === 'hosted_project' || configuredHost || cloudflareHost ? 'cloudflare' : null,
		hostId: cloudflareHost?.hostId ?? configuredHost?.id ?? null,
		url: staging?.baseUrl ?? null,
		previewUrl: null,
		pagesProjectName: staging?.pagesProjectName ?? null,
		workerName: staging?.workerName ?? null,
	};
}

export function resolveRunnerDisplay(runners: any[] = []) {
	const latest = safeArray(runners)[0] ?? null;
	if (!latest) {
		return { status: 'unknown', lastHeartbeatAt: null, capabilities: [], activeJobCount: null };
	}
	const heartbeatMs = latest.heartbeatAt ? new Date(latest.heartbeatAt).getTime() : 0;
	const stale = !heartbeatMs || Date.now() - heartbeatMs > 5 * 60 * 1000;
	return {
		status: stale ? 'stale' : latest.status === 'online' ? 'online' : latest.status ?? 'unknown',
		lastHeartbeatAt: latest.heartbeatAt ?? null,
		capabilities: safeArray(latest.capabilities).map(String),
		activeJobCount: Number.isFinite(Number(latest.activeJobCount)) ? Number(latest.activeJobCount) : null,
	};
}

export function buildProjectDeploymentReadiness(input: {
	details: any;
	teamWebHosts?: any[];
	activeOperations?: any[];
	runners?: any[];
	environment?: ProjectDeploymentEnvironment;
	action?: ProjectWebDeploymentAction;
	confirmProduction?: boolean;
}) {
	const details = input.details;
	const repository = selectProjectDeploymentRepository(details, input.action);
	const target = selectProjectWebTarget(details, input.teamWebHosts ?? []);
	const environments = safeArray(details?.environments);
	const runner = resolveRunnerDisplay(input.runners ?? []);
	const activeConflict = safeArray(input.activeOperations).find((deployment) => {
		if (input.environment && deployment.environment !== input.environment) return false;
		if (input.action && deployment.action !== input.action) return false;
		return true;
	});
	const checks = [
		{
			code: 'project_exists',
			label: 'Project exists',
			ready: Boolean(details?.project?.id),
			message: details?.project?.id ? 'Project record is available.' : 'Project was not found.',
		},
		{
			code: 'repository_configured',
			label: input.action === 'publish_content' ? 'Content repository configured' : 'GitHub repository configured',
			ready: repositoryReadyForAction(repository, input.action),
			message: repository ? 'Repository record is available.' : 'Repository records appear after launch completes.',
			href: details?.project?.id ? `/app/projects/${encodeURIComponent(details.project.id)}/hosts` : undefined,
		},
		{
			code: 'workflow_installable',
			label: input.action === 'publish_content' ? 'Publish executor available' : 'Deploy workflow installable',
			ready: workflowReadyForAction(repository, input.action),
			message: input.action === 'publish_content' && (repository?.provider === 'treedx' || repository?.metadata?.contentCanonical === 'treedx')
				? 'TreeDX content publish can run through the Market operations runner.'
				: repository?.provider === 'github' ? 'The deploy workflow can be dispatched for this repository.' : 'A GitHub repository is required.',
		},
		{
			code: 'web_host_configured',
			label: 'Web host configured',
			ready: Boolean(target.provider || target.url || target.pagesProjectName || target.workerName),
			message: target.provider || target.url || target.pagesProjectName || target.workerName ? 'Web host target is known.' : 'Configure a web host before deployment.',
			href: '/app/hosts',
		},
		{
			code: 'staging_environment',
			label: 'Staging environment',
			ready: environments.some((environment) => environment?.environment === 'staging'),
			message: environments.some((environment) => environment?.environment === 'staging') ? 'Staging environment exists.' : 'Staging environment will be initialized by launch or repair.',
		},
		{
			code: 'production_environment',
			label: 'Production environment',
			ready: environments.some((environment) => environment?.environment === 'prod') || input.environment !== 'prod',
			message: environments.some((environment) => environment?.environment === 'prod') ? 'Production environment exists.' : 'Production can be initialized after staging is ready.',
		},
		{
			code: 'runner_ready',
			label: 'Market operations runner',
			ready: runner.status === 'online' || runner.status === 'unknown',
			message: runner.status === 'online' ? 'Market operations runner is online.' : 'Queued operations can wait for the Market operations runner.',
		},
		{
			code: 'no_active_operation',
			label: 'No conflicting operation',
			ready: !activeConflict,
			message: activeConflict ? 'A deployment operation is already active for this target.' : 'No conflicting deployment operation is active.',
		},
		{
			code: 'production_confirmation',
			label: 'Production confirmation',
			ready: input.environment !== 'prod' || input.action === 'monitor' || input.confirmProduction === true,
			message: input.environment === 'prod' && input.action !== 'monitor' ? 'Production deploy and publish require explicit confirmation.' : 'Staging and monitor actions do not require production confirmation.',
		},
	];
	const blockers = checks
		.filter((check) => !check.ready && !['production_environment', 'runner_ready'].includes(check.code))
		.map(({ code, message, href }) => ({ code, message, ...(href ? { href } : {}) }));
	return {
		ready: blockers.length === 0,
		blockers,
		checks,
		repository,
		target,
		runner,
	};
}

export function buildProjectDeploymentActionAvailability(input: {
	details: any;
	teamWebHosts?: any[];
	activeOperations?: any[];
	runners?: any[];
}) {
	return PROJECT_DEPLOYMENT_ENVIRONMENTS.flatMap((environment) => PROJECT_WEB_DEPLOYMENT_ACTIONS.map((action) => {
		const readiness = buildProjectDeploymentReadiness({
			...input,
			environment,
			action,
			confirmProduction: environment !== 'prod',
		});
		const blockedBy = readiness.blockers
			.filter((blocker) => blocker.code !== 'production_confirmation')
			.map((blocker) => ({
				code: blocker.code === 'repository_configured' ? 'missing_repository'
					: blocker.code === 'web_host_configured' ? 'missing_web_host'
						: blocker.code === 'no_active_operation' ? 'active_operation'
							: blocker.code,
				message: blocker.message,
				...(blocker.href ? { href: blocker.href } : {}),
			}));
		if (environment === 'prod' && action !== 'monitor') {
			blockedBy.push({
				code: 'production_confirmation_required',
				message: 'Production deploy and publish require explicit confirmation.',
			});
		}
		return {
			environment,
			action,
			available: blockedBy.length === 0,
			blockedBy,
		};
	}));
}
