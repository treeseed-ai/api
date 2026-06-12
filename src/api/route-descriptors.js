import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appSourcePath = resolve(here, 'app.js');
const projectDeploymentRoutesSourcePath = resolve(here, 'project-deployment-routes.js');

export const SDK_METHOD_ROUTE_MAP = {
	startDeviceLogin: 'post.v1.auth.device.start',
	pollDeviceLogin: 'post.v1.auth.device.poll',
	refreshToken: 'post.v1.auth.token.refresh',
	logout: 'post.v1.auth.logout',
	webSignUp: 'post.v1.auth.web.sign-up',
	confirmWebEmail: 'post.v1.auth.web.confirm-email',
	webSignIn: 'post.v1.auth.web.sign-in',
	checkWebUsername: 'get.v1.auth.web.username.check',
	webEmails: 'get.v1.auth.web.emails',
	addWebEmail: 'post.v1.auth.web.emails',
	verifyWebEmail: 'post.v1.auth.web.emails.emailId.verify',
	setPrimaryWebEmail: 'post.v1.auth.web.emails.emailId.primary',
	deleteWebEmail: 'delete.v1.auth.web.emails.emailId',
	webSessions: 'get.v1.auth.web.sessions',
	revokeWebSession: 'post.v1.auth.web.sessions.sessionId.revoke',
	updateWebProfile: 'patch.v1.auth.web.profile',
	webAppearance: 'get.v1.auth.web.appearance',
	updateWebAppearance: 'patch.v1.auth.web.appearance',
	updateWebEmail: 'patch.v1.auth.web.email',
	updateWebPassword: 'patch.v1.auth.web.password',
	requestWebPasswordReset: 'post.v1.auth.web.password-reset.request',
	completeWebPasswordReset: 'post.v1.auth.web.password-reset.complete',
	accountDeletionBlockers: 'get.v1.auth.web.account.deletion-blockers',
	deleteAccount: 'delete.v1.auth.web.account',
	me: 'get.v1.me',
	markets: 'get.v1.me.markets',
	currentMarket: 'get.v1.markets.current',
	teams: 'get.v1.teams',
	teamMembers: 'get.v1.teams.teamId.members',
	teamPermissions: 'get.v1.teams.teamId.permissions',
	projects: 'get.v1.projects',
	projectAccess: 'get.v1.projects.projectId.access',
	projectDeploymentState: 'get.v1.projects.projectId.deployment-state',
	projectHosts: 'get.v1.projects.projectId.hosts',
	auditProjectHosts: 'post.v1.projects.projectId.hosts.audit',
	replaceProjectHost: 'post.v1.projects.projectId.hosts.requirementKey.replace',
	resyncProjectHost: 'post.v1.projects.projectId.hosts.requirementKey.resync',
	rotateProjectHost: 'post.v1.projects.projectId.hosts.requirementKey.rotate',
	projectDeploymentById: 'get.v1.project-deployments.deploymentId',
	projectDeployments: 'get.v1.projects.projectId.deployments',
	projectDeployment: 'get.v1.projects.projectId.deployments.deploymentId',
	projectDeploymentEvents: 'get.v1.projects.projectId.deployments.deploymentId.events',
	createProjectWebDeployment: 'post.v1.projects.projectId.deployments.web',
	retryProjectDeployment: 'post.v1.projects.projectId.deployments.deploymentId.retry',
	resumeProjectDeployment: 'post.v1.projects.projectId.deployments.deploymentId.resume',
	cancelProjectDeployment: 'post.v1.projects.projectId.deployments.deploymentId.cancel',
	teamCapacity: 'get.v1.teams.teamId.capacity',
	teamCapacityProviders: 'get.v1.teams.teamId.capacity-providers',
	updateCapacityProvider: 'patch.v1.teams.teamId.capacity-providers.providerId',
	launchManagedCapacityProvider: 'post.v1.teams.teamId.capacity.providers.managed',
	capacityProvider: 'get.v1.capacity.providers.providerId',
	rotateCapacityProviderApiKey: 'post.v1.teams.teamId.capacity-providers.providerId.keys.rotate',
	capacityGrants: 'get.v1.teams.teamId.capacity-grants',
	createCapacityGrant: 'post.v1.teams.teamId.capacity-grants',
	executionProviders: 'get.v1.teams.teamId.capacity-providers.providerId.execution-providers',
	createExecutionProvider: 'post.v1.teams.teamId.capacity-providers.providerId.execution-providers',
	updateExecutionProvider: 'patch.v1.teams.teamId.capacity-providers.providerId.execution-providers.executionProviderId',
	createExecutionProviderNativeLimit: 'post.v1.teams.teamId.capacity-providers.providerId.execution-providers.executionProviderId.native-limits',
	projectCapacityPlan: 'get.v1.projects.projectId.capacity-plan',
	teamTreeDx: 'get.v1.teams.teamId.treedx',
	updateTeamTreeDx: 'put.v1.teams.teamId.treedx',
	provisionTeamTreeDx: 'post.v1.teams.teamId.treedx.provision',
	treeDxMirrors: 'get.v1.teams.teamId.treedx.mirrors',
	createTreeDxMirror: 'post.v1.teams.teamId.treedx.mirrors',
	syncTreeDxMirror: 'post.v1.teams.teamId.treedx.mirrors.mirrorId.sync',
	treeDxShares: 'get.v1.teams.teamId.treedx.shares',
	createTreeDxShare: 'post.v1.teams.teamId.treedx.shares',
	projectTreeDxLibrary: 'get.v1.projects.projectId.treedx-library',
	upsertProjectTreeDxLibrary: 'post.v1.projects.projectId.treedx-library',
	projectRepositoryTopology: 'get.v1.projects.projectId.repository-topology',
	updateProjectRepositoryTopology: 'put.v1.projects.projectId.repository-topology',
	planSeed: 'post.v1.seeds.name.plan',
	applySeed: 'post.v1.seeds.name.apply',
	listSeedRuns: 'get.v1.seeds.runs',
	exportSeed: 'post.v1.teams.teamId.seeds.export',
	enqueueAgentTask: 'post.v1.projects.projectId.agent-tasks',
	catalog: 'get.v1.catalog',
	artifactDownload: 'get.v1.catalog.itemId.artifacts.version.download',
};

export const ACCEPTANCE_ACTORS = [
	'anonymous',
	'siteAdmin',
	'marketSteward',
	'teamOwner',
	'teamOperator',
	'teamViewer',
	'nonMember',
	'providerOperator',
	'providerKey',
	'platformRunner',
];

export const TEAM_MEMBER_ACTORS = ['siteAdmin', 'marketSteward', 'teamOwner', 'teamOperator', 'teamViewer', 'providerOperator'];
export const TEAM_MANAGER_ACTORS = ['siteAdmin', 'marketSteward', 'teamOwner'];
export const PROJECT_MEMBER_ACTORS = ['siteAdmin', 'marketSteward', 'teamOwner', 'teamOperator', 'teamViewer', 'providerOperator'];
export const PROJECT_MANAGER_ACTORS = ['siteAdmin', 'marketSteward', 'teamOwner', 'teamOperator', 'teamViewer'];
export const PLATFORM_ADMIN_ACTORS = ['siteAdmin', 'marketSteward'];

function routeId(method, path) {
	return [
		method.toLowerCase(),
		...path
			.replace(/^\/+/u, '')
			.split('/')
			.filter(Boolean)
			.map((part) => part.startsWith(':') ? part.slice(1) : part)
			.map((part) => part.replace(/[^a-zA-Z0-9]+/gu, '-').replace(/^-+|-+$/gu, ''))
			.filter(Boolean),
	].join('.');
}

function ownerDomain(path) {
	if (path.startsWith('/v1/provider/')) return 'provider-ingress';
	if (path.startsWith('/v1/platform/runners/')) return 'platform-runner';
	if (path.startsWith('/v1/platform/operations')) return 'platform-operation';
	if (path.startsWith('/v1/ui/')) return 'market-ui';
	if (path.startsWith('/v1/auth/')) return 'auth';
	if (path.startsWith('/v1/teams/')) return 'team';
	if (path.startsWith('/v1/projects/')) return 'project';
	if (path.startsWith('/v1/capacity/') || path.includes('/capacity-')) return 'capacity';
	if (path.startsWith('/v1/catalog')) return 'catalog';
	if (path.startsWith('/v1/seeds/')) return 'seed';
	if (path.startsWith('/v1/acceptance/')) return 'acceptance';
	if (path.startsWith('/v1/me') || path.startsWith('/v1/markets/')) return 'identity';
	return 'market';
}

function authClass(path) {
	if (path.startsWith('/v1/provider/')) return 'provider-key';
	if (path.startsWith('/v1/platform/runners/')) return 'platform-runner';
	if (path.startsWith('/v1/acceptance/')) return 'acceptance-service';
	if (path === '/v1/markets/current' || path.startsWith('/v1/auth/web/sign-') || path.includes('/username/check') || path.includes('/password-reset/') || path.includes('/auth/device/')) {
		return 'public';
	}
	if (path.startsWith('/v1/platform/operations')) return 'platform-admin';
	if (path.startsWith('/v1/ui/')) return 'user';
	if (path.startsWith('/v1/teams/:teamId')) return 'team-member';
	if (path.startsWith('/v1/projects/:projectId')) return 'project-member';
	return 'user';
}

function mutability(method) {
	if (method === 'get') return 'read';
	if (method === 'delete') return 'destructive';
	return 'write';
}

function fixtureRequirements(path) {
	const required = [];
	for (const match of path.matchAll(/:([A-Za-z0-9_]+)/gu)) {
		required.push(match[1]);
	}
	return required;
}

function safeProduction(path, method) {
	if (method === 'get') return true;
	if (path.startsWith('/v1/auth/web/appearance') || path.startsWith('/v1/auth/web/sessions')) return true;
	if (path.startsWith('/v1/acceptance/')) return true;
	return false;
}

function routeNeedsManagement(path, method) {
	if (method === 'get') return false;
	return /\/members\/|\/invites|\/api-keys|\/repository-hosts|\/web-hosts|\/hosts|\/capacity-providers|\/capacity-grants|\/provider-credential-sessions|\/projects\/launch|\/treedx/u.test(path);
}

function successActorsFor(path, method) {
	if (path.startsWith('/v1/provider/')) return ['providerKey'];
	if (path.startsWith('/v1/platform/runners/')) return ['platformRunner'];
	if (path.startsWith('/v1/acceptance/')) return [];
	if (path.startsWith('/v1/platform/operations/:operationId')) return ['siteAdmin', 'marketSteward', 'teamOwner', 'teamOperator', 'teamViewer', 'nonMember', 'providerOperator'];
	if (path === '/v1/platform/operations' && method !== 'get') return ['siteAdmin', 'marketSteward', 'teamOwner', 'teamOperator', 'teamViewer', 'nonMember', 'providerOperator'];
	if (path.startsWith('/v1/platform/operations')) return PLATFORM_ADMIN_ACTORS;
	if (path === '/v1/markets/current' || path.includes('/username/check') || path.includes('/confirm-email') || path.includes('/password-reset/request') || path.includes('/password-reset/complete') || path.includes('/auth/device/')) {
		return ACCEPTANCE_ACTORS;
	}
	if (path.startsWith('/v1/auth/web/sign-up')) return ACCEPTANCE_ACTORS;
	if (path.startsWith('/v1/auth/web/sign-') || path.startsWith('/v1/auth/oauth/')) return ['anonymous'];
	if (path.startsWith('/v1/auth/')) return ['siteAdmin', 'marketSteward', 'teamOwner', 'teamOperator', 'teamViewer', 'nonMember', 'providerOperator'];
	if (path.startsWith('/v1/teams/:teamId')) return routeNeedsManagement(path, method) ? TEAM_MANAGER_ACTORS : TEAM_MEMBER_ACTORS;
	if (path.startsWith('/v1/projects/:projectId') && path.includes('/workday-policy') && method !== 'get') {
		return ['siteAdmin', 'marketSteward', 'teamOwner', 'teamOperator', 'teamViewer'];
	}
	if (path.startsWith('/v1/projects/:projectId')) return method === 'get' ? PROJECT_MEMBER_ACTORS : PROJECT_MANAGER_ACTORS;
	if (path.startsWith('/v1/teams')) return method === 'get'
		? ['siteAdmin', 'marketSteward', 'teamOwner', 'teamOperator', 'teamViewer', 'nonMember', 'providerOperator']
		: ['siteAdmin', 'marketSteward', 'teamOwner', 'teamOperator', 'teamViewer', 'nonMember', 'providerOperator'];
	if (path.startsWith('/v1/capacity/providers/:providerId/heartbeat')) return ['providerKey'];
	if (path.startsWith('/v1/capacity/')) return method === 'get' ? TEAM_MEMBER_ACTORS : TEAM_MANAGER_ACTORS;
	if (path.startsWith('/v1/catalog') || path.startsWith('/v1/templates') || path.startsWith('/v1/knowledge-packs')) return ACCEPTANCE_ACTORS;
	if (path.startsWith('/v1/seeds/') && method === 'get') return ['siteAdmin', 'marketSteward', 'teamOwner', 'teamOperator', 'teamViewer', 'nonMember', 'providerOperator'];
	if (path.startsWith('/v1/seeds/')) return ['siteAdmin', 'marketSteward'];
	return ['siteAdmin', 'marketSteward', 'teamOwner', 'teamOperator', 'teamViewer', 'nonMember', 'providerOperator'];
}

function productionSafeStrategy(path, method) {
	if (method === 'get') return 'read';
	if (path.startsWith('/v1/auth/web/appearance') || path.startsWith('/v1/auth/logout') || path.startsWith('/v1/auth/web/sessions/')) return 'acceptance-owned';
	if (path.startsWith('/v1/platform/runners/') || path.startsWith('/v1/provider/')) return 'acceptance-owned';
	if (path.startsWith('/v1/acceptance/')) return 'acceptance-service';
	return 'acceptance-owned-fixture';
}

function bodyFactoryFor(path, method) {
	if (method === 'get') return null;
	if (path.includes('/auth/device/start')) return 'deviceStart';
	if (path.includes('/auth/device/poll')) return 'devicePoll';
	if (path.includes('/auth/device/approve')) return 'deviceApprove';
	if (path.includes('/auth/web/sign-up')) return 'webSignUp';
	if (path.includes('/auth/web/confirm-email')) return 'emailConfirm';
	if (path.includes('/auth/web/sign-in')) return 'webSignIn';
	if (path.includes('/auth/web/sessions/')) return 'sessionRevoke';
	if (path.includes('/auth/web/profile')) return 'webProfile';
	if (path.includes('/auth/web/appearance')) return 'webAppearance';
	if (path.includes('/auth/web/email')) return 'webEmail';
	if (path.includes('/auth/web/password-reset/request')) return 'passwordResetRequest';
	if (path.includes('/auth/web/password-reset/complete')) return 'passwordResetComplete';
	if (path.includes('/auth/web/password')) return 'webPassword';
	if (path.includes('/auth/token/refresh')) return 'refreshToken';
	if (path.startsWith('/v1/ui/governance/') && path.endsWith('/decision')) return 'approvalDecision';
	if (path.includes('/platform/operations') && path.endsWith('/cancel')) return 'platformOperationCancel';
	if (path.includes('/platform/operations') && path.endsWith('/retry')) return 'platformOperationRetry';
	if (path === '/v1/platform/operations') return 'platformOperationCreate';
	if (path.includes('/platform/runners/register')) return 'platformRunnerRegister';
	if (path.includes('/platform/runners/heartbeat')) return 'platformRunnerHeartbeat';
	if (path.includes('/platform/runners/jobs/claim')) return 'platformRunnerClaim';
	if (path.includes('/platform/runners/jobs/') && path.endsWith('/events')) return 'platformRunnerEvent';
	if (path.includes('/platform/runners/jobs/') && path.endsWith('/checkpoint')) return 'platformRunnerCheckpoint';
	if (path.includes('/platform/runners/jobs/') && path.endsWith('/renew-lease')) return 'platformRunnerRenew';
	if (path.includes('/platform/runners/jobs/') && path.endsWith('/cancel')) return 'platformRunnerCancel';
	if (path.includes('/platform/runners/jobs/') && path.endsWith('/complete')) return 'platformRunnerComplete';
	if (path.includes('/platform/runners/jobs/') && path.endsWith('/fail')) return 'platformRunnerFail';
	if (path.includes('/provider/register')) return 'providerRegister';
	if (path.includes('/provider/heartbeat')) return 'providerHeartbeat';
	if (path.includes('/provider/workdays')) return 'providerWorkday';
	if (path.includes('/provider/tasks/claim')) return 'providerTaskClaim';
	if (path.includes('/provider/tasks/') && path.endsWith('/events')) return 'providerTaskEvent';
	if (path.includes('/provider/tasks/') && path.endsWith('/complete')) return 'providerTaskComplete';
	if (path.includes('/provider/tasks/') && path.endsWith('/fail')) return 'providerTaskFail';
	if (path.includes('/provider/usage')) return 'providerUsage';
	if (path.includes('/provider/reports')) return 'providerReport';
	if (path.includes('/teams') && path.endsWith('/projects')) return 'projectCreate';
	if (path.includes('/teams') && path.endsWith('/projects/launch')) return 'projectLaunch';
	if (path.includes('/teams') && path.endsWith('/invites')) return 'teamInvite';
	if (path.includes('/teams') && path.includes('/members/')) return method === 'delete' ? 'empty' : 'teamMemberUpdate';
	if (path.includes('/teams') && path.includes('/repository-hosts')) return method === 'delete' ? 'empty' : 'repositoryHost';
	if (path.includes('/teams') && (path.includes('/web-hosts') || path.includes('/hosts'))) return method === 'delete' ? 'empty' : path.endsWith('/validate') ? 'hostValidate' : 'webHost';
	if (path.includes('/teams') && path.includes('/capacity-providers') && path.endsWith('/deployments')) return 'capacityProviderDeployment';
	if (path.includes('/teams') && path.includes('/capacity-providers') && path.endsWith('/keys/rotate')) return 'empty';
	if (path.includes('/teams') && path.includes('/capacity-providers') && path.endsWith('/native-limits')) return 'executionProviderNativeLimit';
	if (path.includes('/teams') && path.includes('/capacity-providers') && path.includes('/execution-providers')) return 'executionProvider';
	if (path.includes('/teams') && path.includes('/capacity-providers')) return method === 'patch' ? 'capacityProviderPatch' : 'capacityProviderCreate';
	if (path.includes('/teams') && path.includes('/capacity-grants')) return 'capacityGrant';
	if (path.includes('/teams') && path.includes('/provider-credential-sessions')) return 'providerCredentialSession';
	if (path.includes('/teams') && path.includes('/hosting-audit')) return 'hostingAudit';
	if (path.includes('/teams') && path.includes('/seeds/export')) return 'seedExport';
	if (path === '/v1/teams') return 'teamCreate';
	if (path.startsWith('/v1/project-deployments/')) return 'projectDeployment';
	if (path.startsWith('/v1/projects/:projectId')) return path.endsWith('/local-content/:collection') ? 'localContentWrite'
		: path.endsWith('/related') ? 'localContentRelated'
			: path.endsWith('/decisions/from-proposals') ? 'decisionFromProposals'
				: path.includes('/approval') ? 'approvalDecision'
					: path.includes('/runner/') ? 'runnerProjectBody'
						: path.includes('/work-policy') || path.includes('/workday-policy') ? 'workPolicy'
							: path.includes('/priority-overrides') ? 'priorityOverride'
								: path.includes('/agent-tasks') ? 'agentTask'
									: path.includes('/deployments') ? 'projectDeployment'
										: path.includes('/resources') ? 'projectResource'
											: path.includes('/hosting') || path.includes('/environments') ? 'projectEnvironment'
												: path.includes('/workspace-links') ? 'workspaceLink'
													: path.includes('/update-plans') ? 'updatePlan'
														: path.includes('/share') ? 'shareOperation'
															: path.includes('/releases') ? 'releaseOperation'
																: path.includes('/workstreams') ? 'workstreamOperation'
																	: path.includes('/capabilities') ? 'capability'
																		: 'projectUpdate';
	if (path.startsWith('/v1/jobs/')) return 'jobOperation';
	if (path.startsWith('/v1/approval-requests/')) return 'approvalDecision';
	if (path.startsWith('/v1/seeds/')) return 'seedPlan';
	return 'empty';
}

function acceptancePolicy(path, method) {
	const successActors = successActorsFor(path, method);
	return {
		bodyFactory: bodyFactoryFor(path, method),
		successActors,
		denyActors: ACCEPTANCE_ACTORS.filter((actor) => !successActors.includes(actor)),
		expectedSuccessStatus: method === 'post' && (path.startsWith('/v1/platform/operations') || path.includes('/retry')) ? 202 : 200,
		exactStatusRequired: true,
		cleanup: method === 'delete' ? 'disposable-fixture' : 'acceptance-owned-fixture',
		productionSafe: true,
		productionStrategy: productionSafeStrategy(path, method),
	};
}

export function extractActiveApiRoutes(source = `${readFileSync(appSourcePath, 'utf8')}\n${readFileSync(projectDeploymentRoutesSourcePath, 'utf8')}`) {
	const routes = [];
	const pattern = /app\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/gu;
	for (const match of source.matchAll(pattern)) {
		const method = match[1].toLowerCase();
		const path = match[2];
		if (!path.startsWith('/v1')) continue;
		routes.push({
			id: routeId(method, path),
			method: method.toUpperCase(),
			path,
			ownerDomain: ownerDomain(path),
			authClass: authClass(path),
			mutability: mutability(method),
			safeProduction: safeProduction(path, method),
			fixtures: fixtureRequirements(path),
			providerIngress: path.startsWith('/v1/provider/'),
			internalRunner: path.startsWith('/v1/platform/runners/'),
			acceptance: acceptancePolicy(path, method),
		});
	}
	return routes.sort((left, right) => left.id.localeCompare(right.id));
}

export const API_ROUTE_DESCRIPTORS = extractActiveApiRoutes().map((descriptor) => {
	const sdkMethods = Object.entries(SDK_METHOD_ROUTE_MAP)
		.filter(([, routeIdValue]) => routeIdValue === descriptor.id)
		.map(([method]) => method);
	return sdkMethods.length > 0 ? { ...descriptor, sdkMethods } : descriptor;
});

export function descriptorById(id) {
	return API_ROUTE_DESCRIPTORS.find((descriptor) => descriptor.id === id) ?? null;
}

export function descriptorsForSdkMethods() {
	const byId = new Map(API_ROUTE_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]));
	return Object.fromEntries(Object.entries(SDK_METHOD_ROUTE_MAP).map(([method, id]) => [method, byId.get(id) ?? null]));
}
