import { createHash, randomUUID } from 'node:crypto';
import { githubActionsRequest, repositoryPath } from '../../../../providers/github/actions-client.ts';
import { resolveGitHubCredentialAuthority } from '../../../../security/provider-credential-authority.ts';

const namePattern = /^[A-Z_][A-Z0-9_]{0,99}$/u;
const parse = (value: unknown, fallback: any = {}) => { try { return JSON.parse(String(value ?? JSON.stringify(fallback))); } catch { return fallback; } };
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';

async function deliverTransientConfiguration(input: { deliveryId: string; operationId: string; payload: string | null;
	payloadDigest: string | null; keyId: string | null; expiresAt: string }) {
	const runnerSecret = text(process.env.TREESEED_PLATFORM_RUNNER_SECRET);
	const configuredUrl = text(process.env.TREESEED_OPERATIONS_RUNNER_INTERNAL_URL);
	const runnerUrl = configuredUrl || 'http://127.0.0.1:3001';
	const parsed = new URL(runnerUrl);
	if (!runnerSecret || (parsed.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(parsed.hostname))) {
		throw Object.assign(new Error('A secure operations-runner delivery channel is required.'), { status: 503, code: 'workflow_delivery_channel_unavailable' });
	}
	const response = await fetch(`${runnerUrl.replace(/\/+$/u, '')}/internal/workflow-configuration-deliveries/${encodeURIComponent(input.deliveryId)}`, {
		method: 'PUT', headers: { authorization: `Bearer ${runnerSecret}`, 'content-type': 'application/json' },
		body: JSON.stringify({ operationId: input.operationId, payload: input.payload, payloadDigest: input.payloadDigest,
			keyId: input.keyId, expiresAt: input.expiresAt }),
	});
	if (!response.ok) throw Object.assign(new Error('The operations runner rejected the transient workflow configuration delivery.'),
		{ status: 503, code: 'workflow_delivery_rejected' });
}

function targetPath(repository: any, kind: 'secrets' | 'variables', scope: string, environment?: string | null, name?: string) {
	const suffix = name ? `/${encodeURIComponent(name)}` : '';
	if (scope === 'repository') return `${repositoryPath(repository.owner, repository.name)}/actions/${kind}${suffix}`;
	if (scope === 'environment' && environment) return `/repositories/${encodeURIComponent(repository.provider_repository_id)}/environments/${encodeURIComponent(environment)}/${kind}${suffix}`;
	if (scope === 'organization') return `/orgs/${encodeURIComponent(repository.owner)}/actions/${kind}${suffix}`;
	throw Object.assign(new Error('Choose a supported workflow configuration scope.'), { status: 422, code: 'workflow_configuration_scope_invalid' });
}

async function configurationContext(store: any, input: { projectId: string; repositoryBindingId: string;
	workflowBindingId: string; capability: 'secret-enclave' | 'workflow-configuration'; scope: string; environment?: string | null }) {
	const repository = await store.first(`SELECT * FROM project_remote_repository_bindings WHERE id = ? AND project_id = ?`,
		[input.repositoryBindingId, input.projectId]);
	const binding = repository && await store.first(`SELECT * FROM team_service_capability_bindings WHERE id = ?
		AND team_id = ? AND connection_id = ? AND capability_type = ? AND status = 'configured'`,
		[input.workflowBindingId, repository.team_id, repository.service_connection_id, input.capability]);
	const authority = binding && await store.first(`SELECT * FROM provider_credential_authorities WHERE connection_id = ?
		AND credential_profile_id = ? AND status = 'ready'`, [binding.connection_id, binding.credential_profile_id]);
	if (!repository || repository.provider_id !== 'github' || !binding || !authority) throw Object.assign(new Error('The workflow configuration binding is not ready.'), { status: 409, code: 'workflow_configuration_binding_unavailable' });
	const policy = parse(binding.configuration_json);
	if (input.scope === 'organization' && policy.organizationScopeEnabled !== true) throw Object.assign(new Error('Organization workflow configuration requires an explicitly elevated binding.'), { status: 403, code: 'workflow_organization_scope_denied' });
	if (input.scope === 'environment') {
		const allowed = Array.isArray(policy.allowedEnvironments) ? policy.allowedEnvironments.map(String) : [];
		if (!input.environment || !allowed.includes(input.environment)) throw Object.assign(new Error('The environment is outside this workflow configuration binding.'), { status: 403, code: 'workflow_environment_scope_denied' });
	}
	const credential = await resolveGitHubCredentialAuthority({ store, authorityId: authority.id,
		repositoryBindingId: repository.id, capabilityBindingId: binding.id, capability: input.capability });
	return { repository, binding, authority, credential };
}

async function queueConfiguration(store: any, input: { context: any; projectId: string; actorId: string; kind: 'secret' | 'variable';
	scope: string; environment?: string | null; name: string; action: 'upsert' | 'delete'; payload?: string | null; keyId?: string | null;
	idempotencyKey: string }) {
	if (!input.idempotencyKey || input.idempotencyKey.length > 240) throw Object.assign(new Error('A bounded idempotency key is required.'), { status: 422, code: 'workflow_configuration_idempotency_required' });
	const existingOperation = await store.first(`SELECT id FROM platform_operations WHERE namespace = 'workflow'
		AND operation = 'configure' AND idempotency_key = ?`, [input.idempotencyKey]);
	if (existingOperation) return store.findPlatformOperationById(existingOperation.id);
	const operationId = randomUUID(); const recordId = randomUUID(); const deliveryId = randomUUID();
	const now = new Date(); const expiresAt = new Date(now.getTime() + 120_000).toISOString();
	const digest = input.payload ? createHash('sha256').update(input.payload).digest('hex') : null;
	await store.run(`INSERT INTO workflow_configuration_records
		(id, project_id, team_id, workflow_binding_id, repository_binding_id, kind, scope, environment, name, status,
		 value_digest, updated_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
		 ON CONFLICT(repository_binding_id, workflow_binding_id, kind, scope, environment, name) DO UPDATE SET status = 'pending',
		 value_digest = excluded.value_digest, updated_by_user_id = excluded.updated_by_user_id, updated_at = excluded.updated_at`,
		[recordId, input.projectId, input.context.repository.team_id, input.context.binding.id, input.context.repository.id,
			input.kind, input.scope, input.environment ?? null, input.name, digest, input.actorId, now.toISOString(), now.toISOString()]);
	const record: any = await store.first(`SELECT * FROM workflow_configuration_records WHERE repository_binding_id = ?
		AND workflow_binding_id = ? AND kind = ? AND scope = ? AND environment IS NOT DISTINCT FROM ? AND name = ?`,
		[input.context.repository.id, input.context.binding.id, input.kind, input.scope, input.environment ?? null, input.name]);
	await store.run(`INSERT INTO workflow_configuration_deliveries
		(id, operation_id, record_id, action, payload_digest, key_id, status, expires_at, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?)`, [deliveryId, operationId, record.id, input.action,
		digest, input.keyId ?? null, expiresAt, now.toISOString(), now.toISOString()]);
	try {
		await deliverTransientConfiguration({ deliveryId, operationId, payload: input.payload ?? null,
			payloadDigest: digest, keyId: input.keyId ?? null, expiresAt });
	} catch (error) {
		await store.run(`UPDATE workflow_configuration_deliveries SET status = 'failed', updated_at = ? WHERE id = ?`,
			[new Date().toISOString(), deliveryId]);
		throw error;
	}
	const operation = await store.createPlatformOperation({ id: operationId, namespace: 'workflow', operation: 'configure',
		target: 'market_operations_runner', idempotencyKey: input.idempotencyKey, requestedByType: 'user', requestedById: input.actorId,
		input: { deliveryId } });
	await store.recordAuditEvent({ eventType: `workflow.${input.kind}.configuration_queued`, actorType: 'user', actorId: input.actorId,
		targetType: 'workflow_configuration_record', targetId: record.id, data: { projectId: input.projectId,
			teamId: input.context.repository.team_id, kind: input.kind, scope: input.scope, environment: input.environment ?? null,
			name: input.name, action: input.action, digest } });
	return operation;
}

export function installProjectWorkflowConfigurationRoutes(context: any) {
	const { app, store, requireProjectAccess, jsonError } = context;
	const resolve = async (c: any, capability: 'secret-enclave' | 'workflow-configuration') => configurationContext(store, {
		projectId: c.req.param('projectId'), repositoryBindingId: text(c.req.query('repositoryBindingId')),
		workflowBindingId: text(c.req.query('workflowBindingId')), capability, scope: text(c.req.query('scope')) || 'repository',
		environment: text(c.req.query('environment')) || null,
	});

	app.get('/v1/projects/:projectId/workflow-configuration/secrets/public-key', async (c: any) => {
		const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'services:credentials:use');
		if (access.response) return access.response;
		try {
			const provider = await resolve(c, 'secret-enclave');
			const path = `${targetPath(provider.repository, 'secrets', text(c.req.query('scope')) || 'repository', text(c.req.query('environment')) || null)}/public-key`;
			const payload = await githubActionsRequest(fetch, provider.credential.token, path) as any;
			return c.json({ ok: true, payload: { keyId: payload.key_id, publicKey: payload.key } }, 200, { 'Cache-Control': 'private, no-store' });
		} catch (error: any) { return jsonError(c, error.status ?? 503, error.message, { code: error.code ?? 'workflow_configuration_unavailable' }); }
	});

	for (const kind of ['secrets', 'variables'] as const) app.get(`/v1/projects/:projectId/workflow-configuration/${kind}`, async (c: any) => {
		const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
		if (access.response) return access.response;
		try {
			const provider = await resolve(c, kind === 'secrets' ? 'secret-enclave' : 'workflow-configuration');
			const payload = await githubActionsRequest(fetch, provider.credential.token,
				targetPath(provider.repository, kind, text(c.req.query('scope')) || 'repository', text(c.req.query('environment')) || null)) as any;
			const values = kind === 'secrets' ? payload.secrets ?? [] : payload.variables ?? [];
			return c.json({ ok: true, payload: values.slice(0, 100).map((item: any) => kind === 'secrets'
				? { name: item.name, createdAt: item.created_at, updatedAt: item.updated_at, valueReadable: false }
				: { name: item.name, value: item.value, createdAt: item.created_at, updatedAt: item.updated_at, valueReadable: true }) },
				200, { 'Cache-Control': 'private, no-store' });
		} catch (error: any) { return jsonError(c, error.status ?? 503, error.message, { code: error.code ?? 'workflow_configuration_unavailable' }); }
	});

	for (const kind of ['secrets', 'variables'] as const) {
		app.put(`/v1/projects/:projectId/workflow-configuration/${kind}/:name`, async (c: any) => {
			const permission = kind === 'secrets' ? 'services:credentials:manage' : 'services:capabilities:manage';
			const access = await requireProjectAccess(c, store, c.req.param('projectId'), permission);
			if (access.response) return access.response;
			const name = text(c.req.param('name')).toUpperCase(); const body = await c.req.json().catch(() => ({}));
			if (!namePattern.test(name)) return jsonError(c, 422, 'Configuration names use uppercase letters, numbers, and underscores.');
			const payload = kind === 'secrets' ? text(body.encryptedValue) : String(body.value ?? '');
			if (!payload || payload.length > 65_536 || (kind === 'secrets' && !/^[A-Za-z0-9+/=]+$/u.test(payload))) return jsonError(c, 422, `A valid ${kind === 'secrets' ? 'GitHub-encrypted value' : 'variable value'} is required.`);
			try {
				const provider = await resolve(c, kind === 'secrets' ? 'secret-enclave' : 'workflow-configuration');
				const operation = await queueConfiguration(store, { context: provider, projectId: c.req.param('projectId'), actorId: access.principal.id,
					kind: kind === 'secrets' ? 'secret' : 'variable', scope: text(c.req.query('scope')) || 'repository',
					environment: text(c.req.query('environment')) || null, name, action: 'upsert', payload,
					keyId: kind === 'secrets' ? text(body.keyId) : null,
					idempotencyKey: text(c.req.header('idempotency-key')) || text(body.idempotencyKey) });
				return c.json({ ok: true, payload: operation }, 202);
			} catch (error: any) { return jsonError(c, error.status ?? 400, error.message, { code: error.code ?? 'workflow_configuration_invalid' }); }
		});
		app.delete(`/v1/projects/:projectId/workflow-configuration/${kind}/:name`, async (c: any) => {
			const permission = kind === 'secrets' ? 'services:credentials:manage' : 'services:capabilities:manage';
			const access = await requireProjectAccess(c, store, c.req.param('projectId'), permission);
			if (access.response) return access.response;
			const name = text(c.req.param('name')).toUpperCase();
			try {
				const provider = await resolve(c, kind === 'secrets' ? 'secret-enclave' : 'workflow-configuration');
				const operation = await queueConfiguration(store, { context: provider, projectId: c.req.param('projectId'), actorId: access.principal.id,
					kind: kind === 'secrets' ? 'secret' : 'variable', scope: text(c.req.query('scope')) || 'repository',
					environment: text(c.req.query('environment')) || null, name, action: 'delete',
					idempotencyKey: text(c.req.header('idempotency-key')) });
				return c.json({ ok: true, payload: operation }, 202);
			} catch (error: any) { return jsonError(c, error.status ?? 400, error.message, { code: error.code ?? 'workflow_configuration_invalid' }); }
		});
	}
}
