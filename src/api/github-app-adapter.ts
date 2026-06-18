import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from 'octokit';

function trimmed(value: unknown): string | null {
	const next = typeof value === 'string' ? value.trim() : '';
	return next || null;
}

function normalizePrivateKey(value: unknown): string | null {
	const raw = trimmed(value);
	if (!raw) return null;
	const withNewlines = raw.includes('\\n') ? raw.replace(/\\n/gu, '\n') : raw;
	if (withNewlines.includes('-----BEGIN')) return withNewlines;
	try {
		const decoded = Buffer.from(raw, 'base64').toString('utf8').trim();
		return decoded.includes('-----BEGIN') ? decoded : withNewlines;
	} catch {
		return withNewlines;
	}
}

function normalizeRepository(value: unknown): string {
	return String(value ?? '').trim().replace(/^https:\/\/github\.com\//u, '').replace(/\.git$/u, '').toLowerCase();
}

function repositoryFromGitHub(repo: any): string {
	return normalizeRepository(repo?.full_name ?? `${repo?.owner?.login ?? ''}/${repo?.name ?? ''}`);
}

function objectValue(value: unknown): Record<string, any> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function permissionLevel(value: unknown): number {
	const normalized = String(value ?? '').trim().toLowerCase();
	if (normalized === 'write' || normalized === 'admin') return 2;
	if (normalized === 'read') return 1;
	return 0;
}

function missingPermissions(actual: Record<string, unknown>, required: Record<string, unknown> = {}): string[] {
	return Object.entries(required)
		.filter(([permission, requiredLevel]) => permissionLevel(actual[permission]) < permissionLevel(requiredLevel))
		.map(([permission]) => permission);
}

function failClosedError(code: string, message: string) {
	const error = new Error(message);
	(error as any).status = 403;
	(error as any).code = code;
	return error;
}

function tokenEvidence(token: string) {
	return {
		tokenPrefix: token.slice(0, 12),
		tokenHash: `sha256:${createHash('sha256').update(token).digest('hex')}`,
	};
}

export function resolveGitHubAppConfig(config: Record<string, any> = {}, env: Record<string, string | undefined> = process.env) {
	const appId = trimmed(config.githubAppId ?? config.TREESEED_GITHUB_APP_ID ?? env.TREESEED_GITHUB_APP_ID);
	const privateKey = normalizePrivateKey(config.githubAppPrivateKey ?? config.TREESEED_GITHUB_APP_PRIVATE_KEY ?? env.TREESEED_GITHUB_APP_PRIVATE_KEY);
	const webhookSecret = trimmed(config.githubAppWebhookSecret ?? config.TREESEED_GITHUB_APP_WEBHOOK_SECRET ?? env.TREESEED_GITHUB_APP_WEBHOOK_SECRET);
	const clientId = trimmed(config.githubAppClientId ?? config.TREESEED_GITHUB_APP_CLIENT_ID ?? env.TREESEED_GITHUB_APP_CLIENT_ID);
	return { appId, privateKey, webhookSecret, clientId };
}

export function verifyGitHubAppWebhookSignature(input: {
	body: string | Buffer;
	signature?: string | null;
	webhookSecret?: string | null;
}) {
	const secret = trimmed(input.webhookSecret);
	const signature = trimmed(input.signature);
	if (!secret || !signature || !signature.startsWith('sha256=')) return false;
	const body = Buffer.isBuffer(input.body) ? input.body : Buffer.from(String(input.body ?? ''), 'utf8');
	const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
	const left = Buffer.from(signature);
	const right = Buffer.from(expected);
	return left.length === right.length && timingSafeEqual(left, right);
}

export function createGitHubAppAdapter(options: {
	store: any;
	config?: Record<string, any>;
	env?: Record<string, string | undefined>;
	githubAppClientFactory?: (config: any) => any;
	installationClientFactory?: (config: any) => any;
	installationTokenFactory?: (input: any) => Promise<any>;
	now?: () => Date;
}): any {
	const store = options.store;
	const config = resolveGitHubAppConfig(options.config ?? {}, options.env);
	const now = options.now ?? (() => new Date());

	function requireConfig() {
		if (!config.appId || !config.privateKey) {
			throw failClosedError('github_installation_missing', 'GitHub App id and private key are required.');
		}
		return config;
	}

	function createAppClient() {
		const resolved = requireConfig();
		return options.githubAppClientFactory?.(resolved) ?? new Octokit({
			authStrategy: createAppAuth,
			auth: { appId: resolved.appId, privateKey: resolved.privateKey },
		});
	}

	function createInstallationClient(installationId: string) {
		const resolved = requireConfig();
		return options.installationClientFactory?.({ ...resolved, installationId }) ?? new Octokit({
			authStrategy: createAppAuth,
			auth: { appId: resolved.appId, privateKey: resolved.privateKey, installationId },
		});
	}

	async function createInstallationToken(input: any) {
		const resolved = requireConfig();
		if (options.installationTokenFactory) return options.installationTokenFactory({ ...input, config: resolved });
		const auth = createAppAuth({
			appId: resolved.appId,
			privateKey: resolved.privateKey,
			installationId: input.installationId,
		});
		return auth({
			type: 'installation',
			permissions: input.permissions,
			repositoryIds: input.repositoryIds,
		});
	}

	async function observeInstallation(input: any) {
		const installationId = String(input.installationId ?? '');
		const teamId = String(input.teamId ?? '');
		if (!teamId || !installationId) throw failClosedError('github_installation_missing', 'teamId and installationId are required.');
		const appClient = createAppClient();
		const installationResponse = await appClient.request('GET /app/installations/{installation_id}', {
			installation_id: installationId,
		});
		const installation = installationResponse?.data ?? installationResponse;
		const status = installation?.suspended_at ? 'suspended' : 'active';
		const record = await store.upsertGitHubAppInstallationRecord({
			teamId,
			installationId,
			accountLogin: installation?.account?.login ?? null,
			accountId: installation?.account?.id == null ? null : String(installation.account.id),
			accountType: installation?.account?.type ?? null,
			status,
			permissions: objectValue(installation?.permissions),
			repositorySelection: installation?.repository_selection ?? null,
			suspendedAt: installation?.suspended_at ?? null,
			metadata: {
				htmlUrl: installation?.html_url ?? null,
				appSlug: installation?.app_slug ?? null,
			},
		});
		if (status === 'suspended') {
			await store.recordSecretCapabilityAudit('github_app_installation_record.suspended', record, {
				failClosedCode: 'github_installation_suspended',
			});
		}
		return record;
	}

	async function discoverRepositoryGrants(input: any) {
		const installationId = String(input.installationId ?? '');
		const teamId = String(input.teamId ?? '');
		if (!teamId || !installationId) throw failClosedError('github_installation_missing', 'teamId and installationId are required.');
		const installation = await observeInstallation({ teamId, installationId });
		if (installation.status !== 'active') throw failClosedError('github_installation_suspended', 'GitHub App installation is not active.');
		const client = createInstallationClient(installationId);
		const repositories = typeof client.paginate === 'function'
			? await client.paginate('GET /installation/repositories')
			: (await client.request('GET /installation/repositories'))?.data?.repositories ?? [];
		const records = [];
		const observedRepositories = new Set<string>();
		for (const repo of repositories) {
			const repository = repositoryFromGitHub(repo);
			if (!repository) continue;
			observedRepositories.add(repository);
			const permissions = objectValue(repo?.permissions ?? installation.permissions);
			const missing = missingPermissions(permissions, input.requiredPermissions ?? {});
			records.push(await store.upsertGitHubRepositoryGrant({
				teamId,
				projectId: input.projectId ?? null,
				repository,
				installationId,
				accountLogin: installation.accountLogin,
				accountId: installation.accountId,
				status: missing.length > 0 ? 'drifted' : 'active',
				permissions,
				driftCode: missing.length > 0 ? 'github_permission_drift' : null,
				metadata: { installationRecordId: installation.id, missingPermissions: missing },
			}));
		}
		for (const grant of await store.listGitHubRepositoryGrants({ teamId, limit: 500 })) {
			if (String(grant.installationId ?? '') === installationId && !observedRepositories.has(normalizeRepository(grant.repository))) {
				await store.updateGitHubRepositoryGrantStatus(grant.id, 'drifted', { driftCode: 'github_repository_removed' });
			}
		}
		return { installation, grants: records };
	}

	function assertPolicy(input: any) {
		const policy = objectValue(input.policy);
		if (Array.isArray(policy.allowedRefs) && policy.allowedRefs.length > 0 && input.ref && !policy.allowedRefs.includes(input.ref)) {
			throw failClosedError('github_app_token_blocked', 'Requested ref is outside the approved GitHub App token policy.');
		}
		if (Array.isArray(policy.allowedPathPrefixes) && policy.allowedPathPrefixes.length > 0) {
			const paths = Array.isArray(input.paths) ? input.paths.map((path: unknown) => String(path ?? '')) : [];
			if (paths.some((path: string) => !policy.allowedPathPrefixes.some((prefix: string) => path === prefix || path.startsWith(`${prefix.replace(/\/+$/u, '')}/`)))) {
				throw failClosedError('github_app_token_blocked', 'Requested path is outside the approved GitHub App token policy.');
			}
		}
		if (policy.requireWorkday === true && !input.workdayId) {
			throw failClosedError('github_app_token_blocked', 'workdayId is required before issuing repository authority.');
		}
		if (policy.requireAssignment === true && !input.assignmentId) {
			throw failClosedError('github_app_token_blocked', 'assignmentId is required before issuing repository authority.');
		}
		if (policy.requireProvider === true && !input.providerId) {
			throw failClosedError('github_app_token_blocked', 'providerId is required before issuing repository authority.');
		}
	}

	async function mintInstallationToken(input: any) {
		const teamId = String(input.teamId ?? '');
		const installationId = String(input.installationId ?? '');
		const repository = normalizeRepository(input.repository);
		if (!teamId || !installationId || !repository) throw failClosedError('github_installation_missing', 'teamId, installationId, and repository are required.');
		assertPolicy(input);
		const installation = await store.getGitHubAppInstallationRecord({ teamId, installationId });
		if (!installation || installation.status === 'revoked') throw failClosedError('github_installation_revoked', 'GitHub App installation is revoked or missing.');
		if (installation.status === 'suspended') throw failClosedError('github_installation_suspended', 'GitHub App installation is suspended.');
		if (input.accountId != null && String(input.accountId) !== String(installation.accountId ?? '')) {
			throw failClosedError('github_account_mismatch', 'GitHub App installation account does not match the requested account.');
		}
		const grants = await store.listGitHubRepositoryGrants({ teamId, limit: 500 });
		const grant = grants.find((candidate: any) => normalizeRepository(candidate.repository) === repository);
		if (!grant || String(grant.installationId ?? '') !== installationId) throw failClosedError('github_repository_removed', 'Repository is not granted to this GitHub App installation.');
		if (grant.status === 'revoked') throw failClosedError('github_grant_revoked', 'GitHub repository grant is revoked.');
		if (grant.status !== 'active') throw failClosedError('github_grant_drifted', 'GitHub repository grant is not active.');
		const requiredPermissions = objectValue(input.requiredPermissions);
		const missing = missingPermissions(objectValue(grant.permissions), requiredPermissions);
		if (missing.length > 0) {
			await store.updateGitHubRepositoryGrantStatus(grant.id, 'drifted', { driftCode: 'github_permission_drift' });
			throw failClosedError('github_permission_drift', 'GitHub repository grant is missing required permissions.');
		}
		const token = await createInstallationToken({
			installationId,
			repository,
			permissions: Object.keys(requiredPermissions).length > 0 ? requiredPermissions : grant.permissions,
			repositoryIds: input.repositoryIds,
		});
		const rawToken = String(token?.token ?? '');
		if (!rawToken) throw failClosedError('github_app_token_blocked', 'GitHub App did not return an installation token.');
		const evidence = tokenEvidence(rawToken);
		const issuedAt = now().toISOString();
		const expiresAt = token?.expiresAt ?? token?.expires_at ?? null;
		const issuance = await store.recordGitHubAppTokenIssuance({
			teamId,
			projectId: input.projectId ?? grant.projectId ?? null,
			assignmentId: input.assignmentId ?? null,
			providerId: input.providerId ?? null,
			workdayId: input.workdayId ?? null,
			operationId: input.operationId ?? null,
			repository,
			installationId,
			status: 'issued',
			tokenPrefix: evidence.tokenPrefix,
			tokenHash: evidence.tokenHash,
			permissions: token?.permissions ?? requiredPermissions ?? grant.permissions,
			allowedOperations: Array.isArray(input.allowedOperations) ? input.allowedOperations : [],
			expiresAt,
			issuedAt,
			metadata: {
				ref: input.ref ?? null,
				paths: Array.isArray(input.paths) ? input.paths : [],
				requester: objectValue(input.requester),
			},
		});
		return {
			token: rawToken,
			expiresAt,
			permissions: token?.permissions ?? requiredPermissions ?? grant.permissions,
			issuance,
		};
	}

	async function applyWebhookEvent(input: any) {
		const event = String(input.event ?? '');
		const payload = objectValue(input.payload);
		const teamId = String(input.teamId ?? payload?.installation?.account?.login ?? payload?.organization?.login ?? payload?.sender?.login ?? 'github-app');
		const installation = payload.installation;
		const installationId = installation?.id == null ? null : String(installation.id);
		if (!installationId) return { ignored: true, reason: 'missing_installation_id' };
		const action = String(payload.action ?? '');
		if (event === 'installation') {
			const status = action === 'deleted' ? 'revoked' : installation?.suspended_at || action === 'suspend' ? 'suspended' : 'active';
			const record = await store.upsertGitHubAppInstallationRecord({
				teamId,
				installationId,
				accountLogin: installation?.account?.login ?? null,
				accountId: installation?.account?.id == null ? null : String(installation.account.id),
				accountType: installation?.account?.type ?? null,
				status,
				permissions: objectValue(installation?.permissions),
				repositorySelection: installation?.repository_selection ?? null,
				revokedAt: status === 'revoked' ? now().toISOString() : null,
				suspendedAt: status === 'suspended' ? (installation?.suspended_at ?? now().toISOString()) : null,
				driftCode: status === 'revoked' ? 'github_installation_revoked' : status === 'suspended' ? 'github_installation_suspended' : null,
				metadata: { event, action },
			});
			if (status !== 'active') {
				for (const grant of await store.listGitHubRepositoryGrants({ teamId, limit: 500 })) {
					if (String(grant.installationId ?? '') === installationId) {
						await store.updateGitHubRepositoryGrantStatus(grant.id, status === 'revoked' ? 'revoked' : 'drifted', {
							driftCode: status === 'revoked' ? 'github_installation_revoked' : 'github_installation_suspended',
						});
					}
				}
			}
			return { installation: record, grantsUpdated: status === 'active' ? 0 : undefined };
		}
		if (event === 'installation_repositories') {
			const repositoriesRemoved = Array.isArray(payload.repositories_removed) ? payload.repositories_removed : [];
			const repositoriesAdded = Array.isArray(payload.repositories_added) ? payload.repositories_added : [];
			for (const repo of repositoriesRemoved) {
				const repository = repositoryFromGitHub(repo);
				const grants = await store.listGitHubRepositoryGrants({ teamId, limit: 500 });
				const grant = grants.find((candidate: any) => normalizeRepository(candidate.repository) === repository && String(candidate.installationId ?? '') === installationId);
				if (grant) await store.updateGitHubRepositoryGrantStatus(grant.id, 'drifted', { driftCode: 'github_repository_removed' });
			}
			for (const repo of repositoriesAdded) {
				const repository = repositoryFromGitHub(repo);
				if (!repository) continue;
				await store.upsertGitHubRepositoryGrant({
					teamId,
					repository,
					installationId,
					accountLogin: installation?.account?.login ?? null,
					accountId: installation?.account?.id == null ? null : String(installation.account.id),
					status: 'active',
					permissions: objectValue(repo?.permissions ?? installation?.permissions),
					metadata: { event, action },
				});
			}
			return { repositoriesAdded: repositoriesAdded.length, repositoriesRemoved: repositoriesRemoved.length };
		}
		return { ignored: true, reason: 'unsupported_event' };
	}

	function verifyWebhook(input: { body: string | Buffer; signature?: string | null }) {
		return verifyGitHubAppWebhookSignature({
			body: input.body,
			signature: input.signature,
			webhookSecret: config.webhookSecret,
		});
	}

	return {
		config: { appId: config.appId, clientId: config.clientId, hasPrivateKey: Boolean(config.privateKey), hasWebhookSecret: Boolean(config.webhookSecret) },
		observeInstallation,
		discoverRepositoryGrants,
		mintInstallationToken,
		verifyWebhook,
		applyWebhookEvent,
	};
}
