import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { installControlPlaneProtocolRoutes } from '../../../../src/api/control-plane/http/protocol-routes.ts';

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

describe('OAuth protocol', () => {
	it('publishes metadata and executes device, refresh, and revocation protocols', async () => {
		const revokeOAuthToken = vi.fn();
		const provider = {
			async startDeviceFlow() {
				return { deviceCode: 'device-code', userCode: 'ABCD-EFGH', verificationUri: 'http://localhost/approve',
					verificationUriComplete: 'http://localhost/approve?user_code=ABCD-EFGH', intervalSeconds: 5, expiresInSeconds: 600 };
			},
			async pollDeviceFlow({ deviceCode }: { deviceCode: string }) {
				if (deviceCode === 'pending') return { status: 'pending', intervalSeconds: 5 };
				return { status: 'approved', accessToken: 'access', refreshToken: 'refresh', tokenType: 'Bearer',
					expiresInSeconds: 900, principal: { scopes: ['treeseed:read'] } };
			},
			async refreshAccessToken() {
				return { accessToken: 'access-2', refreshToken: 'refresh-2', tokenType: 'Bearer',
					expiresInSeconds: 900, principal: { scopes: ['treeseed:read'] } };
			},
			async startAuthorizationCode() { return { code: 'authorization-code', expiresInSeconds: 300 }; },
			async exchangeAuthorizationCode() {
				return { accessToken: 'access-3', refreshToken: 'refresh-3', tokenType: 'Bearer',
					expiresInSeconds: 900, principal: { scopes: ['treeseed:read'] } };
			},
			revokeOAuthToken,
		};
		const app = new Hono();
		installControlPlaneProtocolRoutes(app, async (token) => token === 'user-session' ? { principal: { id: 'user-a' }, credential: { id: 'session-a' } } : null, provider);

		const resource = await app.request('/.well-known/oauth-protected-resource/mcp');
		expect(await resource.json()).toMatchObject({ resource: 'http://localhost/mcp', authorization_servers: ['http://localhost'] });
		const metadata = await (await app.request('/.well-known/oauth-authorization-server')).json() as any;
		expect(metadata).toMatchObject({ grant_types_supported: ['authorization_code', DEVICE_GRANT, 'refresh_token'],
			authorization_endpoint: 'http://localhost/oauth/authorize', revocation_endpoint: 'http://localhost/oauth/revoke',
			code_challenge_methods_supported: ['S256'] });

		const started = await app.request('/oauth/device_authorization', { method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'client_id=trsd&scope=treeseed%3Aread' });
		expect(await started.json()).toMatchObject({ device_code: 'device-code', user_code: 'ABCD-EFGH', expires_in: 600 });
		const pending = await app.request('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: `client_id=trsd&grant_type=${encodeURIComponent(DEVICE_GRANT)}&device_code=pending` });
		expect(await pending.json()).toMatchObject({ error: 'authorization_pending' });
		const approved = await app.request('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: `client_id=trsd&grant_type=${encodeURIComponent(DEVICE_GRANT)}&device_code=device-code` });
		expect(await approved.json()).toMatchObject({ access_token: 'access', refresh_token: 'refresh', scope: 'treeseed:read' });
		expect(approved.headers.get('cache-control')).toBe('no-store');
		const verifier = 'a'.repeat(43);
		const challenge = createHash('sha256').update(verifier).digest('base64url');
		const authorization = await app.request('/oauth/authorize', { method: 'POST', headers: {
			'content-type': 'application/x-www-form-urlencoded', authorization: 'Bearer user-session' }, body: new URLSearchParams({
			client_id: 'trsd', redirect_uri: 'http://127.0.0.1:8765/callback', response_type: 'code',
			code_challenge: challenge, code_challenge_method: 'S256', scope: 'treeseed:read', decision: 'approve', state: 'state-a',
		}).toString() });
		expect(await authorization.json()).toMatchObject({ code: 'authorization-code', state: 'state-a' });
		const exchanged = await app.request('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ client_id: 'trsd', grant_type: 'authorization_code', code: 'authorization-code',
				redirect_uri: 'http://127.0.0.1:8765/callback', code_verifier: verifier }).toString() });
		expect(await exchanged.json()).toMatchObject({ access_token: 'access-3', refresh_token: 'refresh-3' });

		const revoked = await app.request('/oauth/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: 'client_id=trsd&token=access' });
		expect(revoked.status).toBe(200);
		expect(revokeOAuthToken).toHaveBeenCalledWith('access');
		const unregistered = await app.request('/oauth/device_authorization', { method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'client_id=unknown' });
		expect(await unregistered.json()).toMatchObject({ error: 'invalid_client' });
	});
});
