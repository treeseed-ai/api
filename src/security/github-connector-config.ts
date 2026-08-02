import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export type GitHubConnectorKind = 'repository' | 'workflow';

const KIND_CONFIG = {
	repository: {
		profileId: 'github-repository-app', capability: 'repository-hosting',
		prefix: 'TREESEED_GITHUB_REPOSITORY_APP',
	},
	workflow: {
		profileId: 'github-workflow-app', capability: 'workflow-execution',
		prefix: 'TREESEED_GITHUB_WORKFLOW_APP',
	},
} as const;

export function isGitHubConnectorKind(value: string): value is GitHubConnectorKind {
	return value === 'repository' || value === 'workflow';
}

export function githubConnectorRequiredPermissions(kind: GitHubConnectorKind) {
	return kind === 'repository'
		? { contents: 'write' as const }
		: { contents: 'read' as const, actions: 'write' as const, secrets: 'write' as const, variables: 'write' as const };
}

export function githubConnectorConfig(kind: GitHubConnectorKind, env: NodeJS.ProcessEnv = process.env) {
	const definition = KIND_CONFIG[kind];
	const read = (suffix: string) => String(env[`${definition.prefix}_${suffix}`] ?? '').trim();
	const baseUrl = String(env.TREESEED_PROVIDER_CONNECTOR_BASE_URL ?? '').replace(/\/+$/u, '');
	const stateSecret = String(env.TREESEED_PROVIDER_CONNECTOR_STATE_SECRET ?? '');
	const result = {
		...definition, appId: read('ID'), clientId: read('CLIENT_ID'), clientSecret: read('CLIENT_SECRET'),
		privateKey: read('PRIVATE_KEY'), webhookSecret: read('WEBHOOK_SECRET'), slug: read('SLUG'), baseUrl, stateSecret,
	};
	const missing = Object.entries(result)
		.filter(([key, value]) => !['profileId', 'capability', 'prefix'].includes(key) && !value)
		.map(([key]) => key);
	if (missing.length) throw new Error(`The ${kind} GitHub Connector is missing: ${missing.join(', ')}.`);
	return result;
}

export function createConnectorState(payload: Record<string, unknown>, secret: string) {
	const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
	const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
	return `${encoded}.${signature}`;
}

export function readConnectorState<T>(state: string, secret: string): T | null {
	const [encoded, signature, extra] = state.split('.');
	if (!encoded || !signature || extra) return null;
	const expected = createHmac('sha256', secret).update(encoded).digest();
	let actual: Buffer;
	try { actual = Buffer.from(signature, 'base64url'); } catch { return null; }
	if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
	try { return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as T; } catch { return null; }
}

export function connectorStateHash(state: string) {
	return createHash('sha256').update(state).digest('hex');
}
