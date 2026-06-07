export const PROJECT_WEB_DEPLOYMENT_ACTIONS = ['deploy_web', 'publish_content', 'monitor'] as const;
export const PROJECT_DEPLOYMENT_ENVIRONMENTS = ['staging', 'prod'] as const;
export const PROJECT_DEPLOYMENT_ACTIVE_STATUSES = ['queued', 'claimed', 'dispatching', 'running', 'monitoring'] as const;
export const PROJECT_DEPLOYMENT_TERMINAL_STATUSES = ['succeeded', 'failed', 'cancelled', 'timed_out'] as const;

export type ProjectWebDeploymentAction = (typeof PROJECT_WEB_DEPLOYMENT_ACTIONS)[number];
export type ProjectDeploymentEnvironment = (typeof PROJECT_DEPLOYMENT_ENVIRONMENTS)[number];

export const FORBIDDEN_DEPLOYMENT_REQUEST_FIELDS = [
	'capacityProviderId',
	'laneId',
	'grantId',
	'workerPoolId',
	'runtimeHostId',
	'railwayServiceId',
	'runnerToken',
] as const;

const SECRET_FIELD_PATTERN = /(?:secret|token|password|apiKey|privateKey|credential|ciphertext|passphrase)/iu;
const SECRET_VALUE_PATTERN = /(?:runner-token-secret|capacity-provider-secret|secret-token|github_pat_|ghp_|sk-[a-z0-9_-]{8,}|prjrun_|tsk_)/iu;

export function isProjectWebDeploymentAction(value: unknown): value is ProjectWebDeploymentAction {
	return typeof value === 'string' && PROJECT_WEB_DEPLOYMENT_ACTIONS.includes(value as ProjectWebDeploymentAction);
}

export function isProjectDeploymentEnvironment(value: unknown): value is ProjectDeploymentEnvironment {
	return typeof value === 'string' && PROJECT_DEPLOYMENT_ENVIRONMENTS.includes(value as ProjectDeploymentEnvironment);
}

export function deploymentKindForAction(action: ProjectWebDeploymentAction): 'code' | 'content' | 'mixed' {
	if (action === 'publish_content') return 'content';
	if (action === 'monitor') return 'mixed';
	return 'code';
}

export function forbiddenDeploymentFields(body: unknown): string[] {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
	return FORBIDDEN_DEPLOYMENT_REQUEST_FIELDS.filter((field) => field in body);
}

export function redactDeploymentValue<T>(value: T): T {
	if (Array.isArray(value)) return value.map((entry) => redactDeploymentValue(entry)) as T;
	if (typeof value === 'string' && SECRET_VALUE_PATTERN.test(value)) return '[redacted]' as T;
	if (!value || typeof value !== 'object') return value;
	return Object.fromEntries(Object.entries(value as Record<string, unknown>)
		.filter(([key]) => !FORBIDDEN_DEPLOYMENT_REQUEST_FIELDS.includes(key as any))
		.filter(([key]) => !SECRET_FIELD_PATTERN.test(key))
		.map(([key, entry]) => [key, redactDeploymentValue(entry)])) as T;
}

export function normalizeDeploymentSource(value: unknown): 'market_ui' | 'market_api' | 'cli' | 'launch_flow' {
	return ['market_ui', 'market_api', 'cli', 'launch_flow'].includes(String(value ?? '')) ? value as any : 'market_api';
}
