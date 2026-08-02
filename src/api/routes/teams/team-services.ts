import {
SERVICE_PROVIDER_CATALOG,
canonicalServiceVaultAssociatedData,
containsForbiddenPlaintextSecretMaterial,
getServiceProviderDefinition,
serviceProviderSupportsCapability,
validateEncryptedCredentialEnvelope,
} from '@treeseed/sdk/secrets-capability';
import { randomUUID } from 'node:crypto';

function rejectSecretMaterial(c: any, jsonError: any, body: unknown) {
	const fields = containsForbiddenPlaintextSecretMaterial(body);
	return fields.length
		? jsonError(c, 400, 'Plaintext credentials, passphrases, and derived keys are not accepted.', { code: 'plaintext_secret_rejected', fields })
		: null;
}

export function installTeamServicesRoutes(context: any) {
	const { app, store, requireTeamAccess, jsonError, ensurePrincipal, consumeReauthentication } = context;
	const read = (c: any) => requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
	const manage = (c: any) => requireTeamAccess(c, store, c.req.param('teamId'), 'services:manage:team');
	const manageVault = (c: any) => requireTeamAccess(c, store, c.req.param('teamId'), 'vault:manage:team');

	app.get('/v1/service-providers', (c: any) => c.json({ ok: true, payload: SERVICE_PROVIDER_CATALOG }));

	app.get('/v1/teams/:teamId/services', async (c: any) => {
		const access = await read(c);
		if (access.response) return access.response;
		return c.json({ ok: true, payload: await store.listTeamServiceConnections(c.req.param('teamId')) });
	});

	app.get('/v1/teams/:teamId/services/:connectionId', async (c: any) => {
		const access = await read(c);
		if (access.response) return access.response;
		const payload = await store.getTeamServiceConnection(c.req.param('teamId'), c.req.param('connectionId'));
		return payload ? c.json({ ok: true, payload }) : jsonError(c, 404, 'Service connection not found.');
	});

	app.post('/v1/teams/:teamId/services', async (c: any) => {
		const access = await manage(c);
		if (access.response) return access.response;
		const body = await c.req.json().catch(() => ({}));
		const rejected = rejectSecretMaterial(c, jsonError, body);
		if (rejected) return rejected;
		const provider = getServiceProviderDefinition(String(body.providerId ?? ''));
		if (!provider) return jsonError(c, 400, 'Choose a supported service provider.', { code: 'unsupported_service_provider' });
		if (!String(body.displayName ?? '').trim()) return jsonError(c, 400, 'A connection name is required.', { code: 'missing_display_name' });
		const capabilities = Array.isArray(body.capabilities) ? body.capabilities : [];
		const unsupported = capabilities
			.map((item: any) => String(item.capabilityType ?? ''))
			.filter((type: string) => !serviceProviderSupportsCapability(provider.id, type));
		if (unsupported.length) return jsonError(c, 400, 'The provider does not support every selected capability.', { code: 'unsupported_service_capability', unsupported });
		const invalidProfile = capabilities.find((item: any) => {
			const definition = provider.capabilities.find((candidate) => candidate.type === item.capabilityType);
			return item.credentialProfileId && !definition?.credentialProfileIds.includes(item.credentialProfileId);
		});
		if (invalidProfile) return jsonError(c, 400, 'The selected credential profile cannot authorize this capability.', { code: 'credential_profile_mismatch' });
		const normalizedCapabilities = capabilities.map((item: any) => {
			const definition = provider.capabilities.find((candidate) => candidate.type === item.capabilityType);
			return { ...item, credentialProfileId: item.credentialProfileId ?? definition?.credentialProfileIds[0] ?? null };
		});
		try {
			const payload = await store.createTeamServiceConnection(c.req.param('teamId'), {
				providerId: provider.id,
				displayName: String(body.displayName).trim(),
				nonSecretConfig: body.nonSecretConfig ?? {},
				capabilities: normalizedCapabilities,
				actorUserId: access.principal.id,
			});
			return c.json({ ok: true, code: 'service_connected', message: 'Service connected.', payload }, 201);
		} catch (error) {
			return jsonError(c, 400, error instanceof Error ? error.message : String(error), { code: 'service_connection_failed' });
		}
	});

	app.put('/v1/teams/:teamId/services/:connectionId', async (c: any) => {
		const access = await manage(c);
		if (access.response) return access.response;
		const body = await c.req.json().catch(() => ({}));
		const rejected = rejectSecretMaterial(c, jsonError, body);
		if (rejected) return rejected;
		const existing = await store.getTeamServiceConnection(c.req.param('teamId'), c.req.param('connectionId'));
		if (!existing) return jsonError(c, 404, 'Service connection not found.');
		const unsupported = (body.capabilities ?? [])
			.map((item: any) => String(item.capabilityType ?? ''))
			.filter((type: string) => !serviceProviderSupportsCapability(existing.providerId, type));
		if (unsupported.length) return jsonError(c, 400, 'The provider does not support every selected capability.', { code: 'unsupported_service_capability', unsupported });
		try {
			const provider = getServiceProviderDefinition(existing.providerId)!;
			const capabilities = Array.isArray(body.capabilities) ? body.capabilities.map((item: any) => {
				const definition = provider.capabilities.find((candidate) => candidate.type === item.capabilityType);
				const credentialProfileId = item.credentialProfileId ?? definition?.credentialProfileIds[0] ?? null;
				if (credentialProfileId && !definition?.credentialProfileIds.includes(credentialProfileId)) {
					throw Object.assign(new Error('The selected credential profile cannot authorize this capability.'), { code: 'credential_profile_mismatch' });
				}
				return { ...item, credentialProfileId };
			}) : undefined;
			if (capabilities) {
				const dependencies: any[] = await store.all(`SELECT b.capability_type, b.credential_profile_id
					FROM team_service_capability_bindings b
					WHERE b.connection_id = ? AND (EXISTS (SELECT 1 FROM project_remote_repository_bindings r
						WHERE r.capability_binding_id = b.id) OR EXISTS (SELECT 1 FROM project_workflow_operations o
						WHERE o.workflow_binding_id = b.id))`, [existing.id]);
				const changedDependency = dependencies.find((dependency) => !capabilities.some((item: any) =>
					item.capabilityType === dependency.capability_type
					&& item.credentialProfileId === dependency.credential_profile_id));
				if (changedDependency) {
					return jsonError(c, 409, 'A project binding uses this capability and credential profile. Rebind the project before changing it.', {
						code: 'service_capability_in_use', capabilityType: changedDependency.capability_type,
					});
				}
			}
			const payload = await store.updateTeamServiceConnection(c.req.param('teamId'), c.req.param('connectionId'), { ...body, capabilities, actorUserId: access.principal.id });
			return c.json({ ok: true, code: 'service_updated', message: 'Service updated.', payload });
		} catch (error: any) {
			return jsonError(c, error?.code === 'service_connection_conflict' ? 409 : 400, error instanceof Error ? error.message : String(error), { code: error?.code ?? 'service_update_failed' });
		}
	});

	app.delete('/v1/teams/:teamId/services/:connectionId', async (c: any) => {
		const access = await manage(c);
		if (access.response) return access.response;
		const result = await store.disconnectTeamServiceConnection(c.req.param('teamId'), c.req.param('connectionId'), access.principal.id);
		if (result.error === 'not_found') return jsonError(c, 404, 'Service connection not found.');
		if (result.error === 'in_use') return jsonError(c, 409, 'Remove service allocations before disconnecting this provider.', { code: 'service_in_use', blockers: result.blockers });
		return c.json({ ok: true, code: 'service_disconnected', message: 'Service disconnected.', payload: result.payload });
	});

	app.get('/v1/users/me/vault-key', async (c: any) => {
		const access = await ensurePrincipal(c);
		if (access.response) return access.response;
		return c.json({ ok: true, payload: await store.getUserVaultKey(access.principal.id) });
	});

	app.put('/v1/users/me/vault-key', async (c: any) => {
		const access = await ensurePrincipal(c);
		if (access.response) return access.response;
		const body = await c.req.json().catch(() => ({}));
		const rejected = rejectSecretMaterial(c, jsonError, body);
		if (rejected) return rejected;
		if (!body.publicKey || !body.encryptedPrivateKeyEnvelope) return jsonError(c, 400, 'A public key and encrypted private-key envelope are required.', { code: 'invalid_user_vault_key' });
		const payload = await store.upsertUserVaultKey(access.principal.id, body);
		return c.json({ ok: true, code: 'vault_key_saved', message: 'Personal vault access saved.', payload });
	});

	app.get('/v1/teams/:teamId/vault', async (c: any) => {
		const access = await manage(c);
		if (access.response) return access.response;
		return c.json({ ok: true, payload: await store.getTeamVaultSummary(c.req.param('teamId'), access.principal.id) });
	});

	app.post('/v1/teams/:teamId/vault', async (c: any) => {
		const access = await manageVault(c);
		if (access.response) return access.response;
		const body = await c.req.json().catch(() => ({}));
		const rejected = rejectSecretMaterial(c, jsonError, body);
		if (rejected) return rejected;
		if (!body.userVaultKeyId || !body.wrappedTeamVaultKey || !body.encryptionVersion) return jsonError(c, 400, 'The encrypted vault key grant is incomplete.', { code: 'invalid_team_vault' });
		try {
			const payload = await store.initializeTeamVault(c.req.param('teamId'), { ...body, actorUserId: access.principal.id });
			return c.json({ ok: true, code: 'team_vault_initialized', message: 'Team service vault initialized.', payload }, 201);
		} catch (error) {
			return jsonError(c, 400, error instanceof Error ? error.message : String(error), { code: 'team_vault_initialization_failed' });
		}
	});

	app.post('/v1/teams/:teamId/vault/grants', async (c: any) => {
		const access = await manageVault(c);
		if (access.response) return access.response;
		const vault = await store.getTeamVaultSummary(c.req.param('teamId'), access.principal.id);
		if (!vault?.ownGrant) return jsonError(c, 403, 'An active vault grant is required.', { code: 'vault_grant_required' });
		const body = await c.req.json().catch(() => ({}));
		const rejected = rejectSecretMaterial(c, jsonError, body);
		if (rejected) return rejected;
		if (!body.userId || !body.userVaultKeyId || !body.wrappedTeamVaultKey) return jsonError(c, 400, 'The recipient and wrapped team key are required.', { code: 'invalid_vault_grant' });
		const payload = await store.createTeamVaultGrant(c.req.param('teamId'), { ...body, actorUserId: access.principal.id });
		return c.json({ ok: true, code: 'vault_access_granted', message: 'Vault access granted.', payload }, 201);
	});

	app.get('/v1/teams/:teamId/vault/grant-candidates', async (c: any) => {
		const access = await manageVault(c);
		if (access.response) return access.response;
		const members = await store.listTeamMembers(c.req.param('teamId'));
		const candidates = await Promise.all(members
			.filter((member: any) => member.status === 'active' && member.userId !== access.principal.id)
			.map(async (member: any) => {
				const key = await store.getUserVaultKey(member.userId);
				return key ? {
					userId: member.userId,
					displayName: member.displayName ?? member.email ?? member.userId,
					roles: member.roles,
					userVaultKeyId: key.id,
					publicKey: key.publicKey,
					keyVersion: key.version,
				} : null;
			}));
		return c.json({ ok: true, payload: candidates.filter(Boolean) });
	});

	app.delete('/v1/teams/:teamId/vault/grants/:grantId', async (c: any) => {
		const access = await manageVault(c);
		if (access.response) return access.response;
		const vault = await store.getTeamVaultSummary(c.req.param('teamId'), access.principal.id);
		if (!vault?.ownGrant) return jsonError(c, 403, 'An active vault grant is required.', { code: 'vault_grant_required' });
		const result = await store.revokeTeamVaultGrant(c.req.param('teamId'), c.req.param('grantId'), access.principal.id);
		if (result.error === 'last_grant') return jsonError(c, 409, 'The final vault administrator cannot be revoked.', { code: 'last_vault_grant' });
		if (!result.ok) return jsonError(c, 404, 'Vault grant not found.');
		return c.json({ ok: true, code: 'vault_access_revoked', message: 'Vault access revoked.' });
	});

	app.get('/v1/teams/:teamId/vault/credential-envelopes', async (c: any) => {
		const access = await manageVault(c);
		if (access.response) return access.response;
		const vault = await store.getTeamVaultSummary(c.req.param('teamId'), access.principal.id);
		if (!vault?.ownGrant) return jsonError(c, 403, 'An active vault grant is required.', { code: 'vault_grant_required' });
		return c.json({ ok: true, payload: await store.listTeamCredentialEnvelopes(c.req.param('teamId')) });
	});

	app.post('/v1/teams/:teamId/vault/rotate', async (c: any) => {
		const access = await manageVault(c);
		if (access.response) return access.response;
		const body = await c.req.json().catch(() => ({}));
		const rejected = rejectSecretMaterial(c, jsonError, body);
		if (rejected) return rejected;
		const vault = await store.getTeamVaultSummary(c.req.param('teamId'), access.principal.id);
		if (!vault?.ownGrant) return jsonError(c, 403, 'An active vault grant is required.', { code: 'vault_grant_required' });
		if (Number(body.expectedKeyVersion) !== vault.activeKeyVersion || !Array.isArray(body.envelopes) || !Array.isArray(body.grants)) {
			return jsonError(c, 409, 'The vault rotation payload is stale or incomplete.', { code: 'team_vault_conflict' });
		}
		const currentEnvelopes = await store.listTeamCredentialEnvelopes(c.req.param('teamId'));
		const replacements = new Map(body.envelopes.map((item: any) => [String(item.id), item.envelope]));
		if (replacements.size !== currentEnvelopes.length) {
			return jsonError(c, 400, 'Every active credential key must be included in a vault rotation.', { code: 'incomplete_vault_rotation' });
		}
		for (const current of currentEnvelopes) {
			const next: any = replacements.get(current.id);
			if (!validateEncryptedCredentialEnvelope(next)
				|| next.associatedData !== current.envelope.associatedData
				|| next.ciphertext !== current.envelope.ciphertext
				|| next.nonce !== current.envelope.nonce
				|| next.fingerprint !== current.envelope.fingerprint) {
				return jsonError(c, 400, 'Vault rotation may rewrap credential keys but may not replace credential ciphertext.', { code: 'invalid_vault_rotation' });
			}
		}
		const activeGrants = vault.grants.filter((grant: any) => grant.status === 'active');
		const grants = new Map(body.grants.map((grant: any) => [String(grant.userId), grant]));
		if (grants.size !== activeGrants.length || activeGrants.some((grant: any) => {
			const next: any = grants.get(grant.userId);
			return !next || next.userVaultKeyId !== grant.userVaultKeyId || !String(next.wrappedTeamVaultKey ?? '');
		})) {
			return jsonError(c, 400, 'Every active administrator must receive a replacement team vault grant.', { code: 'incomplete_vault_grants' });
		}
		try {
			const payload = await store.rotateTeamVault(c.req.param('teamId'), {
				expectedKeyVersion: body.expectedKeyVersion,
				envelopes: body.envelopes,
				grants: body.grants,
				actorUserId: access.principal.id,
			});
			return c.json({ ok: true, code: 'team_vault_rotated', message: 'Team vault key rotated.', payload });
		} catch (error: any) {
			return jsonError(c, error?.code === 'team_vault_conflict' ? 409 : 400, error instanceof Error ? error.message : String(error), { code: error?.code ?? 'team_vault_rotation_failed' });
		}
	});

	app.post('/v1/teams/:teamId/vault/reset', async (c: any) => {
		const access = await manageVault(c);
		if (access.response) return access.response;
		const body = await c.req.json().catch(() => ({}));
		if (!await consumeReauthentication(store, access.principal, 'service_vault_reset', body)) {
			return jsonError(c, 401, 'Recent reauthentication is required.', { code: 'reauthentication_required' });
		}
		const safeBody = { ...body };
		delete safeBody.currentPassword;
		delete safeBody.reauthenticationGrantId;
		const rejected = rejectSecretMaterial(c, jsonError, safeBody);
		if (rejected) return rejected;
		const team = await store.getTeam(c.req.param('teamId'));
		if (!team || body.confirmation !== `RESET ${team.name}`) {
			return jsonError(c, 400, `Enter RESET ${team?.name ?? 'TEAM'} to discard protected credentials.`, {
				code: 'vault_reset_confirmation_mismatch',
				fieldErrors: { confirmation: 'The confirmation text does not match.' },
			});
		}
		if (!body.userVaultKeyId || !body.wrappedTeamVaultKey || !body.encryptionVersion) {
			return jsonError(c, 400, 'A replacement encrypted vault grant is required.', { code: 'invalid_team_vault_reset' });
		}
		const payload = await store.resetTeamVault(c.req.param('teamId'), { ...safeBody, actorUserId: access.principal.id });
		return c.json({ ok: true, code: 'team_vault_reset', message: 'Vault reset. Protected credentials must be reentered.', payload });
	});

	app.get('/v1/teams/:teamId/services/:connectionId/credential-envelopes', async (c: any) => {
		const access = await manage(c);
		if (access.response) return access.response;
		const vault = await store.getTeamVaultSummary(c.req.param('teamId'), access.principal.id);
		if (!vault?.ownGrant) return jsonError(c, 403, 'An active vault grant is required.', { code: 'vault_grant_required' });
		return c.json({ ok: true, payload: await store.listServiceCredentialEnvelopes(c.req.param('teamId'), c.req.param('connectionId')) });
	});

	app.post('/v1/teams/:teamId/services/:connectionId/credential-envelopes', async (c: any) => {
		const access = await manage(c);
		if (access.response) return access.response;
		const vault = await store.getTeamVaultSummary(c.req.param('teamId'), access.principal.id);
		if (!vault?.ownGrant) return jsonError(c, 403, 'An active vault grant is required.', { code: 'vault_grant_required' });
		const body = await c.req.json().catch(() => ({}));
		const rejected = rejectSecretMaterial(c, jsonError, body);
		if (rejected) return rejected;
		if (!validateEncryptedCredentialEnvelope(body.envelope)) return jsonError(c, 400, 'A valid client-encrypted credential envelope is required.', { code: 'invalid_credential_envelope' });
		const connection = await store.getTeamServiceConnection(c.req.param('teamId'), c.req.param('connectionId'));
		const provider = connection && getServiceProviderDefinition(connection.providerId);
		const definition = provider?.credentialProfiles.find((item: any) => item.id === body.definitionId);
		const configuredBindings = connection?.capabilities.filter((binding: any) => binding.status === 'configured'
			&& binding.credentialProfileId === body.definitionId) ?? [];
		if (!definition || !configuredBindings.length) {
			return jsonError(c, 400, 'The encrypted credential profile is not selected by an enabled capability.', {
				code: 'credential_profile_mismatch',
			});
		}
		if (!definition.fields.some((field: any) => field.sensitive && field.key === body.fieldKey)) {
			return jsonError(c, 400, 'The encrypted credential field is not declared by this profile.', {
				code: 'credential_field_mismatch',
			});
		}
		const expected = canonicalServiceVaultAssociatedData({
			teamId: c.req.param('teamId'),
			connectionId: c.req.param('connectionId'),
			credentialProfileId: String(body.definitionId ?? ''),
			field: String(body.fieldKey ?? ''),
			purpose: 'team-service-credential',
			version: Number(body.keyVersion ?? 1),
		});
		if (body.envelope.associatedData !== expected) return jsonError(c, 400, 'The encrypted credential is bound to a different service context.', { code: 'credential_context_mismatch' });
		const payload = await store.upsertServiceCredentialEnvelope(c.req.param('teamId'), {
			...body,
			connectionId: c.req.param('connectionId'),
			custodyMode: 'client_encrypted_vault',
			actorUserId: access.principal.id,
		});
		const capabilities = configuredBindings
			.map((binding: any) => binding.capabilityType)
			.filter((capability: string) => definition?.capabilities.includes(capability)) ?? [];
		if ((definition.authoritySchemes ?? ['client-encrypted']).includes('client-encrypted') && capabilities.length) {
			const current: any = await store.first(`SELECT * FROM provider_credential_authorities
				WHERE connection_id = ? AND credential_profile_id = ?`, [c.req.param('connectionId'), body.definitionId]);
			if (!current || current.scheme === 'client-encrypted') {
				const now = new Date().toISOString();
				await store.run(`INSERT INTO provider_credential_authorities
					(id, team_id, connection_id, credential_profile_id, scheme, reference, capabilities_json, status, version, created_at, updated_at)
					VALUES (?, ?, ?, ?, 'client-encrypted', ?, ?, 'interactive-only', 1, ?, ?)
					ON CONFLICT(connection_id, credential_profile_id) DO UPDATE SET reference = excluded.reference,
					capabilities_json = excluded.capabilities_json, status = 'interactive-only',
					version = provider_credential_authorities.version + 1, updated_at = excluded.updated_at`,
					[current?.id ?? randomUUID(), c.req.param('teamId'), c.req.param('connectionId'), body.definitionId,
						`credential-profile:${payload.credentialProfileId}`, JSON.stringify(capabilities), now, now]);
			}
		}
		return c.json({ ok: true, code: 'credential_envelope_saved', message: 'Encrypted credential saved.', payload }, 201);
	});

	app.post('/v1/teams/:teamId/service-operation-leases', async (c: any) => {
		const access = await manage(c);
		if (access.response) return access.response;
		const body = await c.req.json().catch(() => ({}));
		const rejected = rejectSecretMaterial(c, jsonError, body);
		if (rejected) return rejected;
		const connection = await store.getTeamServiceConnection(c.req.param('teamId'), String(body.connectionId ?? ''));
		if (!connection) return jsonError(c, 404, 'Service connection not found.');
		const capability = connection.capabilities.find((item: any) => item.capabilityType === body.capabilityType && item.status === 'configured');
		if (!capability) {
			return jsonError(c, 400, 'The requested service capability is not configured.', { code: 'service_capability_unavailable' });
		}
		if (body.purpose !== 'provider-connection-validation' || body.publicKey || !body.idempotencyKey || !body.credentialProfileId) {
			return jsonError(c, 400, 'This route authorizes only a scoped provider validation operation.', { code: 'invalid_operation_lease' });
		}
		const provider = getServiceProviderDefinition(connection.providerId);
		const profile = provider?.credentialProfiles.find((item: any) => item.id === body.credentialProfileId);
		if (!profile || !profile.capabilities.includes(body.capabilityType) || capability.credentialProfileId !== profile.id) {
			return jsonError(c, 400, 'The selected credential profile does not own this capability.', { code: 'credential_profile_mismatch' });
		}
		const requiredFields = profile.fields.filter((field: any) => field.sensitive).map((field: any) => field.key);
		if (!requiredFields.length) return jsonError(c, 400, 'The selected validation does not require an interactive credential.', { code: 'interactive_credential_not_required' });
		const payload = await store.createSecretOperationLease(c.req.param('teamId'), {
			connectionId: connection.id,
			capabilityType: capability.capabilityType,
			purpose: body.purpose,
			credentialProfileId: profile.id,
			resourceScope: { connectionId: connection.id, providerId: connection.providerId },
			requiredFields,
			idempotencyKey: body.idempotencyKey,
			actorUserId: access.principal.id,
			operationCorrelationId: body.operationCorrelationId ?? randomUUID(),
		});
		return c.json({ ok: true, code: 'operation_authorized', message: 'Sensitive operation authorized.', payload }, 201);
	});

	app.put('/v1/teams/:teamId/service-operation-leases/:leaseId/payload', async (c: any) => {
		const access = await manage(c);
		if (access.response) return access.response;
		const body = await c.req.json().catch(() => ({}));
		if (typeof body.sealedPayload !== 'string' || !body.sealedPayload) return jsonError(c, 400, 'A sealed operation payload is required.', { code: 'missing_sealed_payload' });
		const result = await store.submitSecretOperationPayload(c.req.param('teamId'), c.req.param('leaseId'), access.principal.id, body.sealedPayload);
		if (!result.ok) return jsonError(c, result.error === 'not_found' ? 404 : 409, 'The operation lease is unavailable.', { code: result.error });
		return c.json({ ok: true, code: 'operation_payload_ready', message: 'Encrypted operation payload accepted.', payload: result.payload });
	});

	app.get('/v1/teams/:teamId/service-operation-leases/:leaseId', async (c: any) => {
		const access = await manage(c);
		if (access.response) return access.response;
		const payload = await store.getSecretOperationLease(c.req.param('teamId'), c.req.param('leaseId'));
		if (!payload || payload.actorUserId !== access.principal.id) return jsonError(c, 404, 'Operation lease not found.');
		return c.json({ ok: true, payload });
	});

	app.delete('/v1/teams/:teamId/service-operation-leases/:leaseId', async (c: any) => {
		const access = await manage(c);
		if (access.response) return access.response;
		const result = await store.cancelSecretOperationLease(c.req.param('teamId'), c.req.param('leaseId'), access.principal.id);
		if (!result.ok) return jsonError(c, result.error === 'not_found' ? 404 : 409, 'Operation lease cannot be cancelled.', { code: result.error });
		return c.json({ ok: true, code: 'operation_cancelled', message: 'Sensitive operation cancelled.' });
	});

	app.get('/v1/teams/:teamId/services/:connectionId/external-vault-bindings', async (c: any) => {
		const access = await manage(c);
		if (access.response) return access.response;
		return c.json({
			ok: true,
			payload: await store.listExternalVaultBindings(c.req.param('teamId'), c.req.param('connectionId')),
		});
	});

	app.post('/v1/teams/:teamId/services/:connectionId/external-vault-bindings', async (c: any) => {
		const access = await manageVault(c);
		if (access.response) return access.response;
		const body = await c.req.json().catch(() => ({}));
		const rejected = rejectSecretMaterial(c, jsonError, body);
		if (rejected) return rejected;
		if (!['openbao', 'hashicorp-vault'].includes(String(body.provider ?? ''))) {
			return jsonError(c, 400, 'Choose an approved external vault provider.', { code: 'unsupported_external_vault' });
		}
		if (!['oidc-jwt', 'workload-identity', 'dynamic-credentials'].includes(String(body.authMode ?? ''))) {
			return jsonError(c, 400, 'External vault access must use workload identity or dynamic credentials.', { code: 'unsafe_external_vault_auth' });
		}
		if (!body.reference || typeof body.reference !== 'object' || !String(body.reference.address ?? '').startsWith('https://')) {
			return jsonError(c, 400, 'An HTTPS vault address and non-sensitive reference are required.', { code: 'invalid_external_vault_reference' });
		}
		const payload = await store.createExternalVaultBinding(c.req.param('teamId'), c.req.param('connectionId'), {
			...body,
			actorUserId: access.principal.id,
		});
		return c.json({ ok: true, code: 'external_vault_configured', message: 'External vault reference configured.', payload }, 201);
	});

	app.delete('/v1/teams/:teamId/services/:connectionId/external-vault-bindings/:bindingId', async (c: any) => {
		const access = await manageVault(c);
		if (access.response) return access.response;
		const removed = await store.removeExternalVaultBinding(c.req.param('teamId'), c.req.param('bindingId'), access.principal.id);
		return removed
			? c.json({ ok: true, code: 'external_vault_removed', message: 'External vault reference removed.' })
			: jsonError(c, 404, 'External vault reference not found.');
	});
}
