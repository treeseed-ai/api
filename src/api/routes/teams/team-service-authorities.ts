import { CREDENTIAL_AUTHORITY_SCHEMES, getServiceProviderDefinition } from '@treeseed/sdk/secrets-capability';
import { randomUUID } from 'node:crypto';

const ENV_REFERENCE = /^TREESEED_[A-Z0-9]+(?:_[A-Z0-9]+)*$/u;

function authority(row: any) {
	if (!row) return null;
	return {
		id: row.id, teamId: row.team_id, connectionId: row.connection_id,
		credentialProfileId: row.credential_profile_id, scheme: row.scheme, reference: row.reference,
		capabilities: JSON.parse(row.capabilities_json), status: row.status, version: Number(row.version),
		createdAt: row.created_at, updatedAt: row.updated_at,
	};
}

export function installTeamServiceAuthorityRoutes(context: any) {
	const { app, store, requireTeamAccess, jsonError } = context;
	const manage = (c: any) => requireTeamAccess(c, store, c.req.param('teamId'), 'services:manage:team');

	app.get('/v1/teams/:teamId/services/:connectionId/credential-authorities', async (c: any) => {
		const access = await manage(c);
		if (access.response) return access.response;
		const rows = await store.all(
			`SELECT * FROM provider_credential_authorities WHERE team_id = ? AND connection_id = ? ORDER BY credential_profile_id`,
			[c.req.param('teamId'), c.req.param('connectionId')],
		);
		return c.json({ ok: true, payload: rows.map(authority) });
	});

	app.put('/v1/teams/:teamId/services/:connectionId/credential-authorities/:profileId', async (c: any) => {
		const access = await manage(c);
		if (access.response) return access.response;
		const connection = await store.getTeamServiceConnection(c.req.param('teamId'), c.req.param('connectionId'));
		if (!connection) return jsonError(c, 404, 'Service connection not found.');
		const provider = getServiceProviderDefinition(connection.providerId);
		const profile = provider?.credentialProfiles.find((item) => item.id === c.req.param('profileId'));
		if (!profile) return jsonError(c, 404, 'Credential profile not found.');
		const body = await c.req.json().catch(() => ({}));
		if (!CREDENTIAL_AUTHORITY_SCHEMES.includes(body.scheme)) {
			return jsonError(c, 400, 'Choose a supported credential authority scheme.', { code: 'invalid_credential_authority_scheme' });
		}
		if (!profile.authoritySchemes?.includes(body.scheme)) {
			return jsonError(c, 400, 'This credential profile does not support the selected authority scheme.', { code: 'credential_authority_scheme_mismatch' });
		}
		if (body.scheme === 'app-installation') {
			return jsonError(c, 409, 'GitHub App authority must be verified through the managed Connector authorization flow.', {
				code: 'credential_authority_connector_required',
			});
		}
		const reference = String(body.reference ?? '').trim();
		if (!reference || (body.scheme === 'environment-reference' && !ENV_REFERENCE.test(reference))) {
			return jsonError(c, 400, 'A valid non-secret authority reference is required.', { code: 'invalid_credential_authority_reference' });
		}
		const capabilities = connection.capabilities
			.filter((binding: any) => binding.status === 'configured' && binding.credentialProfileId === profile.id)
			.map((binding: any) => binding.capabilityType)
			.filter((capability: string) => profile.capabilities.includes(capability as any));
		if (!capabilities.length) return jsonError(c, 409, 'Enable a capability for this credential profile first.', { code: 'credential_authority_unused' });
		const existing: any = await store.first(
			`SELECT * FROM provider_credential_authorities WHERE connection_id = ? AND credential_profile_id = ?`,
			[connection.id, profile.id],
		);
		if (existing && body.version !== undefined && Number(body.version) !== Number(existing.version)) {
			return jsonError(c, 409, 'The credential authority changed after this page was loaded.', { code: 'credential_authority_conflict' });
		}
		const status = ['client-encrypted', 'api-token', 'oauth-token'].includes(body.scheme) ? 'interactive-only' : 'ready';
		const now = new Date().toISOString();
		const id = existing?.id ?? randomUUID();
		await store.run(
			`INSERT INTO provider_credential_authorities (id, team_id, connection_id, credential_profile_id, scheme, reference,
			 capabilities_json, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
			 ON CONFLICT(connection_id, credential_profile_id) DO UPDATE SET scheme = excluded.scheme, reference = excluded.reference,
			 capabilities_json = excluded.capabilities_json, status = excluded.status,
			 version = provider_credential_authorities.version + 1, updated_at = excluded.updated_at`,
			[id, connection.teamId, connection.id, profile.id, body.scheme, reference, JSON.stringify(capabilities), status, now, now],
		);
		const saved = authority(await store.first(`SELECT * FROM provider_credential_authorities WHERE id = ?`, [id]));
		await store.recordAuditEvent({ eventType: 'provider.credential_authority.updated', actorType: 'user', actorId: access.principal.id,
			targetType: 'provider_credential_authority', targetId: id,
			data: { teamId: connection.teamId, connectionId: connection.id, profileId: profile.id, scheme: body.scheme, capabilities } });
		return c.json({ ok: true, code: 'credential_authority_saved', message: 'Credential authority saved.', payload: saved });
	});
}
