import { createHash, randomUUID } from 'node:crypto';
import { githubActionsRequest, repositoryPath } from '../../../providers/github/actions-client.ts';
import { resolveGitHubCredentialAuthority } from '../../../security/provider-credential-authority.ts';
import { WorkflowOperationError } from './workflow-operation-error.ts';

type Principal = { id: string; roles?: string[]; permissions?: string[] } | undefined;
type Kind = 'secrets' | 'variables';
const namePattern = /^[A-Z_][A-Z0-9_]{0,99}$/u;
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const parse = (value: unknown, fallback: any = {}) => { try { return JSON.parse(String(value ?? JSON.stringify(fallback))); } catch { return fallback; } };

async function authorize(store: any, principal: Principal, projectId: string, permission: string) {
	if (!principal) throw new WorkflowOperationError(401, 'authentication_required', 'Authentication is required.');
	const details = await store.getProjectDetails(projectId);
	if (!details?.project) throw new WorkflowOperationError(404, 'project_not_found', 'The project was not found.');
	const administrator = principal.roles?.some((role) => role === 'admin' || role === 'platform_admin') || principal.permissions?.includes('*:*:*') || false;
	if (!administrator && !await store.principalCanAccessTeam(principal, details.project.teamId)) throw new WorkflowOperationError(403, 'workflow_access_denied', 'The principal cannot access this workflow configuration.');
	const summary = administrator ? { permissions: ['*:*:*'] } : await store.getTeamAccessSummary(details.project.teamId, principal);
	if (!administrator && !summary.permissions.includes(permission)) throw new WorkflowOperationError(403, 'workflow_permission_denied', `${permission} authority is required.`);
	return principal;
}

async function deliver(input: { deliveryId: string; operationId: string; payload: string | null; payloadDigest: string | null;
	keyId: string | null; expiresAt: string }) {
	const secret = text(process.env.TREESEED_PLATFORM_RUNNER_SECRET);
	const runnerUrl = text(process.env.TREESEED_OPERATIONS_RUNNER_INTERNAL_URL) || 'http://127.0.0.1:3001';
	const parsed = new URL(runnerUrl);
	if (!secret || (parsed.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(parsed.hostname))) {
		throw new WorkflowOperationError(503, 'workflow_delivery_channel_unavailable', 'A secure operations-runner delivery channel is required.');
	}
	const response = await fetch(`${runnerUrl.replace(/\/+$/u, '')}/internal/workflow-configuration-deliveries/${encodeURIComponent(input.deliveryId)}`, {
		method: 'PUT', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify({
			operationId: input.operationId, payload: input.payload, payloadDigest: input.payloadDigest, keyId: input.keyId, expiresAt: input.expiresAt,
		}),
	});
	if (!response.ok) throw new WorkflowOperationError(503, 'workflow_delivery_rejected', 'The operations runner rejected the transient workflow configuration delivery.');
}

function targetPath(repository: any, kind: Kind, scope: string, environment?: string | null, name?: string) {
	const suffix = name ? `/${encodeURIComponent(name)}` : '';
	if (scope === 'repository') return `${repositoryPath(repository.owner, repository.name)}/actions/${kind}${suffix}`;
	if (scope === 'environment' && environment) return `/repositories/${encodeURIComponent(repository.provider_repository_id)}/environments/${encodeURIComponent(environment)}/${kind}${suffix}`;
	if (scope === 'organization') return `/orgs/${encodeURIComponent(repository.owner)}/actions/${kind}${suffix}`;
	throw new WorkflowOperationError(422, 'workflow_configuration_scope_invalid', 'Choose a supported workflow configuration scope.');
}

async function configurationContext(store: any, input: { projectId: string; query: Record<string, unknown>;
	capability: 'secret-enclave' | 'workflow-configuration' }) {
	const repositoryBindingId = text(input.query.repositoryBindingId); const workflowBindingId = text(input.query.workflowBindingId);
	const scope = text(input.query.scope) || 'repository'; const environment = text(input.query.environment) || null;
	const repository = await store.first('SELECT * FROM project_remote_repository_bindings WHERE id = ? AND project_id = ?', [repositoryBindingId, input.projectId]);
	const binding = repository && await store.first(`SELECT * FROM team_service_capability_bindings WHERE id = ? AND team_id = ?
		AND connection_id = ? AND capability_type = ? AND status = 'configured'`,
		[workflowBindingId, repository.team_id, repository.service_connection_id, input.capability]);
	const authority = binding && await store.first(`SELECT * FROM provider_credential_authorities WHERE connection_id = ?
		AND credential_profile_id = ? AND status = 'ready'`, [binding.connection_id, binding.credential_profile_id]);
	if (!repository || repository.provider_id !== 'github' || !binding || !authority) throw new WorkflowOperationError(409, 'workflow_configuration_binding_unavailable', 'The workflow configuration binding is not ready.');
	const policy = parse(binding.configuration_json);
	if (scope === 'organization' && policy.organizationScopeEnabled !== true) throw new WorkflowOperationError(403, 'workflow_organization_scope_denied', 'Organization workflow configuration requires an explicitly elevated binding.');
	if (scope === 'environment') {
		const allowed = Array.isArray(policy.allowedEnvironments) ? policy.allowedEnvironments.map(String) : [];
		if (!environment || !allowed.includes(environment)) throw new WorkflowOperationError(403, 'workflow_environment_scope_denied', 'The environment is outside this workflow configuration binding.');
	}
	const credential = await resolveGitHubCredentialAuthority({ store, authorityId: authority.id,
		repositoryBindingId: repository.id, capabilityBindingId: binding.id, capability: input.capability });
	return { repository, binding, credential, scope, environment };
}

async function queueConfiguration(store: any, input: { context: any; projectId: string; actorId: string; kind: 'secret' | 'variable';
	scope: string; environment?: string | null; name: string; action: 'upsert' | 'delete'; payload?: string | null;
	keyId?: string | null; idempotencyKey: string }) {
	if (!input.idempotencyKey || input.idempotencyKey.length > 240) throw new WorkflowOperationError(422, 'workflow_configuration_idempotency_required', 'A bounded idempotency key is required.');
	const existing = await store.first(`SELECT id FROM platform_operations WHERE namespace = 'workflow'
		AND operation = 'configure' AND idempotency_key = ?`, [input.idempotencyKey]);
	if (existing) return { operation: await store.findPlatformOperationById(existing.id), replayed: true };
	const operationId = randomUUID(); const recordId = randomUUID(); const deliveryId = randomUUID();
	const now = new Date(); const expiresAt = new Date(now.getTime() + 120_000).toISOString();
	const digest = input.payload ? createHash('sha256').update(input.payload).digest('hex') : null;
	await store.run(`INSERT INTO workflow_configuration_records (id, project_id, team_id, workflow_binding_id,
		repository_binding_id, kind, scope, environment, name, status, value_digest, updated_by_user_id, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?) ON CONFLICT(repository_binding_id, workflow_binding_id,
		kind, scope, environment, name) DO UPDATE SET status = 'pending', value_digest = excluded.value_digest,
		updated_by_user_id = excluded.updated_by_user_id, updated_at = excluded.updated_at`,
		[recordId, input.projectId, input.context.repository.team_id, input.context.binding.id, input.context.repository.id,
			input.kind, input.scope, input.environment ?? null, input.name, digest, input.actorId, now.toISOString(), now.toISOString()]);
	const record: any = await store.first(`SELECT * FROM workflow_configuration_records WHERE repository_binding_id = ?
		AND workflow_binding_id = ? AND kind = ? AND scope = ? AND environment IS NOT DISTINCT FROM ? AND name = ?`,
		[input.context.repository.id, input.context.binding.id, input.kind, input.scope, input.environment ?? null, input.name]);
	await store.run(`INSERT INTO workflow_configuration_deliveries (id, operation_id, record_id, action, payload_digest,
		key_id, status, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?)`,
		[deliveryId, operationId, record.id, input.action, digest, input.keyId ?? null, expiresAt, now.toISOString(), now.toISOString()]);
	try { await deliver({ deliveryId, operationId, payload: input.payload ?? null, payloadDigest: digest, keyId: input.keyId ?? null, expiresAt }); }
	catch (error) {
		await store.run('UPDATE workflow_configuration_deliveries SET status = \'failed\', updated_at = ? WHERE id = ?', [new Date().toISOString(), deliveryId]);
		throw error;
	}
	const operation = await store.createPlatformOperation({ id: operationId, namespace: 'workflow', operation: 'configure',
		target: 'control_plane_operations_runner', idempotencyKey: input.idempotencyKey, requestedByType: 'user', requestedById: input.actorId,
		input: { deliveryId } });
	await store.recordAuditEvent({ eventType: `workflow.${input.kind}.configuration_queued`, actorType: 'user', actorId: input.actorId,
		targetType: 'workflow_configuration_record', targetId: record.id, data: { projectId: input.projectId,
			teamId: input.context.repository.team_id, kind: input.kind, scope: input.scope, environment: input.environment ?? null,
			name: input.name, action: input.action, digest } });
	return { operation, version: record.updated_at, replayed: false };
}

export function createWorkflowConfigurationService(store: any) {
	return {
		async publicKey(principal: Principal, projectId: string, query: Record<string, unknown>) {
			await authorize(store, principal, projectId, 'services:credentials:use');
			const provider = await configurationContext(store, { projectId, query, capability: 'secret-enclave' });
			const payload: any = await githubActionsRequest(fetch, provider.credential.token,
				`${targetPath(provider.repository, 'secrets', provider.scope, provider.environment)}/public-key`);
			return { keyId: payload.key_id, publicKey: payload.key };
		},
		async list(principal: Principal, projectId: string, kind: Kind, query: Record<string, unknown>) {
			await authorize(store, principal, projectId, 'projects:read:team');
			const provider = await configurationContext(store, { projectId, query,
				capability: kind === 'secrets' ? 'secret-enclave' : 'workflow-configuration' });
			const payload: any = await githubActionsRequest(fetch, provider.credential.token,
				targetPath(provider.repository, kind, provider.scope, provider.environment));
			const values = (kind === 'secrets' ? payload.secrets ?? [] : payload.variables ?? []).slice(0, 100);
			const records = await store.all(`SELECT name, updated_at FROM workflow_configuration_records WHERE repository_binding_id = ?
				AND workflow_binding_id = ? AND kind = ? AND scope = ? AND environment IS NOT DISTINCT FROM ?`,
				[provider.repository.id, provider.binding.id, kind === 'secrets' ? 'secret' : 'variable', provider.scope, provider.environment]);
			const versions = new Map(records.map((record: any) => [record.name, record.updated_at]));
			return { items: values.map((item: any) => kind === 'secrets'
				? { name: item.name, createdAt: item.created_at, updatedAt: item.updated_at, valueReadable: false, version: versions.get(item.name) ?? '0' }
				: { name: item.name, value: item.value, createdAt: item.created_at, updatedAt: item.updated_at, valueReadable: true, version: versions.get(item.name) ?? '0' }), cursor: null };
		},
		async put(principal: Principal, projectId: string, kind: Kind, nameValue: string, query: Record<string, unknown>,
			body: Record<string, unknown>, idempotencyKey?: string, ifMatch?: string) {
			const actor = await authorize(store, principal, projectId, kind === 'secrets' ? 'services:credentials:manage' : 'services:capabilities:manage');
			const name = text(nameValue).toUpperCase(); if (!namePattern.test(name)) throw new WorkflowOperationError(422, 'workflow_configuration_name_invalid', 'Configuration names use uppercase letters, numbers, and underscores.');
			const payload = kind === 'secrets' ? text(body.encryptedValue) : String(body.value ?? '');
			if (!payload || payload.length > 65_536 || (kind === 'secrets' && !/^[A-Za-z0-9+/=]+$/u.test(payload))) throw new WorkflowOperationError(422, 'workflow_configuration_value_invalid', `A valid ${kind === 'secrets' ? 'GitHub-encrypted value' : 'variable value'} is required.`);
			const provider = await configurationContext(store, { projectId, query, capability: kind === 'secrets' ? 'secret-enclave' : 'workflow-configuration' });
			if (kind === 'variables') await requireVersion(store, provider, kind, name, ifMatch);
			return queueConfiguration(store, { context: provider, projectId, actorId: actor.id, kind: kind === 'secrets' ? 'secret' : 'variable',
				scope: provider.scope, environment: provider.environment, name, action: 'upsert', payload,
				keyId: kind === 'secrets' ? text(body.keyId) : null, idempotencyKey: text(idempotencyKey) });
		},
		async remove(principal: Principal, projectId: string, kind: Kind, nameValue: string, query: Record<string, unknown>,
			idempotencyKey?: string, ifMatch?: string) {
			const actor = await authorize(store, principal, projectId, kind === 'secrets' ? 'services:credentials:manage' : 'services:capabilities:manage');
			const name = text(nameValue).toUpperCase(); if (!namePattern.test(name)) throw new WorkflowOperationError(422, 'workflow_configuration_name_invalid', 'Configuration names use uppercase letters, numbers, and underscores.');
			const provider = await configurationContext(store, { projectId, query, capability: kind === 'secrets' ? 'secret-enclave' : 'workflow-configuration' });
			if (kind === 'variables') await requireVersion(store, provider, kind, name, ifMatch);
			return queueConfiguration(store, { context: provider, projectId, actorId: actor.id, kind: kind === 'secrets' ? 'secret' : 'variable',
				scope: provider.scope, environment: provider.environment, name, action: 'delete', idempotencyKey: text(idempotencyKey) });
		},
	};
}

async function requireVersion(store: any, provider: any, kind: Kind, name: string, ifMatch?: string) {
	const record = await store.first(`SELECT updated_at FROM workflow_configuration_records WHERE repository_binding_id = ?
		AND workflow_binding_id = ? AND kind = ? AND scope = ? AND environment IS NOT DISTINCT FROM ? AND name = ?`,
		[provider.repository.id, provider.binding.id, kind === 'secrets' ? 'secret' : 'variable', provider.scope, provider.environment, name]);
	if (!ifMatch || ifMatch !== String(record?.updated_at ?? '0')) throw new WorkflowOperationError(412, 'workflow_configuration_precondition_failed', 'The workflow variable changed after it was inspected.');
}
