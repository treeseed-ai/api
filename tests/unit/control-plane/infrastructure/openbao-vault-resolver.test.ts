import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenBaoHostedAuthorityResolver } from '../../../../src/operations-runner/infrastructure/openbao-vault-resolver.ts';

const vaultConnectionId = '11111111-1111-1111-1111-111111111111';
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function request(purpose: 'provider' | 'state-encryption' = 'provider') {
	return { requestId: 'cloudflare-hosting:cloudflare-runtime', teamId: 'team-1', deploymentId: 'treeseed-cloud', stackId: 'control-plane', environment: 'production', backendBindingDigest: `sha256:${'a'.repeat(64)}`, provider: purpose === 'provider' ? 'cloudflare' : 'treeseed', connectionRef: 'cloudflare-hosting', ...(purpose === 'state-encryption' ? { secretRef: 'control-plane-key' } : {}), credentialProfileId: purpose === 'provider' ? 'cloudflare-runtime' : 'opentofu-state-encryption', capabilities: purpose === 'provider' ? ['frontend-hosting'] : ['state-encryption'], purpose } as any;
}

const authority = { reference: `openbao://${vaultConnectionId}/teams/team-1/hosting/cloudflare-production` };
const store = () => ({ first: vi.fn(async () => ({ id: vaultConnectionId, team_id: 'team-1', provider_id: 'openbao', status: 'active', non_secret_config_json: JSON.stringify({ address: 'http://127.0.0.1:8200', mount: 'secret', role: 'treeseed-operations', authMount: 'jwt' }) })) });

describe('team-scoped OpenBao hosted authority', () => {
	it('uses a workload JWT and reads only the canonical team KV path', async () => {
		const root = await mkdtemp(join(tmpdir(), 'treeseed-openbao-')); roots.push(root); const jwtFile = join(root, 'identity.jwt'); await writeFile(jwtFile, 'short-lived-jwt\n');
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(url), ...(init ? { init } : {}) });
			return calls.length === 1 ? Response.json({ auth: { client_token: 'vault-session', lease_duration: 300 } }) : Response.json({ data: { data: { apiToken: 'cloudflare-secret' } } });
		});
		const selectedStore = store(), resolver = createOpenBaoHostedAuthorityResolver({ store: selectedStore, env: { NODE_ENV: 'test', TREESEED_OPENBAO_WORKLOAD_JWT_FILE: jwtFile }, fetchImpl: fetchImpl as typeof fetch });
		const result = await resolver({ authority, request: request() });
		expect(result.values).toEqual({ apiToken: 'cloudflare-secret' }); expect(new Date(result.expiresAt!).getTime()).toBeGreaterThan(Date.now());
		expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ role: 'treeseed-operations', jwt: 'short-lived-jwt' });
		expect(calls[1]!.url).toContain('/v1/secret/data/teams/team-1/hosting/cloudflare-production');
		expect((calls[1]!.init!.headers as Record<string, string>)['x-vault-token']).toBe('vault-session');
		expect(selectedStore.first).toHaveBeenCalledWith(expect.stringContaining("provider_id = 'openbao'"), [vaultConnectionId, 'team-1']);
	});

	it('supports an explicit AppRole bootstrap and derives state encryption custody', async () => {
		const calls: string[] = [], fetchImpl = vi.fn(async (url: string | URL | Request) => {
			calls.push(String(url)); return calls.length === 1 ? Response.json({ auth: { client_token: 'session', lease_duration: 120 } }) : Response.json({ data: { data: { key: 'b'.repeat(64) } } });
		});
		const resolver = createOpenBaoHostedAuthorityResolver({ store: store(), env: { NODE_ENV: 'test', TREESEED_OPENBAO_ROLE_ID: 'role-id', TREESEED_OPENBAO_SECRET_ID: 'secret-id' }, fetchImpl: fetchImpl as typeof fetch });
		expect((await resolver({ authority, request: request('state-encryption') })).values.key).toHaveLength(64);
		expect(calls[0]).toContain('/v1/auth/approle/login'); expect(calls[1]).toContain('/teams/team-1/state-encryption/control-plane-key');
	});

	it('fails closed for cross-team paths, inactive vaults, insecure endpoints, and invalid leases', async () => {
		const fetchImpl = vi.fn(async () => Response.json({ auth: { client_token: 'session', lease_duration: 30 } }));
		const env = { NODE_ENV: 'test', TREESEED_OPENBAO_ROLE_ID: 'role-id', TREESEED_OPENBAO_SECRET_ID: 'secret-id' };
		const resolver = createOpenBaoHostedAuthorityResolver({ store: store(), env, fetchImpl: fetchImpl as typeof fetch });
		await expect(resolver({ authority: { reference: `openbao://${vaultConnectionId}/teams/team-2/hosting/cloudflare` }, request: request() })).rejects.toThrow(/team namespace/u);
		await expect(resolver({ authority, request: request() })).rejects.toThrow(/invalid workload lease/u);
		const missing = createOpenBaoHostedAuthorityResolver({ store: { first: vi.fn(async () => null) }, env, fetchImpl: fetchImpl as typeof fetch });
		await expect(missing({ authority, request: request() })).rejects.toThrow(/team-scoped OpenBao/u);
		const insecure = createOpenBaoHostedAuthorityResolver({ store: { first: vi.fn(async () => ({ non_secret_config_json: JSON.stringify({ address: 'http://vault.example.test', mount: 'secret' }) })) }, env, fetchImpl: fetchImpl as typeof fetch });
		await expect(insecure({ authority, request: request() })).rejects.toThrow(/HTTPS/u);
	});
});
