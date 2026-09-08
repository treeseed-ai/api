import { ensureAiStorageBucket } from '@treeseed/deployment/security/ai-storage';
import { createR2PublicationClient, type R2PublicationClient } from '../api/providers/cloudflare/r2-publication-client.ts';
import { managedSecretSession, serviceCredentialScope, type SecretSession } from './managed-secrets.ts';

/** Site-owned binding: never select a credential by the consuming team's identity. */
export function libraryStorageBinding(env: NodeJS.ProcessEnv) {
	const environment = env.TREESEED_ENVIRONMENT;
	if (!['local', 'staging', 'production', 'test'].includes(environment ?? '')) throw new Error('Library storage deployment environment is required.');
	const branch = environment === 'production' ? 'main' : 'staging';
	if (env.TREESEED_LIBRARY_BRANCH && env.TREESEED_LIBRARY_BRANCH !== branch) throw new Error('Library storage branch conflicts with its deployment environment.');
	const teamId = env.TREESEED_LIBRARY_STORAGE_OWNER_TEAM_ID;
	const connectionId = env.TREESEED_LIBRARY_STORAGE_CONNECTION_ID;
	if (!teamId || !connectionId) throw new Error('Site library storage service binding is required.');
	return { teamId, connectionId, branch, bucket: branch === 'main' ? 'treeseed-library' : 'treeseed-dev-library' };
}

/** Only already-authorized control-plane operations may use this internal site authority. */
export async function withLibraryStorage<T>(store: any, env: NodeJS.ProcessEnv, run: (input: {
	client: R2PublicationClient; bucket: string; branch: string; privacy: { verifiedPrivate: true };
}) => Promise<T>, options: { session?: SecretSession; fetchImpl?: typeof fetch; verifyBucket?: typeof ensureAiStorageBucket } = {}) {
	const binding = libraryStorageBinding(env);
	const connection = await store.getTeamServiceConnection(binding.teamId, binding.connectionId);
	if (!connection || connection.teamId !== binding.teamId || connection.status !== 'active' || connection.providerId !== 'cloudflare'
		|| !connection.capabilities?.some((item: any) => item.capabilityType === 'object-storage' && item.status === 'configured' && item.credentialProfileId === 'cloudflare-storage'))
		throw new Error('Site library storage connection is unavailable or revoked.');
	const authority = () => store.first(`SELECT version,capabilities_json FROM provider_credential_authorities WHERE team_id=? AND connection_id=?
		AND credential_profile_id='cloudflare-storage' AND scheme='openbao' AND status='ready'`, [binding.teamId, binding.connectionId]);
	const before = await authority();
	if (!before || !JSON.parse(before.capabilities_json).includes('object-storage')) throw new Error('Site library storage credential authority is unavailable.');
	const scope = await serviceCredentialScope(store, binding.teamId, connection, 'cloudflare-storage');
	return (options.session ?? managedSecretSession(env))(scope, async custody => {
		const record = await custody.read(scope);
		if (!record?.values.apiToken || record.version !== Number(before.version)) throw new Error('Site library storage credential version changed.');
		const accountId = String(connection.nonSecretConfig.accountId ?? '');
		await (options.verifyBucket ?? ensureAiStorageBucket)({ accountId, bucket: binding.bucket, apiToken: record.values.apiToken }, options.fetchImpl);
		const client = createR2PublicationClient({ accountId, bucket: binding.bucket, authMode: 'api-token', apiToken: record.values.apiToken }, options.fetchImpl);
		const result = await run({ client, bucket: binding.bucket, branch: binding.branch, privacy: { verifiedPrivate: true } });
		const after = await authority(), current = await store.getTeamServiceConnection(binding.teamId, binding.connectionId);
		if (!after || Number(after.version) !== record.version || !JSON.parse(after.capabilities_json).includes('object-storage')
			|| current?.status !== 'active' || current.version !== connection.version) throw new Error('Site library storage authority changed during the operation.');
		return result;
	});
}

/** Publication operations open custody only while performing their storage request. */
export function createLibraryStorageClient(store: any, env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): R2PublicationClient {
	if (!store) throw new Error('Site library storage requires its control-plane authority store.');
	const call = (method: keyof R2PublicationClient, args: any[]) => withLibraryStorage(store, env,
		async ({ client }) => (client[method] as (...values: any[]) => any)(...args), { fetchImpl });
	return Object.fromEntries(['get', 'getBytes', 'exists', 'put', 'putBytes', 'delete', 'list'].map(method =>
		[method, (...args: any[]) => call(method as keyof R2PublicationClient, args)])) as R2PublicationClient;
}
