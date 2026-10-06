import { describe, expect, it, vi } from 'vitest';
import { clientAllowsRedirect, resolveOAuthClient } from '../../../../src/api/control-plane/oauth/oauth-clients.ts';

describe('OAuth Client ID Metadata Documents', () => {
	it('validates public HTTPS metadata and exact redirect URIs', async () => {
		const clientId = 'https://assistant.example.test/oauth-client.json';
		const fetchClient = vi.fn(async () => new Response(JSON.stringify({
			client_id: clientId,
			redirect_uris: ['https://assistant.example.test/oauth/callback'],
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: 'none',
		}), { headers: { 'content-type': 'application/json' } }));
		const client = await resolveOAuthClient(clientId, {
			fetch: fetchClient as typeof fetch,
			lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]) as never,
		});
		expect(clientAllowsRedirect(client, 'https://assistant.example.test/oauth/callback')).toBe(true);
		expect(clientAllowsRedirect(client, 'https://attacker.example.test/callback')).toBe(false);
		expect(fetchClient).toHaveBeenCalledWith(new URL(clientId), expect.objectContaining({ redirect: 'error' }));
	});

	it('rejects private resolution, redirects, oversized responses, and inconsistent identity', async () => {
		const clientId = 'https://assistant.example.test/oauth-client.json';
		await expect(resolveOAuthClient(clientId, {
			lookup: vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]) as never,
		})).rejects.toThrow('public addresses');
		await expect(resolveOAuthClient(clientId, {
			lookup: vi.fn(async () => [{ address: '::ffff:127.0.0.1', family: 6 }]) as never,
		})).rejects.toThrow('public addresses');
		await expect(resolveOAuthClient(clientId, {
			lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]) as never,
			fetch: vi.fn(async () => new Response(JSON.stringify({ client_id: 'https://different.example.test/client.json' }),
				{ headers: { 'content-type': 'application/json' } })) as typeof fetch,
		})).rejects.toThrow('incomplete or inconsistent');
		await expect(resolveOAuthClient(clientId, {
			lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]) as never,
			fetch: vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '65537' } })) as typeof fetch,
		})).rejects.toThrow('64 KiB');
	});

	it('allows only the exact Admin callback on loopback when local development enables it', async () => {
		const client = await resolveOAuthClient('treeseed-admin', {}, 'https://admin.treeseed.localhost/auth/callback/treeseed');
		expect(clientAllowsRedirect(client, 'http://127.0.0.1:4322/auth/callback/treeseed')).toBe(false);
		expect(clientAllowsRedirect(client, 'http://127.0.0.1:4322/auth/callback/treeseed', { allowAdminLoopback: true })).toBe(true);
		expect(clientAllowsRedirect(client, 'http://localhost:4322/auth/callback/treeseed', { allowAdminLoopback: true })).toBe(true);
		expect(clientAllowsRedirect(client, 'http://127.0.0.1:4322/auth/callback/other', { allowAdminLoopback: true })).toBe(false);
		expect(clientAllowsRedirect(client, 'https://attacker.example.test/auth/callback/treeseed', { allowAdminLoopback: true })).toBe(false);
	});
});
