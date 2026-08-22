import { randomUUID } from 'node:crypto';
import { CREDENTIAL_AUTHORITY_SCHEMES, SERVICE_PROVIDER_CATALOG, containsForbiddenPlaintextSecretMaterial,
	getServiceProviderDefinition, serviceProviderSupportsCapability } from '@treeseed/sdk/secrets-capability';
import { ServiceOperationError } from './service-operation-error.ts';

type Principal = { id: string; roles?: string[]; permissions?: string[] } | undefined;
const ENV_REFERENCE = /^TREESEED_[A-Z0-9]+(?:_[A-Z0-9]+)*$/u;

function serializeAuthority(row: any) {
	return row ? { id: row.id, teamId: row.team_id, connectionId: row.connection_id,
		credentialProfileId: row.credential_profile_id, scheme: row.scheme, reference: row.reference,
		capabilities: JSON.parse(row.capabilities_json), status: row.status, version: Number(row.version),
		createdAt: row.created_at, updatedAt: row.updated_at } : null;
}

async function authorize(store: any, principal: Principal, teamId: string, permission: 'projects:read:team' | 'services:manage:team') {
	if (!principal) throw new ServiceOperationError(401, 'authentication_required', 'Authentication is required.');
	const administrator = principal.roles?.some((role) => role === 'admin' || role === 'platform_admin') || principal.permissions?.includes('*:*:*') || false;
	if (!administrator && !await store.principalCanAccessTeam(principal, teamId)) throw new ServiceOperationError(403, 'team_access_denied', 'The principal cannot access this team.');
	const summary = administrator ? { permissions: ['*:*:*'] } : await store.getTeamAccessSummary(teamId, principal);
	if (!administrator && !summary.permissions.includes(permission)) throw new ServiceOperationError(403, 'service_permission_denied', `${permission} authority is required.`);
	return principal;
}

function rejectSecrets(body: Record<string, unknown>) {
	const fields = containsForbiddenPlaintextSecretMaterial(body);
	if (fields.length) throw new ServiceOperationError(400, 'plaintext_secret_rejected', `Plaintext secret material is not accepted: ${fields.join(', ')}.`);
}

function capabilities(provider: NonNullable<ReturnType<typeof getServiceProviderDefinition>>, value: unknown) {
	const requested = Array.isArray(value) ? value : [];
	const unsupported = requested.map((item: any) => String(item.capabilityType ?? '')).filter((type) => !serviceProviderSupportsCapability(provider.id, type));
	if (unsupported.length) throw new ServiceOperationError(400, 'unsupported_service_capability', `Unsupported capabilities: ${unsupported.join(', ')}.`);
	return requested.map((item: any) => {
		const definition = provider.capabilities.find((candidate) => candidate.type === item.capabilityType);
		const credentialProfileId = item.credentialProfileId ?? definition?.credentialProfileIds[0] ?? null;
		if (credentialProfileId && !definition?.credentialProfileIds.includes(credentialProfileId)) {
			throw new ServiceOperationError(400, 'credential_profile_mismatch', 'The selected credential profile cannot authorize this capability.');
		}
		return { ...item, credentialProfileId };
	});
}

export function createServiceConnectionService(store: any) {
	return {
		providers() { return { items: SERVICE_PROVIDER_CATALOG }; },
		async connections(principal: Principal, teamId: string) {
			await authorize(store, principal, teamId, 'projects:read:team');
			return { items: await store.listTeamServiceConnections(teamId), cursor: null };
		},
		async connection(principal: Principal, teamId: string, connectionId: string) {
			await authorize(store, principal, teamId, 'projects:read:team');
			const result = await store.getTeamServiceConnection(teamId, connectionId);
			if (!result) throw new ServiceOperationError(404, 'service_connection_not_found', 'Service connection not found.');
			return result;
		},
		async create(principal: Principal, teamId: string, body: Record<string, unknown>) {
			const actor = await authorize(store, principal, teamId, 'services:manage:team'); rejectSecrets(body);
			const provider = getServiceProviderDefinition(String(body.providerId ?? ''));
			if (!provider) throw new ServiceOperationError(400, 'unsupported_service_provider', 'Choose a supported service provider.');
			const displayName = String(body.displayName ?? '').trim();
			if (!displayName) throw new ServiceOperationError(400, 'missing_display_name', 'A connection name is required.');
			try { return await store.createTeamServiceConnection(teamId, { providerId: provider.id, displayName,
				nonSecretConfig: body.nonSecretConfig ?? {}, capabilities: capabilities(provider, body.capabilities), actorUserId: actor.id }); }
			catch (error) { if (error instanceof ServiceOperationError) throw error;
				throw new ServiceOperationError(400, 'service_connection_failed', error instanceof Error ? error.message : 'Service connection failed.'); }
		},
		async update(principal: Principal, teamId: string, connectionId: string, body: Record<string, unknown>, ifMatch?: string) {
			const actor = await authorize(store, principal, teamId, 'services:manage:team'); rejectSecrets(body);
			const existing = await store.getTeamServiceConnection(teamId, connectionId);
			if (!existing) throw new ServiceOperationError(404, 'service_connection_not_found', 'Service connection not found.');
			if (!ifMatch || Number(ifMatch) !== existing.version) throw new ServiceOperationError(412, 'service_connection_precondition_failed', 'The service connection changed after it was inspected.');
			const provider = getServiceProviderDefinition(existing.providerId);
			if (!provider) throw new ServiceOperationError(409, 'service_provider_unavailable', 'The service provider is no longer available.');
			const normalized = body.capabilities === undefined ? undefined : capabilities(provider, body.capabilities);
			if (normalized) {
				const dependencies: any[] = await store.all(`SELECT b.capability_type, b.credential_profile_id FROM team_service_capability_bindings b
					WHERE b.connection_id = ? AND (EXISTS (SELECT 1 FROM project_remote_repository_bindings r WHERE r.capability_binding_id = b.id)
					OR EXISTS (SELECT 1 FROM project_workflow_operations o WHERE o.workflow_binding_id = b.id))`, [connectionId]);
				if (dependencies.some((dependency) => !normalized.some((item: any) => item.capabilityType === dependency.capability_type
					&& item.credentialProfileId === dependency.credential_profile_id))) throw new ServiceOperationError(409, 'service_capability_in_use', 'A project binding uses a changed capability.');
			}
			try { return await store.updateTeamServiceConnection(teamId, connectionId, { ...body, version: existing.version,
				capabilities: normalized, actorUserId: actor.id }); }
			catch (error) { if (error instanceof ServiceOperationError) throw error;
				throw new ServiceOperationError((error as any)?.code === 'service_connection_conflict' ? 409 : 400,
					(error as any)?.code ?? 'service_update_failed', error instanceof Error ? error.message : 'Service update failed.'); }
		},
		async disconnect(principal: Principal, teamId: string, connectionId: string, ifMatch?: string) {
			const actor = await authorize(store, principal, teamId, 'services:manage:team');
			const existing = await store.getTeamServiceConnection(teamId, connectionId);
			if (!existing) throw new ServiceOperationError(404, 'service_connection_not_found', 'Service connection not found.');
			if (!ifMatch || Number(ifMatch) !== existing.version) throw new ServiceOperationError(412, 'service_connection_precondition_failed', 'The service connection changed after it was inspected.');
			const blockers = await store.all(`SELECT b.id FROM team_service_capability_bindings b WHERE b.connection_id = ? AND
				(EXISTS (SELECT 1 FROM project_remote_repository_bindings r WHERE r.capability_binding_id = b.id)
				OR EXISTS (SELECT 1 FROM project_workflow_operations o WHERE o.workflow_binding_id = b.id)) LIMIT 1`, [connectionId]);
			if (blockers.length) throw new ServiceOperationError(409, 'service_in_use', 'Rebind projects before disconnecting this service.');
			const result = await store.disconnectTeamServiceConnection(teamId, connectionId, actor.id);
			if (!result.ok) throw new ServiceOperationError(409, 'service_disconnect_failed', 'The service could not be disconnected.');
			return result.payload;
		},
		async authorities(principal: Principal, teamId: string, connectionId: string) {
			await authorize(store, principal, teamId, 'services:manage:team');
			if (!await store.getTeamServiceConnection(teamId, connectionId)) throw new ServiceOperationError(404, 'service_connection_not_found', 'Service connection not found.');
			const rows = await store.all('SELECT * FROM provider_credential_authorities WHERE team_id = ? AND connection_id = ? ORDER BY credential_profile_id', [teamId, connectionId]);
			return { items: rows.map(serializeAuthority), cursor: null };
		},
		async putAuthority(principal: Principal, teamId: string, connectionId: string, profileId: string,
			body: Record<string, unknown>, ifMatch?: string) {
			const actor = await authorize(store, principal, teamId, 'services:manage:team'); rejectSecrets(body);
			const connection = await store.getTeamServiceConnection(teamId, connectionId);
			if (!connection) throw new ServiceOperationError(404, 'service_connection_not_found', 'Service connection not found.');
			const provider = getServiceProviderDefinition(connection.providerId); const profile = provider?.credentialProfiles.find((item) => item.id === profileId);
			if (!profile) throw new ServiceOperationError(404, 'credential_profile_not_found', 'Credential profile not found.');
			if (!CREDENTIAL_AUTHORITY_SCHEMES.includes(body.scheme as any) || !profile.authoritySchemes?.includes(body.scheme as any)) throw new ServiceOperationError(400, 'credential_authority_scheme_mismatch', 'The credential profile does not support this authority scheme.');
			if (body.scheme === 'app-installation') throw new ServiceOperationError(409, 'credential_authority_connector_required', 'GitHub App authority must use the managed Connector flow.');
			const reference = String(body.reference ?? '').trim();
			if (!reference || (body.scheme === 'environment-reference' && !ENV_REFERENCE.test(reference))) throw new ServiceOperationError(400, 'invalid_credential_authority_reference', 'A valid non-secret authority reference is required.');
			const allowed = connection.capabilities.filter((binding: any) => binding.status === 'configured' && binding.credentialProfileId === profile.id)
				.map((binding: any) => binding.capabilityType).filter((capability: string) => profile.capabilities.includes(capability as any));
			if (!allowed.length) throw new ServiceOperationError(409, 'credential_authority_unused', 'Enable a capability for this credential profile first.');
			const existing: any = await store.first('SELECT * FROM provider_credential_authorities WHERE connection_id = ? AND credential_profile_id = ?', [connectionId, profileId]);
			if (!ifMatch || Number(ifMatch) !== Number(existing?.version ?? 0)) throw new ServiceOperationError(412, 'credential_authority_precondition_failed', 'The credential authority changed after it was inspected.');
			const status = ['client-encrypted', 'api-token', 'oauth-token'].includes(String(body.scheme)) ? 'interactive-only' : 'ready';
			const now = new Date().toISOString(); const id = existing?.id ?? randomUUID();
			await store.run(`INSERT INTO provider_credential_authorities (id, team_id, connection_id, credential_profile_id, scheme,
				reference, capabilities_json, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
				ON CONFLICT(connection_id, credential_profile_id) DO UPDATE SET scheme = excluded.scheme, reference = excluded.reference,
				capabilities_json = excluded.capabilities_json, status = excluded.status, version = provider_credential_authorities.version + 1,
				updated_at = excluded.updated_at`, [id, teamId, connectionId, profileId, body.scheme, reference, JSON.stringify(allowed), status, now, now]);
			const saved = serializeAuthority(await store.first('SELECT * FROM provider_credential_authorities WHERE id = ?', [id]));
			await store.recordAuditEvent({ eventType: 'provider.credential_authority.updated', actorType: 'user', actorId: actor.id,
				targetType: 'provider_credential_authority', targetId: id,
				data: { teamId, connectionId, profileId, scheme: body.scheme, capabilities: allowed } });
			return saved;
		},
	};
}
