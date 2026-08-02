import { createGitHubAppJwt } from '../../../security/provider-credential-authority.ts';
import type { GitHubConnectorKind } from '../../../security/github-connector-config.ts';

const headers = (authorization: string) => ({
	accept: 'application/vnd.github+json', authorization, 'user-agent': 'treeseed-provider-connector',
	'x-github-api-version': '2022-11-28',
});

async function githubJson(url: string, authorization: string, fetchImpl: typeof fetch) {
	const response = await fetchImpl(url, { headers: headers(authorization) });
	if (!response.ok) throw new Error(`GitHub authorization verification failed (HTTP ${response.status}).`);
	return response.json() as Promise<any>;
}

export async function verifyGitHubInstallation(input: {
	appId: string; privateKey: string; installationId: string;
	requiredPermissions?: Record<string, 'read' | 'write'>; fetchImpl?: typeof fetch;
}) {
	const payload = await githubJson(`https://api.github.com/app/installations/${encodeURIComponent(input.installationId)}`,
		`Bearer ${createGitHubAppJwt(input.appId, input.privateKey)}`, input.fetchImpl ?? fetch);
	if (String(payload.app_id) !== input.appId || String(payload.id) !== input.installationId || payload.suspended_at) {
		throw new Error('GitHub returned an unavailable or mismatched App installation.');
	}
	const rank = { read: 1, write: 2 } as const;
	for (const [permission, required] of Object.entries(input.requiredPermissions ?? {})) {
		const observed = String(payload.permissions?.[permission] ?? '');
		if (!(observed in rank) || rank[observed as keyof typeof rank] < rank[required]) {
			throw new Error(`The GitHub App installation is missing required ${permission}:${required} authority.`);
		}
	}
	return { installationId: String(payload.id), accountId: String(payload.account?.id ?? ''),
		accountLogin: String(payload.account?.login ?? ''), repositorySelection: String(payload.repository_selection ?? ''),
		permissions: payload.permissions ?? {} };
}

export async function exchangeGitHubUserCode(input: {
	clientId: string; clientSecret: string; code: string; fetchImpl?: typeof fetch;
}) {
	const response = await (input.fetchImpl ?? fetch)('https://github.com/login/oauth/access_token', {
		method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json',
			'user-agent': 'treeseed-provider-connector' },
		body: JSON.stringify({ client_id: input.clientId, client_secret: input.clientSecret, code: input.code }),
	});
	if (!response.ok) throw new Error(`GitHub rejected the user authorization code (HTTP ${response.status}).`);
	const payload = await response.json() as { access_token?: string; error?: string };
	if (!payload.access_token) throw new Error(`GitHub user authorization failed${payload.error ? `: ${payload.error}` : '.'}`);
	return payload.access_token;
}

export async function verifyGitHubUserInstallation(input: {
	token: string; installationId: string; fetchImpl?: typeof fetch;
}) {
	const fetchImpl = input.fetchImpl ?? fetch;
	const user = await githubJson('https://api.github.com/user', `Bearer ${input.token}`, fetchImpl);
	let page = 1;
	let found = false;
	do {
		const payload = await githubJson(`https://api.github.com/user/installations?per_page=100&page=${page}`,
			`Bearer ${input.token}`, fetchImpl);
		found = (payload.installations ?? []).some((item: any) => String(item.id) === input.installationId);
		if (found || (payload.installations ?? []).length < 100) break;
		page += 1;
	} while (page <= 10);
	if (!found) throw new Error('The authorizing GitHub user cannot administer this App installation.');
	return { id: String(user.id), login: String(user.login ?? '') };
}

export function connectorCapabilities(kind: GitHubConnectorKind) {
	return kind === 'repository'
		? ['repository-hosting']
		: ['workflow-execution', 'workflow-configuration', 'secret-enclave'];
}
