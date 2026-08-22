import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { RepositoryWorkdayProfileService, REPOSITORY_WORKDAY_PROFILE_PATH } from '../../capacity/services/capacity/workdays/policy/repository-workday-profile-service.ts';
import { reconciledWorkflowRunStatus } from '../../../providers/github/actions-client.ts';
import { githubConnectorConfig, githubConnectorRequiredPermissions, isGitHubConnectorKind } from '../../../security/github-connector-config.ts';
import { resolveGitHubCredentialAuthority } from '../../../security/provider-credential-authority.ts';
import { verifyGitHubInstallation } from './github-connector-client.ts';
import { WorkflowOperationError } from './workflow-operation-error.ts';

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function validSignature(body: string, signature: string, secret: string) {
	if (!signature.startsWith('sha256=')) return false;
	const expected = createHmac('sha256', secret).update(body).digest();
	let actual: Buffer; try { actual = Buffer.from(signature.slice(7), 'hex'); } catch { return false; }
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function reconcileInstallation(store: any, kind: 'repository' | 'workflow', installationId: string) {
	const config = githubConnectorConfig(kind);
	const installation = await verifyGitHubInstallation({ appId: config.appId, privateKey: config.privateKey, installationId,
		requiredPermissions: githubConnectorRequiredPermissions(kind) });
	const authorities: any[] = await store.all(`SELECT a.*, c.non_secret_config_json FROM provider_credential_authorities a
		JOIN team_service_connections c ON c.id = a.connection_id WHERE a.credential_profile_id = ?`, [config.profileId]);
	for (const authority of authorities) {
		let connectionConfig: any = {}; try { connectionConfig = JSON.parse(authority.non_secret_config_json ?? '{}'); } catch { /* unavailable */ }
		if (String(connectionConfig.githubConnectors?.[kind]?.installationId ?? '') !== installationId) continue;
		const now = new Date().toISOString();
		await store.run("UPDATE provider_credential_authorities SET status = 'ready', updated_at = ? WHERE id = ?", [now, authority.id]);
		await store.run("UPDATE team_service_connections SET status = 'active', last_validated_at = ?, updated_at = ? WHERE id = ?", [now, now, authority.connection_id]);
		if (kind !== 'repository') continue;
		const bindings: any[] = await store.all('SELECT * FROM project_remote_repository_bindings WHERE service_connection_id = ?', [authority.connection_id]);
		for (const binding of bindings) {
			try {
				const credential = await resolveGitHubCredentialAuthority({ store, authorityId: authority.id, repositoryBindingId: binding.id, capability: 'repository-hosting' });
				const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(binding.owner)}/${encodeURIComponent(binding.name)}`, { headers: {
					accept: 'application/vnd.github+json', authorization: `Bearer ${credential.token}`, 'user-agent': 'treeseed-provider-webhook', 'x-github-api-version': '2022-11-28' } });
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				await store.run("UPDATE project_remote_repository_bindings SET grant_status = 'ready', drift = 'unknown', updated_at = ? WHERE id = ?", [now, binding.id]);
			} catch { await store.run("UPDATE project_remote_repository_bindings SET grant_status = 'revoked', drift = 'unauthorized', updated_at = ? WHERE id = ?", [now, binding.id]); }
		}
	}
	return installation;
}

async function invalidateInstallation(store: any, kind: 'repository' | 'workflow', installationId: string, action: string) {
	const config = githubConnectorConfig(kind);
	const authorities: any[] = await store.all(`SELECT a.*, c.non_secret_config_json FROM provider_credential_authorities a
		JOIN team_service_connections c ON c.id = a.connection_id WHERE a.credential_profile_id = ?`, [config.profileId]);
	const now = new Date().toISOString(); const affected: string[] = [];
	for (const authority of authorities) {
		let connectionConfig: any = {}; try { connectionConfig = JSON.parse(authority.non_secret_config_json ?? '{}'); } catch { /* cannot match */ }
		if (String(connectionConfig.githubConnectors?.[kind]?.installationId ?? '') !== installationId) continue;
		affected.push(authority.id);
		await store.run("UPDATE provider_credential_authorities SET status = 'reauthorization-required', version = version + 1, updated_at = ? WHERE id = ?", [now, authority.id]);
		await store.run("UPDATE team_service_connections SET status = 'reauthorization-required', updated_at = ? WHERE id = ?", [now, authority.connection_id]);
		if (kind === 'repository') await store.run("UPDATE project_remote_repository_bindings SET grant_status = 'reauthorization-required', drift = 'unavailable', version = version + 1, updated_at = ? WHERE service_connection_id = ?", [now, authority.connection_id]);
		await store.recordAuditEvent?.({ eventType: 'provider.connector.authorization_lost', actorType: 'service', actorId: `github-${kind}-webhook`,
			targetType: 'team_service_connection', targetId: authority.connection_id,
			data: { teamId: authority.team_id, providerId: 'github', connectorKind: kind, installationId, action } });
	}
	return { installationId, action, affectedAuthorityIds: affected };
}

export function assertWorkflowWebhookScope(payload: any, run: any, operation: any, repository: any) {
	const providerRun = payload.workflow_run ?? {}; const repositoryPayload = payload.repository ?? {};
	const workflowPath = String(providerRun.path ?? '').split('@', 1)[0];
	if (String(providerRun.event ?? '') !== 'workflow_dispatch' || String(providerRun.head_sha ?? '') !== String(run.source_sha)
		|| workflowPath !== String(operation.workflow_id) || String(repositoryPayload.id ?? '') !== String(repository.provider_repository_id)
		|| String(repositoryPayload.full_name ?? '').toLowerCase() !== `${repository.owner}/${repository.name}`.toLowerCase()) {
		throw new Error('The workflow webhook does not match the authorized run scope.');
	}
}

async function reconcileWorkflowRun(store: any, payload: any) {
	const providerRunId = String(payload.workflow_run?.id ?? ''); const correlation = String(payload.workflow_run?.display_title ?? payload.workflow_run?.name ?? '');
	const run: any = providerRunId ? await store.first('SELECT * FROM workflow_operation_runs WHERE provider_run_id = ?', [providerRunId]) : null;
	const correlated: any = run ?? (correlation ? await store.first("SELECT * FROM workflow_operation_runs WHERE ? LIKE '%' || correlation_id || '%' ORDER BY created_at DESC LIMIT 1", [correlation]) : null);
	if (!correlated) return null;
	const operation: any = await store.first('SELECT * FROM project_workflow_operations WHERE id = ?', [correlated.operation_id]);
	const repository: any = operation ? await store.first('SELECT * FROM project_remote_repository_bindings WHERE id = ?', [operation.repository_binding_id]) : null;
	if (!operation || !repository) throw new Error('The correlated workflow binding no longer exists.');
	assertWorkflowWebhookScope(payload, correlated, operation, repository);
	const credential = await resolveGitHubCredentialAuthority({ store, authorityId: repository.authority_id,
		repositoryBindingId: repository.id, capabilityBindingId: operation.workflow_binding_id, capability: 'workflow-execution' });
	const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/actions/runs/${providerRunId}`, { headers: {
		accept: 'application/vnd.github+json', authorization: `Bearer ${credential.token}`, 'user-agent': 'treeseed-provider-webhook', 'x-github-api-version': '2022-11-28' } });
	if (!response.ok) throw new Error(`GitHub workflow read-back failed (HTTP ${response.status}).`);
	const observed: any = await response.json(); assertWorkflowWebhookScope({ workflow_run: observed, repository: payload.repository }, correlated, operation, repository);
	const status = reconciledWorkflowRunStatus(String(correlated.status ?? ''), String(observed.status ?? ''), observed.conclusion ?? null);
	await store.run('UPDATE workflow_operation_runs SET provider_run_id = ?, provider_run_url = ?, status = ?, updated_at = ? WHERE id = ?',
		[String(observed.id), String(observed.html_url ?? ''), status, new Date().toISOString(), correlated.id]);
	return { runId: correlated.id, providerRunId: String(observed.id), status, conclusion: observed.conclusion ?? null };
}

export async function reconcileRepositoryPush(store: any, payload: any) {
	const fullName = String(payload.repository?.full_name ?? '').toLowerCase(); const [owner, name, ...rest] = fullName.split('/');
	const ref = String(payload.ref ?? ''); const commit = String(payload.after ?? '').toLowerCase();
	if (!owner || !name || rest.length || !/^refs\/heads\/[A-Za-z0-9._/-]+$/u.test(ref) || !/^[a-f0-9]{40}$/u.test(commit)) throw new Error('GitHub push webhook omitted exact repository, ref, or commit identity.');
	const binding: any = await store.first('SELECT * FROM project_remote_repository_bindings WHERE LOWER(owner)=? AND LOWER(name)=? LIMIT 1', [owner, name]);
	if (!binding) return null;
	if (String(payload.repository?.id ?? '') !== String(binding.provider_repository_id ?? '')) throw new Error('GitHub push repository identity does not match the authorized binding.');
	if (ref !== `refs/heads/${String(binding.publication_ref ?? '')}` || /^0{40}$/u.test(commit)) return null;
	return { repository: fullName, observedCommit: commit, status: 'awaiting-required-check' };
}

export async function reconcileRepositoryCheckRun(store: any, payload: any) {
	const fullName = String(payload.repository?.full_name ?? '').toLowerCase(); const [owner, name, ...rest] = fullName.split('/');
	const checkRunId = String(payload.check_run?.id ?? '');
	if (!owner || !name || rest.length || !/^\d+$/u.test(checkRunId)) throw new Error('GitHub check-run webhook omitted exact repository or check identity.');
	const binding: any = await store.first('SELECT * FROM project_remote_repository_bindings WHERE LOWER(owner)=? AND LOWER(name)=? LIMIT 1', [owner, name]);
	if (!binding) return null;
	if (String(payload.repository?.id ?? '') !== String(binding.provider_repository_id ?? '')) throw new Error('GitHub check-run repository identity does not match the authorized binding.');
	const credential = await resolveGitHubCredentialAuthority({ store, authorityId: binding.authority_id, repositoryBindingId: binding.id, capability: 'repository-hosting' });
	const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${credential.token}`, 'user-agent': 'treeseed-provider-webhook', 'x-github-api-version': '2022-11-28' };
	const checkResponse = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/check-runs/${encodeURIComponent(checkRunId)}`, { headers });
	if (!checkResponse.ok) throw new Error(`GitHub required-check read-back failed (HTTP ${checkResponse.status}).`);
	const check: any = await checkResponse.json(); const commit = String(check.head_sha ?? '').toLowerCase();
	if (String(check.name ?? '') !== 'verify' || String(check.status ?? '') !== 'completed' || String(check.conclusion ?? '') !== 'success'
		|| String(check.check_suite?.head_branch ?? '') !== String(binding.publication_ref ?? '') || String(check.app?.slug ?? '') !== 'github-actions'
		|| !/^[a-f0-9]{40}$/u.test(commit) || /^0{40}$/u.test(commit)) return null;
	const ref = `refs/heads/${String(binding.publication_ref ?? '')}`;
	const refResponse = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/ref/heads/${String(binding.publication_ref ?? '').split('/').map(encodeURIComponent).join('/')}`, { headers });
	if (!refResponse.ok) throw new Error(`GitHub publication-ref read-back failed (HTTP ${refResponse.status}).`);
	const currentRef: any = await refResponse.json();
	if (String(currentRef.object?.sha ?? '').toLowerCase() !== commit) return { repository: fullName, observedCommit: commit, status: 'stale-required-check' };
	const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${REPOSITORY_WORKDAY_PROFILE_PATH.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(commit)}`, { headers: { ...headers, accept: 'application/vnd.github.raw+json' } });
	if (response.status === 404) return { repository: fullName, observedCommit: commit, status: 'no-profile' };
	if (!response.ok) throw new Error(`GitHub repository profile read-back failed (HTTP ${response.status}).`);
	return new RepositoryWorkdayProfileService(store).reconcile({ repository: fullName, ref, commit,
		path: REPOSITORY_WORKDAY_PROFILE_PATH, content: await response.text() });
}

export function createGitHubWebhookService(store: any) {
	return async (kindValue: string, payload: Record<string, unknown>, rawBody: string | undefined, headers: Readonly<Record<string, string>> = {}) => {
		if (!isGitHubConnectorKind(kindValue)) throw new WorkflowOperationError(404, 'connector_not_found', 'Connector not found.');
		if (!headers['content-type']?.toLowerCase().startsWith('application/json')) throw new WorkflowOperationError(400, 'webhook_content_type_invalid', 'A JSON webhook body is required.');
		const declaredSize = Number(headers['content-length'] || 0); if (declaredSize > MAX_BODY_BYTES || Buffer.byteLength(rawBody ?? '') > MAX_BODY_BYTES) throw new WorkflowOperationError(400, 'webhook_body_too_large', 'Webhook body is too large.');
		let config; try { config = githubConnectorConfig(kindValue); } catch { throw new WorkflowOperationError(503, 'connector_unavailable', 'Connector is unavailable.'); }
		if (!rawBody || !validSignature(rawBody, headers['x-hub-signature-256'] ?? '', config.webhookSecret)) throw new WorkflowOperationError(401, 'webhook_signature_invalid', 'Webhook signature is invalid.');
		const deliveryId = headers['x-github-delivery'] ?? ''; const eventType = headers['x-github-event'] ?? '';
		if (!deliveryId || !eventType) throw new WorkflowOperationError(400, 'webhook_metadata_invalid', 'Webhook delivery metadata is incomplete.');
		if (await store.first('SELECT id FROM provider_webhook_deliveries WHERE provider_id = ? AND delivery_id = ?', [`github-${kindValue}`, deliveryId])) return { code: 'webhook_replay_ignored' };
		const recordId = randomUUID(); const now = new Date().toISOString();
		await store.run(`INSERT INTO provider_webhook_deliveries (id, provider_id, delivery_id, event_type, status, body_digest, received_at)
			VALUES (?, ?, ?, ?, 'received', ?, ?)`, [recordId, `github-${kindValue}`, deliveryId, eventType, createHash('sha256').update(rawBody).digest('hex'), now]);
		try {
			let correlation: any = null; const kind = kindValue as 'repository' | 'workflow';
			if (['installation', 'installation_repositories'].includes(eventType)) {
				const installationId = String((payload as any).installation?.id ?? ''); const action = String((payload as any).action ?? '');
				if (!installationId) throw new Error('GitHub installation webhook omitted the installation identifier.');
				correlation = eventType === 'installation' && ['deleted', 'suspend'].includes(action)
					? await invalidateInstallation(store, kind, installationId, action) : await reconcileInstallation(store, kind, installationId);
			} else if (kind === 'workflow' && eventType === 'workflow_run') correlation = await reconcileWorkflowRun(store, payload);
			else if (kind === 'repository' && eventType === 'push') correlation = await reconcileRepositoryPush(store, payload);
			else if (kind === 'repository' && eventType === 'check_run') correlation = await reconcileRepositoryCheckRun(store, payload);
			await store.run("UPDATE provider_webhook_deliveries SET status = 'processed', correlation_id = ?, processed_at = ? WHERE id = ?",
				[correlation?.runId ?? correlation?.installationId ?? null, new Date().toISOString(), recordId]);
			return { code: 'webhook_processed' };
		} catch (error) {
			await store.run("UPDATE provider_webhook_deliveries SET status = 'failed', processed_at = ? WHERE id = ?", [new Date().toISOString(), recordId]);
			console.warn(`[provider-webhook] ${kindValue}/${eventType} reconciliation failed for ${deliveryId}:`, error instanceof Error ? error.message : String(error));
			throw new WorkflowOperationError(503, 'webhook_reconciliation_failed', 'Authoritative provider reconciliation failed.');
		}
	};
}
