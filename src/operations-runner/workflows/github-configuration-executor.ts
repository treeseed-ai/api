import { githubActionsHeaders, githubActionsRequest, repositoryPath } from '../../providers/github/actions-client.ts';
import { resolveGitHubCredentialAuthority } from '../../security/provider-credential-authority.ts';
import { consumeWorkflowConfigurationDelivery } from './configuration-deliveries.ts';

function targetPath(repository: any, record: any) {
	const kind = record.kind === 'secret' ? 'secrets' : 'variables';
	const name = encodeURIComponent(record.name);
	if (record.scope === 'repository') return `${repositoryPath(repository.owner, repository.name)}/actions/${kind}/${name}`;
	if (record.scope === 'environment' && record.environment) return `/repositories/${encodeURIComponent(repository.provider_repository_id)}/environments/${encodeURIComponent(record.environment)}/${kind}/${name}`;
	if (record.scope === 'organization') return `/orgs/${encodeURIComponent(repository.owner)}/actions/${kind}/${name}`;
	throw new Error('The workflow configuration target is invalid.');
}

export function createGitHubConfigurationExecutor(options: { controlPlaneStore: any; fetchImpl?: typeof fetch }) {
	return {
		namespace: 'workflow', operation: 'configure',
		async run(input: any, context: any) {
			const store = options.controlPlaneStore;
			if (!store) throw new Error('Workflow configuration requires the control-plane store.');
			const delivery: any = await store.first(`SELECT * FROM workflow_configuration_deliveries WHERE id = ? AND operation_id = ?`,
				[String(input?.deliveryId ?? ''), context.operation.id]);
			if (!delivery || delivery.status !== 'ready' || Date.parse(delivery.expires_at) <= Date.now()) {
				throw new Error('The single-use workflow configuration delivery is unavailable or expired.');
			}
			const transient = consumeWorkflowConfigurationDelivery(delivery.id, context.operation.id);
			if (transient.payloadDigest !== delivery.payload_digest || transient.keyId !== delivery.key_id) {
				throw new Error('The workflow configuration delivery metadata does not match.');
			}
			const record: any = await store.first(`SELECT * FROM workflow_configuration_records WHERE id = ?`, [delivery.record_id]);
			const repository: any = record && await store.first(`SELECT * FROM project_remote_repository_bindings WHERE id = ? AND project_id = ?`,
				[record.repository_binding_id, record.project_id]);
			const capability = record && await store.first(`SELECT * FROM team_service_capability_bindings WHERE id = ?
				AND connection_id = ? AND status = 'configured'`, [record.workflow_binding_id, repository?.service_connection_id]);
			const expectedCapability = record?.kind === 'secret' ? 'secret-enclave' : 'workflow-configuration';
			const authority = capability && await store.first(`SELECT * FROM provider_credential_authorities WHERE connection_id = ?
				AND credential_profile_id = ? AND status = 'ready'`, [capability.connection_id, capability.credential_profile_id]);
			if (!record || !repository || repository.provider_id !== 'github' || !capability || capability.capability_type !== expectedCapability || !authority) {
				throw new Error('The workflow configuration authority is no longer ready.');
			}
			const fetchImpl = options.fetchImpl ?? fetch;
			try {
				const credential = await resolveGitHubCredentialAuthority({ store, authorityId: authority.id,
					repositoryBindingId: repository.id, capabilityBindingId: capability.id,
					capability: expectedCapability, fetchImpl });
				const path = targetPath(repository, record);
				if (delivery.action === 'delete') {
					await githubActionsRequest(fetchImpl, credential.token, path, { method: 'DELETE' });
				} else if (record.kind === 'secret') {
					if (!transient.payload || !transient.keyId) throw new Error('The GitHub-encrypted secret delivery is incomplete.');
					const organization = record.scope === 'organization'
						? { visibility: 'selected', selected_repository_ids: [Number(repository.provider_repository_id)] } : {};
					await githubActionsRequest(fetchImpl, credential.token, path, { method: 'PUT',
						body: JSON.stringify({ encrypted_value: transient.payload, key_id: transient.keyId, ...organization }) });
				} else {
					if (transient.payload === null) throw new Error('The workflow variable delivery is incomplete.');
					const observed = await fetchImpl(`https://api.github.com${path}`, { headers: githubActionsHeaders(credential.token) });
					if (!observed.ok && observed.status !== 404) throw new Error(`GitHub variable observation failed (HTTP ${observed.status}).`);
					const organization = record.scope === 'organization'
						? { visibility: 'selected', selected_repository_ids: [Number(repository.provider_repository_id)] } : {};
					await githubActionsRequest(fetchImpl, credential.token, observed.status === 404 ? path.slice(0, path.lastIndexOf('/')) : path,
						{ method: observed.status === 404 ? 'POST' : 'PATCH', body: JSON.stringify({ name: record.name, value: transient.payload, ...organization }) });
				}
				const now = new Date().toISOString();
				await store.run(`UPDATE workflow_configuration_deliveries SET status = 'consumed', consumed_at = ?, updated_at = ? WHERE id = ? AND status = 'ready'`, [now, now, delivery.id]);
				await store.run(`UPDATE workflow_configuration_records SET status = ?, provider_updated_at = ?, last_observed_at = ?, updated_at = ? WHERE id = ?`,
					[delivery.action === 'delete' ? 'deleted' : 'configured', now, now, now, record.id]);
				await store.recordAuditEvent({ eventType: `workflow.${record.kind}.${delivery.action === 'delete' ? 'deleted' : 'configured'}`,
					actorType: 'service', actorId: context.operation.assignedRunnerId ?? 'operations-runner',
					targetType: 'workflow_configuration_record', targetId: record.id, data: { projectId: record.project_id,
						teamId: record.team_id, kind: record.kind, scope: record.scope, environment: record.environment,
						name: record.name, digest: delivery.payload_digest, operationId: context.operation.id } });
				return { recordId: record.id, status: delivery.action === 'delete' ? 'deleted' : 'configured',
					kind: record.kind, scope: record.scope, name: record.name, digest: delivery.payload_digest };
			} catch (error) {
				const now = new Date().toISOString();
				await store.run(`UPDATE workflow_configuration_deliveries SET status = 'failed', consumed_at = ?, updated_at = ? WHERE id = ?`, [now, now, delivery.id]);
				await store.run(`UPDATE workflow_configuration_records SET status = 'failed', updated_at = ? WHERE id = ?`, [now, record.id]);
				throw error;
			}
		},
	};
}
