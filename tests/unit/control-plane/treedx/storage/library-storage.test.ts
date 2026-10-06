import { describe, expect, it, vi } from 'vitest';
import { libraryStorageBinding, withLibraryStorage } from '../../../../../src/security/library-storage.ts';

vi.mock('../../../../../src/security/managed-secrets.ts', () => ({
	serviceCredentialScope: vi.fn(async (_store, team, connection) => ({ team, project: 'team', environment: 'shared', purpose: 'cloudflare-storage', name: connection.id })),
	managedSecretSession: vi.fn(() => { throw new Error('Unexpected real custody'); }),
}));
const env = { TREESEED_ENVIRONMENT: 'local', TREESEED_LIBRARY_STORAGE_OWNER_TEAM_ID: 'owner', TREESEED_LIBRARY_STORAGE_CONNECTION_ID: 'connection' };
function fixture() {
	const connection = { id: 'connection', teamId: 'owner', providerId: 'cloudflare', status: 'active', version: 1,
		nonSecretConfig: { accountId: 'a'.repeat(32) }, capabilities: [{ capabilityType: 'object-storage', status: 'configured', credentialProfileId: 'cloudflare-storage' }] };
	const store = { getTeamServiceConnection: vi.fn(async () => connection), first: vi.fn(async () => ({ version: 1, capabilities_json: '["object-storage"]' })) };
	const read = vi.fn(async () => ({ version: 1, values: { apiToken: 'private-token' } }));
	const session = vi.fn(async (scope, run) => run({ read }));
	const verifyBucket = vi.fn(async () => ({ bucket: 'treeseed-dev-library', verifiedPrivate: true as const }));
	return { store, connection, read, session, verifyBucket };
}
describe('site library storage authority', () => {
	it.each(['local', 'staging', 'test'])('maps %s to the shared staging bucket', environment => {
		expect(libraryStorageBinding({ ...env, TREESEED_ENVIRONMENT: environment })).toMatchObject({ bucket: 'treeseed-dev-library', branch: 'staging' });
	});
	it('maps production to the existing production bucket', () => {
		expect(libraryStorageBinding({ ...env, TREESEED_ENVIRONMENT: 'production' })).toMatchObject({ bucket: 'treeseed-library', branch: 'main' });
	});
	it('rejects environment/branch conflict and missing authority without ambient fallback', () => {
		expect(() => libraryStorageBinding({ ...env, TREESEED_LIBRARY_BRANCH: 'main' })).toThrow('conflicts');
		expect(() => libraryStorageBinding({ ...env, TREESEED_ENVIRONMENT: 'preview' })).toThrow('environment');
		expect(() => libraryStorageBinding({ TREESEED_ENVIRONMENT: 'local', TREESEED_CLOUDFLARE_API_TOKEN: 'old' })).toThrow('binding');
	});
	it('uses the pinned owner and a bounded custody callback, exposing no credential in its result', async () => {
		const f = fixture(); const result = await withLibraryStorage(f.store, env, async ({ bucket, branch, privacy }) => ({ bucket, branch, privacy }), f as any);
		expect(f.store.getTeamServiceConnection).toHaveBeenCalledWith('owner', 'connection');
		expect(f.session).toHaveBeenCalledOnce();
		expect(result).toMatchObject({ bucket: 'treeseed-dev-library', privacy: { verifiedPrivate: true } });
		expect(JSON.stringify(result)).not.toContain('private-token');
	});
	it.each(['revoked', 'cross-team', 'version', 'capability'])('denies invalid %s authority before storage use', async reason => {
		const f = fixture(), run = vi.fn();
		if (reason === 'revoked') f.connection.status = 'revoked';
		if (reason === 'cross-team') f.connection.teamId = 'other';
		if (reason === 'version') f.read.mockResolvedValue({ version: 2, values: { apiToken: 'private-token' } });
		if (reason === 'capability') f.connection.capabilities = [];
		await expect(withLibraryStorage(f.store, env, run, f as any)).rejects.toThrow();
		expect(run).not.toHaveBeenCalled();
	});
	it('rejects revocation during a storage operation', async () => {
		const f = fixture();
		await expect(withLibraryStorage(f.store, env, async () => { f.connection.status = 'revoked'; }, f as any)).rejects.toThrow('changed');
	});
});
