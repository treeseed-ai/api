import type { ProjectDeploymentEnvironment, ProjectWebDeploymentAction } from './deployment-actions.ts';

type DeploymentMutationIntent = 'create' | 'retry' | 'resume' | 'cancel';

function safeArray(value: unknown): any[] {
	return Array.isArray(value) ? value : [];
}

function hasExplicitPermission(principal: any, permission: string) {
	const permissions = safeArray(principal?.permissions).map(String);
	return permissions.includes('*:*:*')
		|| permissions.includes('project:*')
		|| permissions.includes(permission);
}

function isTeamApiPrincipal(principal: any) {
	return safeArray(principal?.roles).includes('team_api_key');
}

function deploymentActionPermission(action: ProjectWebDeploymentAction, environment: ProjectDeploymentEnvironment) {
	if (action === 'monitor') return 'project:monitor';
	if (action === 'publish_content') return environment === 'prod' ? 'project:publish:production' : 'project:publish:staging';
	return environment === 'prod' ? 'project:deploy:production' : 'project:deploy:staging';
}

function mutationPermission(intent: DeploymentMutationIntent) {
	return `project:deployment:${intent}`;
}

function capabilityAllowsAction(capabilities: string[], action: ProjectWebDeploymentAction, environment: ProjectDeploymentEnvironment) {
	if (action === 'monitor') return true;
	if (environment === 'prod') return capabilities.includes('publish_releases');
	return capabilities.includes('stage_releases') || capabilities.includes('publish_releases');
}

function capabilityAllowsMutation(capabilities: string[], deployment: any) {
	if (!deployment || deployment.action === 'monitor') {
		return deployment?.environment === 'prod'
			? capabilities.includes('publish_releases')
			: capabilities.includes('stage_releases') || capabilities.includes('publish_releases');
	}
	return capabilityAllowsAction(capabilities, deployment.action, deployment.environment);
}

export async function checkProjectDeploymentPermission(input: {
	store: any;
	principal: any;
	details: any;
	action?: ProjectWebDeploymentAction | null;
	environment?: ProjectDeploymentEnvironment | null;
	intent: 'read' | 'create' | DeploymentMutationIntent;
	deployment?: any;
}) {
	const principal = input.principal;
	const teamId = input.details?.project?.teamId ?? input.deployment?.teamId ?? null;
	const context = teamId && typeof input.store?.resolvePrincipalTeamContext === 'function'
		? await input.store.resolvePrincipalTeamContext(teamId, principal).catch(() => null)
		: null;
	const capabilities = safeArray(context?.capabilities).map(String);
	const apiKey = isTeamApiPrincipal(principal);
	if (input.intent === 'read') {
		const ok = apiKey ? hasExplicitPermission(principal, 'project:read') : Boolean(context);
		return {
			ok,
			permission: 'project:read',
			message: ok ? 'Project deployment read allowed.' : 'Project deployment read permission is required.',
		};
	}
	if (input.intent === 'create') {
		const action = input.action;
		const environment = input.environment;
		if (!action || !environment) {
			return { ok: false, permission: 'project:deploy', message: 'Deployment action and environment are required.' };
		}
		const permission = deploymentActionPermission(action, environment);
		const ok = apiKey
			? hasExplicitPermission(principal, permission)
			: Boolean(context) && capabilityAllowsAction(capabilities, action, environment);
		return {
			ok,
			permission,
			message: ok ? 'Project deployment action allowed.' : `Project deployment permission ${permission} is required.`,
		};
	}
	const permission = mutationPermission(input.intent);
	const deployment = input.deployment;
	const ok = apiKey
		? hasExplicitPermission(principal, permission)
		: Boolean(context) && capabilityAllowsMutation(capabilities, deployment);
	return {
		ok,
		permission,
		message: ok ? 'Project deployment mutation allowed.' : `Project deployment permission ${permission} is required.`,
	};
}

export function projectDeploymentAuditPayload(deployment: any, input: Record<string, unknown> = {}) {
	return {
		projectId: deployment?.projectId ?? input.projectId ?? null,
		teamId: deployment?.teamId ?? input.teamId ?? null,
		deploymentId: deployment?.id ?? input.deploymentId ?? null,
		environment: deployment?.environment ?? input.environment ?? null,
		action: deployment?.action ?? input.action ?? null,
		actorUserId: input.actorUserId ?? deployment?.requestedByUserId ?? null,
		operationId: deployment?.platformOperationId ?? input.operationId ?? null,
		status: input.status ?? deployment?.status ?? null,
		...(input.summary || deployment?.summary ? { summary: input.summary ?? deployment?.summary } : {}),
	};
}
