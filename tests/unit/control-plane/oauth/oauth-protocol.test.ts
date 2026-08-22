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
			revokeOAuthToken,
		};
		const app = new Hono();
		installControlPlaneProtocolRoutes(app, async () => null, provider);

		const resource = await app.request('/.well-known/oauth-protected-resource/mcp');
		expect(await resource.json()).toMatchObject({ resource: 'http://localhost/mcp', authorization_servers: ['http://localhost'] });
		const metadata = await (await app.request('/.well-known/oauth-authorization-server')).json() as any;
		expect(metadata).toMatchObject({ grant_types_supported: [DEVICE_GRANT, 'refresh_token'], revocation_endpoint: 'http://localhost/oauth/revoke' });
		expect(metadata).not.toHaveProperty('authorization_endpoint');

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

		const revoked = await app.request('/oauth/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: 'client_id=trsd&token=access' });
		expect(revoked.status).toBe(200);
		expect(revokeOAuthToken).toHaveBeenCalledWith('access');
		const unregistered = await app.request('/oauth/device_authorization', { method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'client_id=unknown' });
		expect(await unregistered.json()).toMatchObject({ error: 'invalid_client' });
	});
});
