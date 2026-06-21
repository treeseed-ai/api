import {
	containsTreeseedPlaintextSecretMaterial,
	type TreeseedTreeDxCredentialBridgeCredential,
	type TreeseedTreeDxCredentialBridgeRequest,
} from '@treeseed/sdk/secrets-capability';
import { resolveGitHubCredentialForRepository } from '@treeseed/sdk/operations/github-credentials';
import { createHash } from 'node:crypto';
import { createGitHubAppAdapter, resolveGitHubAppConfig } from './github-app-adapter.ts';

const TREEDX_CREDENTIAL_BRIDGE_OPERATIONS = [
	'clone',
	'fetch',
	'save',
	'commit',
	'push',
	'pull_request',
	'repository_update',
];

function failClosedError(code: string, message: string, status = 403) {
	const error = new Error(message);
	(error as any).status = status;
	(error as any).code = code;
	return error;
}

function normalizeRepository(value: unknown): string {
	return String(value ?? '').trim().replace(/^https:\/\/github\.com\//u, '').replace(/\.git$/u, '').toLowerCase();
}

function stringValue(value: unknown, name: string): string {
	const next = String(value ?? '').trim();
	if (!next) throw failClosedError('treedx_credential_revoked', `${name} is required.`, 400);
	return next;
}

function optionalString(value: unknown): string | null {
	const next = typeof value === 'string' ? value.trim() : '';
	return next || null;
}

function credentialRefEnvName(value: unknown): string | null {
	const ref = optionalString(value);
	if (!ref) return null;
	const envName = ref.startsWith('env:') ? ref.slice(4) : ref;
	return envName.startsWith('TREESEED_GITHUB_TOKEN') ? envName : null;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.map((entry) => String(entry ?? '').trim()).filter(Boolean) : [];
}

function requiredPermissionsFor(operation: string) {
	if (['push', 'save', 'commit', 'pull_request', 'repository_update'].includes(operation)) {
		return { contents: 'write', metadata: 'read' };
	}
	return { contents: 'read', metadata: 'read' };
}

function credentialEvidence(token: string) {
	return {
		tokenPrefix: token.slice(0, 12),
		tokenHash: `sha256:${createHash('sha256').update(token).digest('hex')}`,
	};
}

export function createTreeDxCredentialBridge(options: {
	store: any;
	config?: Record<string, any>;
	githubAppAdapter?: any;
	now?: () => Date;
}) {
	const store = options.store;
	const now = options.now ?? (() => new Date());
	const githubAppAdapter = options.githubAppAdapter ?? createGitHubAppAdapter({ store, config: options.config ?? {} });
	const githubAppConfig = resolveGitHubAppConfig(options.config ?? {}, process.env);
	const githubAppConfigured = Boolean(options.githubAppAdapter || (githubAppConfig.appId && githubAppConfig.privateKey));
	const envValues: Record<string, string | undefined> = {
		...process.env,
		...(options.config ?? {}),
	};

	async function resolveProjectCredentialRef(input: { projectId: string; repository: string }) {
		if (typeof store.listHubRepositories !== 'function') return null;
		const repositories = await store.listHubRepositories(input.projectId).catch(() => []);
		const match = repositories.find((candidate: any) => normalizeRepository(`${candidate?.owner ?? ''}/${candidate?.name ?? ''}`) === input.repository);
		return credentialRefEnvName(match?.metadata?.credentialRef);
	}

	async function resolveEnvironmentAuthority(input: {
		projectId: string;
		repository: string;
		operation: string;
		credentialId?: string | null;
	}) {
		const explicitEnvName = credentialRefEnvName(input.credentialId)
			?? await resolveProjectCredentialRef({ projectId: input.projectId, repository: input.repository });
		if (explicitEnvName) {
			const token = optionalString(envValues[explicitEnvName]);
			if (!token) {
				throw failClosedError('treedx_credential_revoked', `GitHub credential reference ${explicitEnvName} is not configured.`);
			}
			return {
				token,
				provider: 'github-env-token',
				repositoryAuthority: explicitEnvName,
				expiresAt: null,
				permissions: requiredPermissionsFor(input.operation),
				issuance: null,
			};
		}
		const resolved = resolveGitHubCredentialForRepository(input.repository, { values: envValues });
		if (!resolved.token) {
			throw failClosedError('treedx_credential_revoked', `GitHub credential is not configured for ${input.repository}. Configure ${resolved.envName} or TREESEED_GITHUB_TOKEN.`);
		}
		return {
			token: resolved.token,
			provider: 'github-env-token',
			repositoryAuthority: resolved.source === 'repository' ? resolved.envName : 'TREESEED_GITHUB_TOKEN',
			expiresAt: null,
			permissions: requiredPermissionsFor(input.operation),
			issuance: null,
		};
	}

	async function issueGitCredential(input: TreeseedTreeDxCredentialBridgeRequest): Promise<TreeseedTreeDxCredentialBridgeCredential> {
		if (containsTreeseedPlaintextSecretMaterial(input)) {
			throw failClosedError('treedx_credential_revoked', 'TreeDX credential requests must not include plaintext secret material.', 400);
		}
		const teamId = stringValue(input.teamId, 'teamId');
		const projectId = stringValue(input.projectId, 'projectId');
		const repository = normalizeRepository(input.repository);
		const operation = stringValue(input.operation, 'operation');
		if (!repository.includes('/')) throw failClosedError('github_repository_removed', 'repository must be owner/name.', 400);
		if (!TREEDX_CREDENTIAL_BRIDGE_OPERATIONS.includes(operation)) {
			throw failClosedError('treedx_credential_revoked', `TreeDX operation "${operation}" is not allowed.`, 400);
		}
		const requiredPermissions = requiredPermissionsFor(operation);
		const authority = githubAppConfigured
			? await githubAppAdapter.mintInstallationToken({
				teamId,
				projectId,
				assignmentId: input.assignmentId ?? null,
				providerId: input.providerId ?? null,
				workdayId: input.workdayId ?? null,
				operationId: `treedx:${operation}`,
				installationId: stringValue(input.installationId, 'installationId'),
				repository,
				ref: input.ref ?? null,
				paths: stringArray(input.paths),
				requiredPermissions,
				allowedOperations: [operation],
				policy: input.policy ?? {},
				requester: {
					type: 'treedx',
					...(input.actor && typeof input.actor === 'object' ? input.actor : {}),
					credentialId: input.credentialId ?? null,
				},
			}).then((result: any) => ({
				...result,
				provider: 'github-app',
				repositoryAuthority: 'github_app',
			}))
			: await resolveEnvironmentAuthority({
				projectId,
				repository,
				operation,
				credentialId: input.credentialId ?? null,
			});
		const token = String(authority.token ?? '');
		if (!token) throw failClosedError('github_app_token_blocked', 'GitHub App did not return TreeDX repository authority.');
		const evidence = credentialEvidence(token);
		const issuance = await store.recordTreeDxCredentialIssuance({
			teamId,
			projectId,
			assignmentId: input.assignmentId ?? null,
			repository,
			credentialProvider: authority.provider,
			status: 'issued',
			tokenPrefix: evidence.tokenPrefix,
			tokenHash: evidence.tokenHash,
			scopes: Object.entries(authority.permissions ?? requiredPermissions).map(([name, level]) => `${name}:${level}`),
			allowedOperations: [operation],
			expiresAt: authority.expiresAt ?? null,
			issuedAt: now().toISOString(),
			metadata: {
				credentialId: input.credentialId ?? null,
				providerId: input.providerId ?? null,
				workdayId: input.workdayId ?? null,
				ref: input.ref ?? null,
				paths: stringArray(input.paths),
				githubAppTokenIssuanceId: authority.issuance?.id ?? null,
				repositoryAuthority: authority.repositoryAuthority,
				requester: input.actor ?? null,
			},
		});
		return {
			id: String(input.credentialId ?? issuance.id),
			type: 'token',
			username: 'x-access-token',
			token,
			expiresAt: authority.expiresAt ?? null,
			provider: authority.provider,
			repository,
			allowedOperations: [operation],
			issuanceId: issuance.id,
		};
	}

	return { issueGitCredential };
}
