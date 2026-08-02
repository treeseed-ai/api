import { randomUUID } from 'node:crypto';
import { connectorCapabilities, exchangeGitHubUserCode, verifyGitHubInstallation, verifyGitHubUserInstallation } from './github-connector-api.ts';
import { connectorStateHash, createConnectorState, githubConnectorConfig, githubConnectorRequiredPermissions, isGitHubConnectorKind, readConnectorState } from '../../../security/github-connector-config.ts';

const AUTH_TTL_MS = 10 * 60 * 1000;

type State = { authorizationId: string; nonce: string; kind: string; expiresAt: string };

function appRedirect(connectionId: string, outcome: string) {
	const base = String(process.env.TREESEED_SITE_URL ?? 'http://127.0.0.1:4321').replace(/\/+$/u, '');
	return `${base}/app/services/${encodeURIComponent(connectionId)}?connector=${encodeURIComponent(outcome)}`;
}

export function installGitHubConnectorRoutes(context: any) {
	const { app, store, requireTeamAccess, jsonError } = context;

	app.post('/v1/provider-connectors/github/:kind/setup', async (c: any) => {
		const kind = c.req.param('kind');
		if (!isGitHubConnectorKind(kind)) return jsonError(c, 404, 'Connector not found.');
		const body = await c.req.json().catch(() => ({}));
		const teamId = String(body.teamId ?? '');
		const connectionId = String(body.connectionId ?? '');
		const access = await requireTeamAccess(c, store, teamId, 'services:manage:team');
		if (access.response) return access.response;
		const connection = await store.getTeamServiceConnection(teamId, connectionId);
		if (!connection || connection.providerId !== 'github') return jsonError(c, 404, 'GitHub service connection not found.');
		let config;
		try { config = githubConnectorConfig(kind); } catch (error) {
			return jsonError(c, 503, error instanceof Error ? error.message : String(error), { code: 'connector_unavailable' });
		}
		const authorizationId = randomUUID();
		const expiresAt = new Date(Date.now() + AUTH_TTL_MS).toISOString();
		const state = createConnectorState({ authorizationId, nonce: randomUUID(), kind, expiresAt }, config.stateSecret);
		const now = new Date().toISOString();
		await store.run(`INSERT INTO provider_connector_authorizations
			(id, provider_id, connector_kind, team_id, connection_id, actor_user_id, state_hash, phase, expires_at, created_at, updated_at)
			VALUES (?, 'github', ?, ?, ?, ?, ?, 'installation', ?, ?, ?)`,
			[authorizationId, kind, teamId, connectionId, access.principal.id, connectorStateHash(state), expiresAt, now, now]);
		const url = new URL(`https://github.com/apps/${encodeURIComponent(config.slug)}/installations/new`);
		url.searchParams.set('state', state);
		return c.json({ ok: true, code: 'github_connector_setup_started', payload: { redirect: url.toString(), expiresAt } });
	});

	app.get('/v1/provider-connectors/github/:kind/callback', async (c: any) => {
		const kind = c.req.param('kind');
		if (!isGitHubConnectorKind(kind)) return jsonError(c, 404, 'Connector not found.');
		let config;
		try { config = githubConnectorConfig(kind); } catch (error) { return jsonError(c, 503, error instanceof Error ? error.message : String(error)); }
		const stateValue = String(c.req.query('state') ?? '');
		const state = readConnectorState<State>(stateValue, config.stateSecret);
		if (!state || state.kind !== kind || Date.parse(state.expiresAt) <= Date.now()) return jsonError(c, 400, 'Connector authorization state is invalid or expired.');
		const row: any = await store.first(`SELECT * FROM provider_connector_authorizations WHERE id = ? AND state_hash = ?`,
			[state.authorizationId, connectorStateHash(stateValue)]);
		if (!row || row.consumed_at || row.connector_kind !== kind || Date.parse(row.expires_at) <= Date.now()) return jsonError(c, 400, 'Connector authorization state is invalid or expired.');
		try {
			const installationId = String(c.req.query('installation_id') ?? '');
			if (row.phase === 'installation' && installationId) {
				const installation = await verifyGitHubInstallation({ appId: config.appId, privateKey: config.privateKey, installationId,
					requiredPermissions: githubConnectorRequiredPermissions(kind) });
				await store.run(`UPDATE provider_connector_authorizations SET phase = 'user-oauth', installation_id = ?, account_id = ?,
					account_login = ?, updated_at = ? WHERE id = ? AND phase = 'installation'`,
					[installation.installationId, installation.accountId, installation.accountLogin, new Date().toISOString(), row.id]);
				const target = new URL('https://github.com/login/oauth/authorize');
				target.searchParams.set('client_id', config.clientId);
				target.searchParams.set('redirect_uri', `${config.baseUrl}/v1/provider-connectors/github/${kind}/callback`);
				target.searchParams.set('state', stateValue);
				return c.redirect(target.toString(), 302);
			}
			if (row.phase !== 'user-oauth' || !c.req.query('code') || !row.installation_id) throw new Error('Connector callback is out of sequence.');
			const installation = await verifyGitHubInstallation({ appId: config.appId, privateKey: config.privateKey,
				installationId: String(row.installation_id), requiredPermissions: githubConnectorRequiredPermissions(kind) });
			const token = await exchangeGitHubUserCode({ clientId: config.clientId, clientSecret: config.clientSecret, code: String(c.req.query('code')) });
			const githubUser = await verifyGitHubUserInstallation({ token, installationId: String(row.installation_id) });
			const linked: any = await store.first(`SELECT provider_subject FROM user_identities WHERE user_id = ? AND provider = 'github' LIMIT 1`, [row.actor_user_id]);
			if (linked && String(linked.provider_subject) !== githubUser.id) throw new Error('The GitHub identity does not match the initiating TreeSeed user.');
			const connection = await store.getTeamServiceConnection(row.team_id, row.connection_id);
			if (!connection || connection.providerId !== 'github') throw new Error('The GitHub service connection no longer exists.');
			const nonSecretConfig = { ...connection.nonSecretConfig, githubConnectors: {
				...(connection.nonSecretConfig?.githubConnectors ?? {}), [kind]: { installationId: row.installation_id,
					accountId: row.account_id, accountLogin: row.account_login, authorizedGitHubUserId: githubUser.id,
					repositorySelection: installation.repositorySelection, authorizedAt: new Date().toISOString() },
			} };
			await store.updateTeamServiceConnection(row.team_id, row.connection_id, { nonSecretConfig, status: 'active', actorUserId: row.actor_user_id });
			const capabilities = connectorCapabilities(kind).filter((item) => connection.capabilities.some((binding: any) => binding.capabilityType === item
				&& binding.credentialProfileId === config.profileId && binding.status === 'configured'));
			if (!capabilities.length) throw new Error(`Enable a ${kind} capability before authorizing this Connector.`);
			const existing: any = await store.first(`SELECT id FROM provider_credential_authorities WHERE connection_id = ? AND credential_profile_id = ?`, [row.connection_id, config.profileId]);
			const authorityId = existing?.id ?? randomUUID();
			const now = new Date().toISOString();
			await store.run(`INSERT INTO provider_credential_authorities
				(id, team_id, connection_id, credential_profile_id, scheme, reference, capabilities_json, status, version, created_at, updated_at)
				VALUES (?, ?, ?, ?, 'app-installation', ?, ?, 'ready', 1, ?, ?)
				ON CONFLICT(connection_id, credential_profile_id) DO UPDATE SET reference = excluded.reference,
				capabilities_json = excluded.capabilities_json, status = 'ready', version = provider_credential_authorities.version + 1,
				updated_at = excluded.updated_at`, [authorityId, row.team_id, row.connection_id, config.profileId,
				`installation:${row.installation_id}`, JSON.stringify(capabilities), now, now]);
			await store.run(`UPDATE provider_connector_authorizations SET phase = 'complete', consumed_at = ?, updated_at = ? WHERE id = ?`, [now, now, row.id]);
			await store.recordAuditEvent({ eventType: 'provider.connector.authorized', actorType: 'user', actorId: row.actor_user_id,
				targetType: 'team_service_connection', targetId: row.connection_id,
				data: { teamId: row.team_id, providerId: 'github', connectorKind: kind, installationId: row.installation_id, accountId: row.account_id } });
			return c.redirect(appRedirect(row.connection_id, `${kind}-authorized`), 302);
		} catch (error) {
			await store.run(`UPDATE provider_connector_authorizations SET phase = 'failed', consumed_at = ?, updated_at = ? WHERE id = ?`,
				[new Date().toISOString(), new Date().toISOString(), row.id]).catch(() => null);
			console.warn(`[provider-connector] ${kind} authorization failed for ${row.id}:`, error instanceof Error ? error.message : String(error));
			return c.redirect(appRedirect(row.connection_id, 'authorization-failed'), 302);
		}
	});
}
