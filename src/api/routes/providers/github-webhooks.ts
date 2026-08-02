import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { githubConnectorConfig, githubConnectorRequiredPermissions, isGitHubConnectorKind } from '../../../security/github-connector-config.ts';
import { resolveGitHubCredentialAuthority } from '../../../security/provider-credential-authority.ts';
import { reconciledWorkflowRunStatus } from '../../../providers/github/actions-client.ts';
import { verifyGitHubInstallation } from './github-connector-api.ts';

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function validSignature(body: string, signature: string, secret: string) {
	if (!signature.startsWith('sha256=')) return false;
	const expected = createHmac('sha256', secret).update(body).digest();
	let actual: Buffer;
	try { actual = Buffer.from(signature.slice(7), 'hex'); } catch { return false; }
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function reconcileInstallation(store: any, kind: 'repository' | 'workflow', installationId: string) {
	const config = githubConnectorConfig(kind);
	const installation = await verifyGitHubInstallation({ appId: config.appId, privateKey: config.privateKey, installationId,
		requiredPermissions: githubConnectorRequiredPermissions(kind) });
	const authorities: any[] = await store.all(`SELECT a.*, c.non_secret_config_json FROM provider_credential_authorities a
		JOIN team_service_connections c ON c.id = a.connection_id WHERE a.credential_profile_id = ?`, [config.profileId]);
	for (const authority of authorities) {
		let connectionConfig: any = {};
		try { connectionConfig = JSON.parse(authority.non_secret_config_json ?? '{}'); } catch { /* invalid config remains unavailable */ }
		const configured = connectionConfig.githubConnectors?.[kind];
		if (String(configured?.installationId ?? '') !== installationId) continue;
		const now = new Date().toISOString();
		await store.run(`UPDATE provider_credential_authorities SET status = 'ready', updated_at = ? WHERE id = ?`, [now, authority.id]);
		await store.run(`UPDATE team_service_connections SET status = 'active', last_validated_at = ?, updated_at = ? WHERE id = ?`, [now, now, authority.connection_id]);
		if (kind !== 'repository') continue;
		const bindings: any[] = await store.all(`SELECT * FROM project_remote_repository_bindings WHERE service_connection_id = ?`, [authority.connection_id]);
		for (const binding of bindings) {
			try {
				const credential = await resolveGitHubCredentialAuthority({ store, authorityId: authority.id,
					repositoryBindingId: binding.id, capability: 'repository-hosting' });
				const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(binding.owner)}/${encodeURIComponent(binding.name)}`, {
					headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${credential.token}`,
						'user-agent': 'treeseed-provider-webhook', 'x-github-api-version': '2022-11-28' },
				});
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				await store.run(`UPDATE project_remote_repository_bindings SET grant_status = 'ready', drift = 'unknown', updated_at = ? WHERE id = ?`, [now, binding.id]);
			} catch {
				await store.run(`UPDATE project_remote_repository_bindings SET grant_status = 'revoked', drift = 'unauthorized', updated_at = ? WHERE id = ?`, [now, binding.id]);
			}
		}
	}
	return installation;
}

async function invalidateInstallation(store: any, kind: 'repository' | 'workflow', installationId: string, action: string) {
	const config = githubConnectorConfig(kind);
	const authorities: any[] = await store.all(`SELECT a.*, c.non_secret_config_json FROM provider_credential_authorities a
		JOIN team_service_connections c ON c.id = a.connection_id WHERE a.credential_profile_id = ?`, [config.profileId]);
	const now = new Date().toISOString();
	const affected: string[] = [];
	for (const authority of authorities) {
		let connectionConfig: any = {};
		try { connectionConfig = JSON.parse(authority.non_secret_config_json ?? '{}'); } catch { /* invalid config cannot match */ }
		if (String(connectionConfig.githubConnectors?.[kind]?.installationId ?? '') !== installationId) continue;
		affected.push(authority.id);
		await store.run(`UPDATE provider_credential_authorities SET status = 'reauthorization-required',
			version = version + 1, updated_at = ? WHERE id = ?`, [now, authority.id]);
		await store.run(`UPDATE team_service_connections SET status = 'reauthorization-required', updated_at = ? WHERE id = ?`,
			[now, authority.connection_id]);
		if (kind === 'repository') {
			await store.run(`UPDATE project_remote_repository_bindings SET grant_status = 'reauthorization-required',
				drift = 'unavailable', version = version + 1, updated_at = ? WHERE service_connection_id = ?`,
				[now, authority.connection_id]);
		}
		await store.recordAuditEvent?.({ eventType: 'provider.connector.authorization_lost', actorType: 'service',
			actorId: `github-${kind}-webhook`, targetType: 'team_service_connection', targetId: authority.connection_id,
			data: { teamId: authority.team_id, providerId: 'github', connectorKind: kind, installationId, action } });
	}
	return { installationId, action, affectedAuthorityIds: affected };
}

export function assertWorkflowWebhookScope(payload: any, run: any, operation: any, repository: any) {
	const providerRun = payload.workflow_run ?? {};
	const repositoryPayload = payload.repository ?? {};
	const workflowPath = String(providerRun.path ?? '').split('@', 1)[0];
	if (String(providerRun.event ?? '') !== 'workflow_dispatch'
		|| String(providerRun.head_sha ?? '') !== String(run.source_sha)
		|| workflowPath !== String(operation.workflow_id)
		|| String(repositoryPayload.id ?? '') !== String(repository.provider_repository_id)
		|| String(repositoryPayload.full_name ?? '').toLowerCase()
			!== `${repository.owner}/${repository.name}`.toLowerCase()) {
		throw new Error('The workflow webhook does not match the authorized run scope.');
	}
}

async function reconcileWorkflowRun(store: any, payload: any) {
	const providerRunId = String(payload.workflow_run?.id ?? '');
	const correlation = String(payload.workflow_run?.display_title ?? payload.workflow_run?.name ?? '');
	const run: any = providerRunId
		? await store.first(`SELECT * FROM workflow_operation_runs WHERE provider_run_id = ?`, [providerRunId])
		: null;
	const correlated: any = run ?? (correlation
		? await store.first(`SELECT * FROM workflow_operation_runs WHERE ? LIKE '%' || correlation_id || '%' ORDER BY created_at DESC LIMIT 1`, [correlation])
		: null);
	if (!correlated) return null;
	const operation: any = await store.first(`SELECT * FROM project_workflow_operations WHERE id = ?`, [correlated.operation_id]);
	const repository: any = operation ? await store.first(`SELECT * FROM project_remote_repository_bindings WHERE id = ?`, [operation.repository_binding_id]) : null;
	if (!operation || !repository) throw new Error('The correlated workflow binding no longer exists.');
	assertWorkflowWebhookScope(payload, correlated, operation, repository);
	const credential = await resolveGitHubCredentialAuthority({ store, authorityId: repository.authority_id,
		repositoryBindingId: repository.id, capabilityBindingId: operation.workflow_binding_id, capability: 'workflow-execution' });
	const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/actions/runs/${providerRunId}`, {
		headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${credential.token}`,
			'user-agent': 'treeseed-provider-webhook', 'x-github-api-version': '2022-11-28' },
	});
	if (!response.ok) throw new Error(`GitHub workflow read-back failed (HTTP ${response.status}).`);
	const observed: any = await response.json();
	assertWorkflowWebhookScope({ workflow_run: observed, repository: payload.repository }, correlated, operation, repository);
	const status = reconciledWorkflowRunStatus(String(correlated.status ?? ''), String(observed.status ?? ''), observed.conclusion ?? null);
	const now = new Date().toISOString();
	await store.run(`UPDATE workflow_operation_runs SET provider_run_id = ?, provider_run_url = ?, status = ?, updated_at = ? WHERE id = ?`,
		[String(observed.id), String(observed.html_url ?? ''), status, now, correlated.id]);
	return { runId: correlated.id, providerRunId: String(observed.id), status, conclusion: observed.conclusion ?? null };
}

export function installGitHubWebhookRoutes(context: any) {
	const { app, store, jsonError } = context;
	app.post('/v1/provider-webhooks/github/:kind', async (c: any) => {
		const kind = c.req.param('kind');
		if (!isGitHubConnectorKind(kind)) return jsonError(c, 404, 'Connector not found.');
		if (!String(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) return jsonError(c, 415, 'A JSON webhook body is required.');
		const declaredSize = Number(c.req.header('content-length') ?? 0);
		if (declaredSize > MAX_BODY_BYTES) return jsonError(c, 413, 'Webhook body is too large.');
		let config;
		try { config = githubConnectorConfig(kind); } catch { return jsonError(c, 503, 'Connector is unavailable.'); }
		const body = await c.req.text();
		if (Buffer.byteLength(body) > MAX_BODY_BYTES) return jsonError(c, 413, 'Webhook body is too large.');
		if (!validSignature(body, String(c.req.header('x-hub-signature-256') ?? ''), config.webhookSecret)) return jsonError(c, 401, 'Webhook signature is invalid.');
		const deliveryId = String(c.req.header('x-github-delivery') ?? '');
		const eventType = String(c.req.header('x-github-event') ?? '');
		if (!deliveryId || !eventType) return jsonError(c, 400, 'Webhook delivery metadata is incomplete.');
		if (await store.first(`SELECT id FROM provider_webhook_deliveries WHERE provider_id = ? AND delivery_id = ?`, [`github-${kind}`, deliveryId])) {
			return c.json({ ok: true, code: 'webhook_replay_ignored' });
		}
		let payload: any;
		try { payload = JSON.parse(body); } catch { return jsonError(c, 400, 'Webhook JSON is invalid.'); }
		const recordId = randomUUID();
		const now = new Date().toISOString();
		await store.run(`INSERT INTO provider_webhook_deliveries
			(id, provider_id, delivery_id, event_type, status, body_digest, received_at) VALUES (?, ?, ?, ?, 'received', ?, ?)`,
			[recordId, `github-${kind}`, deliveryId, eventType, createHash('sha256').update(body).digest('hex'), now]);
		try {
			let correlation: any = null;
			if (['installation', 'installation_repositories'].includes(eventType)) {
				const installationId = String(payload.installation?.id ?? '');
				const action = String(payload.action ?? '');
				if (!installationId) throw new Error('GitHub installation webhook omitted the installation identifier.');
				correlation = eventType === 'installation' && ['deleted', 'suspend'].includes(action)
					? await invalidateInstallation(store, kind, installationId, action)
					: await reconcileInstallation(store, kind, installationId);
			} else if (kind === 'workflow' && eventType === 'workflow_run') {
				correlation = await reconcileWorkflowRun(store, payload);
			}
			await store.run(`UPDATE provider_webhook_deliveries SET status = 'processed', correlation_id = ?, processed_at = ? WHERE id = ?`,
				[correlation?.runId ?? correlation?.installationId ?? null, new Date().toISOString(), recordId]);
			return c.json({ ok: true, code: 'webhook_processed' });
		} catch (error) {
			await store.run(`UPDATE provider_webhook_deliveries SET status = 'failed', processed_at = ? WHERE id = ?`, [new Date().toISOString(), recordId]);
			console.warn(`[provider-webhook] ${kind}/${eventType} reconciliation failed for ${deliveryId}:`, error instanceof Error ? error.message : String(error));
			return jsonError(c, 503, 'Authoritative provider reconciliation failed.');
		}
	});
}
