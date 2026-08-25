import { randomUUID } from 'node:crypto';
import { connectorStateHash, createConnectorState, githubConnectorConfig, githubConnectorRequiredPermissions,
	isGitHubConnectorKind, readConnectorState } from '../../../security/github-connector-config.ts';
import { connectorCapabilities, exchangeGitHubUserCode, verifyGitHubInstallation,
	verifyGitHubUserInstallation } from './github-connector-client.ts';
import { WorkflowOperationError } from './workflow-operation-error.ts';

type Principal = { id: string; roles?: string[]; permissions?: string[] } | undefined;
type State = { authorizationId: string; nonce: string; kind: string; expiresAt: string };
const AUTH_TTL_MS = 10 * 60 * 1000;

function appRedirect(connectionId: string, outcome: string) {
	const base = String(process.env.TREESEED_SITE_URL ?? 'http://127.0.0.1:4321').replace(/\/+$/u, '');
	return `${base}/app/services/${encodeURIComponent(connectionId)}?connector=${encodeURIComponent(outcome)}`;
}

async function manageTeam(store: any, principal: Principal, teamId: string) {
	if (!principal) throw new WorkflowOperationError(401, 'authentication_required', 'Authentication is required.');
	const administrator = principal.roles?.some((role) => role === 'admin' || role === 'platform_admin') || principal.permissions?.includes('*:*:*') || false;
	if (!administrator && !await store.principalCanAccessTeam(principal, teamId)) throw new WorkflowOperationError(403, 'team_access_denied', 'The principal cannot access this team.');
	const summary = administrator ? { permissions: ['*:*:*'] } : await store.getTeamAccessSummary(teamId, principal);
	if (!administrator && !summary.permissions.includes('services:manage:team')) throw new WorkflowOperationError(403, 'connector_management_denied', 'Service management authority is required.');
	return principal;
}

function config(kind: string) {
	if (!isGitHubConnectorKind(kind)) throw new WorkflowOperationError(404, 'connector_not_found', 'Connector not found.');
	try { return { kind, config: githubConnectorConfig(kind) } as const; }
	catch (error) { throw new WorkflowOperationError(503, 'connector_unavailable', error instanceof Error ? error.message : 'Connector is unavailable.'); }
}

export function createGitHubConnectorService(store: any) {
	return {
		async setup(principal: Principal, kindValue: string, body: Record<string, unknown>) {
			const { kind, config: connector } = config(kindValue); const teamId = String(body.teamId ?? '');
			const connectionId = String(body.connectionId ?? ''); const actor = await manageTeam(store, principal, teamId);
			const connection = await store.getTeamServiceConnection(teamId, connectionId);
			if (!connection || connection.providerId !== 'github') throw new WorkflowOperationError(404, 'github_connection_not_found', 'GitHub service connection not found.');
			const authorizationId = randomUUID(); const expiresAt = new Date(Date.now() + AUTH_TTL_MS).toISOString();
			const state = createConnectorState({ authorizationId, nonce: randomUUID(), kind, expiresAt }, connector.stateSecret);
			const now = new Date().toISOString();
			await store.run(`INSERT INTO provider_connector_authorizations (id, provider_id, connector_kind, team_id, connection_id,
				actor_user_id, state_hash, phase, expires_at, created_at, updated_at) VALUES (?, 'github', ?, ?, ?, ?, ?, 'installation', ?, ?, ?)`,
				[authorizationId, kind, teamId, connectionId, actor.id, connectorStateHash(state), expiresAt, now, now]);
			const url = new URL(`https://github.com/apps/${encodeURIComponent(connector.slug)}/installations/new`); url.searchParams.set('state', state);
			return { code: 'github_connector_setup_started', redirect: url.toString(), expiresAt };
		},
		async callback(kindValue: string, query: Record<string, unknown>) {
			const { kind, config: connector } = config(kindValue); const stateValue = String(query.state ?? '');
			const state = readConnectorState<State>(stateValue, connector.stateSecret);
			if (!state || state.kind !== kind || Date.parse(state.expiresAt) <= Date.now()) throw new WorkflowOperationError(400, 'connector_state_invalid', 'Connector authorization state is invalid or expired.');
			const row: any = await store.first('SELECT * FROM provider_connector_authorizations WHERE id = ? AND state_hash = ?',
				[state.authorizationId, connectorStateHash(stateValue)]);
			if (!row || row.consumed_at || row.connector_kind !== kind || Date.parse(row.expires_at) <= Date.now()) throw new WorkflowOperationError(400, 'connector_state_invalid', 'Connector authorization state is invalid or expired.');
			try {
				const installationId = String(query.installation_id ?? '');
				if (row.phase === 'installation' && installationId) {
					const installation = await verifyGitHubInstallation({ appId: connector.appId, privateKey: connector.privateKey,
						installationId, requiredPermissions: githubConnectorRequiredPermissions(kind) });
					await store.run(`UPDATE provider_connector_authorizations SET phase = 'user-oauth', installation_id = ?, account_id = ?,
						account_login = ?, updated_at = ? WHERE id = ? AND phase = 'installation'`,
						[installation.installationId, installation.accountId, installation.accountLogin, new Date().toISOString(), row.id]);
					const target = new URL('https://github.com/login/oauth/authorize'); target.searchParams.set('client_id', connector.clientId);
					target.searchParams.set('redirect_uri', `${connector.baseUrl}/v1/provider-connectors/github/${kind}/callback`);
					target.searchParams.set('state', stateValue); return { redirect: target.toString(), phase: 'user-oauth' };
				}
				if (row.phase !== 'user-oauth' || !query.code || !row.installation_id) throw new Error('Connector callback is out of sequence.');
				const installation = await verifyGitHubInstallation({ appId: connector.appId, privateKey: connector.privateKey,
					installationId: String(row.installation_id), requiredPermissions: githubConnectorRequiredPermissions(kind) });
				const token = await exchangeGitHubUserCode({ clientId: connector.clientId, clientSecret: connector.clientSecret, code: String(query.code) });
				const githubUser = await verifyGitHubUserInstallation({ token, installationId: String(row.installation_id) });
				const linked: any = await store.first("SELECT provider_subject FROM user_identities WHERE user_id = ? AND provider = 'github' LIMIT 1", [row.actor_user_id]);
				if (linked && String(linked.provider_subject) !== githubUser.id) throw new Error('The GitHub identity does not match the initiating TreeSeed user.');
				const connection = await store.getTeamServiceConnection(row.team_id, row.connection_id);
				if (!connection || connection.providerId !== 'github') throw new Error('The GitHub service connection no longer exists.');
				const nonSecretConfig = { ...connection.nonSecretConfig, githubConnectors: { ...(connection.nonSecretConfig?.githubConnectors ?? {}),
					[kind]: { installationId: row.installation_id, accountId: row.account_id, accountLogin: row.account_login,
						authorizedGitHubUserId: githubUser.id, repositorySelection: installation.repositorySelection, authorizedAt: new Date().toISOString() } } };
				await store.updateTeamServiceConnection(row.team_id, row.connection_id, { nonSecretConfig, status: 'active', actorUserId: row.actor_user_id });
				const capabilities = connectorCapabilities(kind).filter((item) => connection.capabilities.some((binding: any) => binding.capabilityType === item && binding.credentialProfileId === connector.profileId && binding.status === 'configured'));
				if (!capabilities.length) throw new Error(`Enable a ${kind} capability before authorizing this Connector.`);
				const existing: any = await store.first('SELECT id FROM provider_credential_authorities WHERE connection_id = ? AND credential_profile_id = ?', [row.connection_id, connector.profileId]);
				const authorityId = existing?.id ?? randomUUID(); const now = new Date().toISOString();
				await store.run(`INSERT INTO provider_credential_authorities (id, team_id, connection_id, credential_profile_id, scheme,
					reference, capabilities_json, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, 'app-installation', ?, ?, 'ready', 1, ?, ?)
					ON CONFLICT(connection_id, credential_profile_id) DO UPDATE SET reference = excluded.reference,
					capabilities_json = excluded.capabilities_json, status = 'ready', version = provider_credential_authorities.version + 1,
					updated_at = excluded.updated_at`, [authorityId, row.team_id, row.connection_id, connector.profileId,
					`installation:${row.installation_id}`, JSON.stringify(capabilities), now, now]);
				await store.run("UPDATE provider_connector_authorizations SET phase = 'complete', consumed_at = ?, updated_at = ? WHERE id = ?", [now, now, row.id]);
				await store.recordAuditEvent({ eventType: 'provider.connector.authorized', actorType: 'user', actorId: row.actor_user_id,
					targetType: 'team_service_connection', targetId: row.connection_id, data: { teamId: row.team_id,
						providerId: 'github', connectorKind: kind, installationId: row.installation_id, accountId: row.account_id } });
				return { redirect: appRedirect(row.connection_id, `${kind}-authorized`), phase: 'complete' };
			} catch (error) {
				const now = new Date().toISOString(); await store.run("UPDATE provider_connector_authorizations SET phase = 'failed', consumed_at = ?, updated_at = ? WHERE id = ?", [now, now, row.id]).catch(() => null);
				console.warn(`[provider-connector] ${kind} authorization failed for ${row.id}:`, error instanceof Error ? error.message : String(error));
				return { redirect: appRedirect(row.connection_id, 'authorization-failed'), phase: 'failed' };
			}
		},
	};
}
