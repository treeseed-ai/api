import { aiStorageBindingSchema } from '@treeseed/sdk/deployment';
import { ensureAiStorageBucket } from '@treeseed/deployment/security/ai-storage';
import { managedSecretSession, serviceCredentialScope, type SecretSession } from '../../../security/managed-secrets.ts';
import { CapacityOperationError } from '../repositories/capacity/capacity-operation-error.ts';

export const storageFailure = (status: number, code: string, message: string): never => { throw new CapacityOperationError(status, code, message); };
export async function aiStorageConnection(store: any, teamId: string, connectionId: string) {
	const connection = await store.getTeamServiceConnection(teamId, connectionId);
	if (!connection || connection.teamId !== teamId || connection.status !== 'active' || connection.providerId !== 'cloudflare'
		|| !connection.capabilities?.some((item: any) => item.capabilityType === 'object-storage' && item.status === 'configured' && item.credentialProfileId === 'cloudflare-storage'))
		storageFailure(403, 'ai_storage_connection_unavailable', 'The selected storage connection is unavailable or access was revoked.');
	return connection;
}

export async function withAiStorageCustody<T>(store: any, teamId: string, connection: any, session: SecretSession, run: (token: string) => Promise<T>) {
	const authority = await store.first(`SELECT * FROM provider_credential_authorities WHERE team_id=? AND connection_id=?
		AND credential_profile_id='cloudflare-storage' AND scheme='openbao' AND status='ready'`, [teamId, connection.id]);
	if (!authority || !JSON.parse(authority.capabilities_json ?? '[]').includes('object-storage'))
		storageFailure(403, 'ai_storage_credentials_unavailable', 'Storage credentials are unavailable or revoked.');
	const scope = await serviceCredentialScope(store, teamId, connection, 'cloudflare-storage');
	try {
		return await session(scope, async custody => {
			const record = await custody.read(scope);
			if (!record?.values.apiToken || record.version !== Number(authority.version)) storageFailure(409, 'ai_storage_credentials_changed', 'Storage credentials changed; verify the connection again.');
			const result = await run(record.values.apiToken);
			const current = await store.first(`SELECT version,capabilities_json FROM provider_credential_authorities WHERE team_id=? AND connection_id=?
				AND credential_profile_id='cloudflare-storage' AND scheme='openbao' AND status='ready'`, [teamId, connection.id]);
			if (!current || Number(current.version) !== record.version || !JSON.parse(current.capabilities_json ?? '[]').includes('object-storage'))
				storageFailure(403, 'ai_storage_credentials_changed', 'Storage credentials changed during this operation.');
			return result;
		});
	} catch (error) {
		if (error instanceof CapacityOperationError) throw error;
		return storageFailure(503, 'ai_storage_custody_unavailable', 'Storage custody or provider authority is unavailable.');
	}
}

export function createAiStorageBindings(store: any, options: { session?: SecretSession; ensureBucket?: typeof ensureAiStorageBucket } = {}) {
	const session = options.session ?? managedSecretSession();
	const get = (teamId: string, nodeId: string) => store.first('SELECT * FROM team_ai_storage_bindings WHERE team_id=? AND node_id=?', [teamId, nodeId]);
	const descriptor = (row: any) => row ? { connectionId: row.connection_id, bucket: row.bucket, version: Number(row.version), status: row.status,
		configured: row.status === 'active', accessLifetimeSeconds: 60 } : { configured: false, version: 0, status: 'unconfigured' };
	async function authorize(principal: any, teamId: string, nodeId: string, write: boolean) {
		if (!principal) storageFailure(401, 'authentication_required', 'Sign in first.');
		const admin = principal.roles?.includes('platform_admin') || principal.permissions?.includes('*:*:*');
		if (!admin && (!await store.principalCanAccessTeam(principal, teamId) || write && !await store.principalCanManageServices(principal, teamId)))
			storageFailure(403, 'ai_storage_management_required', 'Team service management permission is required.');
		await store.ensureInitialized();
		const node = await store.first('SELECT * FROM team_ai_instances WHERE team_id=? AND id=?', [teamId, nodeId]);
		if (!node || JSON.parse(node.configuration_json).origin !== 'managed-local') storageFailure(404, 'ai_registered_node_required', 'Select a registered managed AI runtime.');
	}
	return {
		async show(principal: any, teamId: string, nodeId: string) { await authorize(principal, teamId, nodeId, false); return descriptor(await get(teamId, nodeId)); },
		async put(principal: any, teamId: string, nodeId: string, input: unknown, ifMatch?: string) {
			await authorize(principal, teamId, nodeId, true); const selection = aiStorageBindingSchema.parse(input), current = await get(teamId, nodeId);
			if (ifMatch !== (current ? String(current.version) : 'new')) storageFailure(412, 'ai_storage_version_conflict', 'Reload storage settings before saving.');
			// Relocation requires a separate copy/verify/switch migration, never an implicit empty store.
			if (current && (current.connection_id !== selection.connectionId || current.bucket !== selection.bucket))
				storageFailure(409, 'ai_storage_migration_required', 'Moving existing AI storage requires an artifact migration plan.');
			const connection = await aiStorageConnection(store, teamId, selection.connectionId);
			await withAiStorageCustody(store, teamId, connection, session, apiToken => (options.ensureBucket ?? ensureAiStorageBucket)({ accountId: connection.nonSecretConfig.accountId, bucket: selection.bucket, apiToken }));
			const checked = await aiStorageConnection(store, teamId, selection.connectionId);
			if (checked.version !== connection.version) storageFailure(412, 'ai_storage_connection_changed', 'The storage connection changed while verifying access.');
			const latest = await get(teamId, nodeId);
			if ((latest?.version ?? null) !== (current?.version ?? null)) storageFailure(412, 'ai_storage_version_conflict', 'Storage settings changed while verifying access.');
			if (current?.status === 'active') return { ...descriptor(current), noop: true };
			const now = new Date().toISOString();
			const saved = current ? await store.first(`UPDATE team_ai_storage_bindings SET status='active',version=version+1,updated_at=?
				WHERE team_id=? AND node_id=? AND version=? RETURNING *`, [now, teamId, nodeId, current.version])
				: await store.first(`INSERT INTO team_ai_storage_bindings (team_id,node_id,connection_id,bucket,updated_at)
				VALUES (?,?,?,?,?) ON CONFLICT (team_id,node_id) DO NOTHING RETURNING *`, [teamId, nodeId, selection.connectionId, selection.bucket, now]);
			if (!saved) storageFailure(412, 'ai_storage_version_conflict', 'Storage settings changed while saving.');
			await store.recordAuditEvent({ eventType: 'ai.storage.bound', actorType: 'user', actorId: principal.id, targetType: 'ai_node', targetId: nodeId, data: { teamId, connectionId: selection.connectionId, version: Number(saved.version) } });
			return descriptor(saved);
		},
		async remove(principal: any, teamId: string, nodeId: string, ifMatch?: string) {
			await authorize(principal, teamId, nodeId, true); const current = await get(teamId, nodeId);
			if (!current || ifMatch !== String(current.version)) storageFailure(412, 'ai_storage_version_conflict', 'Reload storage settings before revoking access.');
			const saved = await store.first(`UPDATE team_ai_storage_bindings SET status='revoked',version=version+1,updated_at=?
				WHERE team_id=? AND node_id=? AND version=? RETURNING *`, [new Date().toISOString(), teamId, nodeId, current.version]);
			if (!saved) storageFailure(412, 'ai_storage_version_conflict', 'Storage settings changed while revoking access.');
			await store.recordAuditEvent({ eventType: 'ai.storage.revoked', actorType: 'user', actorId: principal.id, targetType: 'ai_node', targetId: nodeId, data: { teamId, version: Number(saved.version) } });
			return { ...descriptor(saved), artifactsPreserved: true, outstandingAccessMaximumSeconds: 60 };
		},
	};
}
