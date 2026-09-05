import { createPrivateKey, createSign } from 'node:crypto';

import { readServiceCredentials } from './managed-secrets.ts';

function base64Url(value: string | Buffer) {
	return Buffer.from(value).toString('base64url');
}

export function createGitHubAppJwt(appId: string, privateKey: string) {
	const now = Math.floor(Date.now() / 1000);
	const encodedHeader = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
	const encodedPayload = base64Url(JSON.stringify({ iat: now - 30, exp: now + 540, iss: appId }));
	const unsigned = `${encodedHeader}.${encodedPayload}`;
	const signer = createSign('RSA-SHA256');
	signer.update(unsigned);
	signer.end();
	return `${unsigned}.${signer.sign(createPrivateKey(privateKey), 'base64url')}`;
}

function json(value: unknown): Record<string, unknown> {
	if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
	try { return JSON.parse(String(value ?? '{}')); } catch { return {}; }
}

function connectorEnvironment(profileId: string) {
	if (profileId === 'github-repository-app') {
		return { appId: 'TREESEED_GITHUB_REPOSITORY_APP_ID', privateKey: 'TREESEED_GITHUB_REPOSITORY_APP_PRIVATE_KEY' };
	}
	if (profileId === 'github-workflow-app') {
		return { appId: 'TREESEED_GITHUB_WORKFLOW_APP_ID', privateKey: 'TREESEED_GITHUB_WORKFLOW_APP_PRIVATE_KEY' };
	}
	throw new Error('The GitHub App credential profile is not a managed Connector profile.');
}

function permissionScope(profileId: string) {
	return profileId === 'github-repository-app'
		? { contents: 'write', checks: 'read', administration: 'write' }
		: { actions: 'write', contents: 'read', secrets: 'write', variables: 'write' };
}

async function mintInstallationToken(input: {
	appId: string;
	privateKey: string;
	installationId: string;
	repository?: string;
	profileId: string;
	fetchImpl: typeof fetch;
}) {
	const response = await input.fetchImpl(
		`https://api.github.com/app/installations/${encodeURIComponent(input.installationId)}/access_tokens`,
		{
			method: 'POST',
			headers: {
				accept: 'application/vnd.github+json', authorization: `Bearer ${createGitHubAppJwt(input.appId, input.privateKey)}`,
				'content-type': 'application/json', 'user-agent': 'treeseed-provider-authority', 'x-github-api-version': '2022-11-28',
			},
			body: JSON.stringify({ ...(input.repository ? { repositories: [input.repository] } : {}), permissions: permissionScope(input.profileId) }),
		},
	);
	if (!response.ok) throw new Error(`GitHub rejected the scoped installation token request (HTTP ${response.status}).`);
	const payload = await response.json() as { token?: string; expires_at?: string };
	if (!payload.token) throw new Error('GitHub did not return a scoped installation token.');
	return { token: payload.token, expiresAt: payload.expires_at ?? null };
}

export async function resolveGitHubRepositoryCreationAuthority(input: {
	store: any; teamId: string; owner: string; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch;
}) {
	const rows: any[] = await input.store.all(`SELECT a.*, c.non_secret_config_json, c.id AS service_connection_id,
		b.id AS capability_binding_id FROM provider_credential_authorities a
		JOIN team_service_connections c ON c.id = a.connection_id AND c.team_id = ? AND c.provider_id = 'github' AND c.status = 'active'
		JOIN team_service_capability_bindings b ON b.connection_id = c.id AND b.credential_profile_id = a.credential_profile_id
			AND b.capability_type = 'repository-hosting' AND b.status = 'configured'
		WHERE a.status = 'ready'`, [input.teamId]);
	const owner = input.owner.toLowerCase();
	const matches = rows.filter((row) => {
		const config = json(row.non_secret_config_json);
		const connector = json(json(config.githubConnectors).repository);
		const configuredOwner = String(connector.accountLogin ?? config.organization ?? '').trim().toLowerCase();
		if (configuredOwner !== owner) return false;
		return row.scheme !== 'app-installation' || connector.repositorySelection === 'all';
	});
	if (!matches.length) throw new Error('A ready team GitHub repository-hosting authority with all-repository installation access is required.');
	if (matches.length > 1) throw new Error('Multiple GitHub repository-hosting authorities match this team and owner; select one explicitly.');
	const row = matches[0];
	const credential = await credentialForRow(row, { store: input.store, capability: 'repository-hosting', env: input.env, fetchImpl: input.fetchImpl });
	return { ...credential, authorityId: String(row.id), serviceConnectionId: String(row.service_connection_id),
		capabilityBindingId: String(row.capability_binding_id) };
}

async function credentialForRow(row: any, input: {
	store: any;
	capability: 'repository-hosting' | 'workflow-execution' | 'workflow-configuration' | 'secret-enclave';
	env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch;
}) {
	const capabilities = JSON.parse(row.capabilities_json ?? '[]');
	if (!capabilities.includes(input.capability)) throw new Error('The credential authority does not grant the requested capability.');
	const env = input.env ?? process.env;
	if (row.scheme === 'openbao') {
    const record = await readServiceCredentials(input.store,row.team_id,row.connection_id,row.credential_profile_id);
    if (record.version !== Number(row.version) || !record.values.accessToken) throw new Error('GitHub credential metadata is stale.');
    return {token:record.values.accessToken,username:'x-access-token',expiresAt:new Date(Date.now()+60_000).toISOString(),authorityScheme:'openbao'};
  }
	if (row.scheme === 'app-installation') {
		const connector = connectorEnvironment(row.credential_profile_id);
		const config = json(row.non_secret_config_json);
		const connectorKind = row.credential_profile_id === 'github-repository-app' ? 'repository' : 'workflow';
		const connectorConfig = json(json(config.githubConnectors)[connectorKind]);
		const appId = String(env[connector.appId] ?? '');
		const privateKey = String(env[connector.privateKey] ?? '');
		const installationId = String(connectorConfig.installationId ?? '');
		if (!appId || !privateKey || !installationId) throw new Error('The managed GitHub Connector authority is incomplete.');
		const minted = await mintInstallationToken({ appId, privateKey, installationId, repository: row.name,
			profileId: row.credential_profile_id, fetchImpl: input.fetchImpl ?? fetch });
		return { ...minted, username: 'x-access-token', authorityScheme: row.scheme as string };
	}
	throw new Error(`Credential authority scheme ${row.scheme} is not unattended-ready.`);
}

export async function resolveGitHubRepositoryCandidateAuthority(input: {
	store: any; authorityId: string; teamId: string; serviceConnectionId: string; capabilityBindingId: string;
	owner: string; repository: string; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch;
}) {
	const row = await input.store.first(`SELECT a.*, c.non_secret_config_json, ? AS owner, ? AS name
		FROM provider_credential_authorities a
		JOIN team_service_connections c ON c.id = a.connection_id AND c.team_id = ?
		JOIN team_service_capability_bindings b ON b.id = ? AND b.connection_id = c.id
			AND b.credential_profile_id = a.credential_profile_id AND b.capability_type = 'repository-hosting' AND b.status = 'configured'
		WHERE a.id = ? AND a.connection_id = ? AND a.status = 'ready'`,
		[input.owner, input.repository, input.teamId, input.capabilityBindingId, input.authorityId, input.serviceConnectionId]);
	if (!row) throw new Error('The repository credential authority is unavailable.');
	return credentialForRow(row, { store: input.store, capability: 'repository-hosting', env: input.env, fetchImpl: input.fetchImpl });
}

export async function resolveGitHubCredentialAuthority(input: {
	store: any;
	authorityId: string;
	repositoryBindingId: string;
	capabilityBindingId?: string | null;
	capability: 'repository-hosting' | 'workflow-execution' | 'workflow-configuration' | 'secret-enclave';
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
}) {
	const row = await input.store.first(
		`SELECT a.*, c.non_secret_config_json, r.owner, r.name, r.provider_id, r.authority_id
		 FROM provider_credential_authorities a
		 JOIN team_service_connections c ON c.id = a.connection_id
		 JOIN project_remote_repository_bindings r ON r.id = ? AND r.team_id = a.team_id
		 WHERE a.id = ? AND a.status = 'ready'`,
		[input.repositoryBindingId, input.authorityId],
	);
	if (!row || row.provider_id !== 'github') throw new Error('The repository credential authority is unavailable.');
	if (input.capabilityBindingId) {
		const binding = await input.store.first(`SELECT id FROM team_service_capability_bindings
			WHERE id = ? AND team_id = ? AND connection_id = ? AND credential_profile_id = ?
			AND capability_type = ? AND status = 'configured'`,
			[input.capabilityBindingId, row.team_id, row.connection_id, row.credential_profile_id, input.capability]);
		if (!binding) throw new Error('The capability binding does not select this credential authority.');
	} else if (row.authority_id !== row.id) throw new Error('The repository credential authority is unavailable.');
	return credentialForRow(row, { store: input.store, capability: input.capability, env: input.env, fetchImpl: input.fetchImpl });
}
