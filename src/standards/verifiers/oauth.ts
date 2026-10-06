import { createHash, randomBytes } from 'node:crypto';
import { expectStatus, VerifierHttp } from './http.ts';

const base64url = (value: Buffer) => value.toString('base64url');

export async function authorize(http: VerifierHttp, input: { identifier: string; password: string; adminOrigin: string; decision?: 'approve' | 'deny' }) {
	const verifier = base64url(randomBytes(48));
	const challenge = base64url(createHash('sha256').update(verifier).digest());
	const redirectUri = `${input.adminOrigin.replace(/\/+$/u, '')}/auth/callback/treeseed`;
	const state = base64url(randomBytes(24));
	const scope = 'treeseed:read treeseed:projects:write';
	const query = new URLSearchParams({ client_id: 'treeseed-admin', redirect_uri: redirectUri, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', scope, state });
	expectStatus(await http.request('GET', `/oauth/authorize?${query}`), 200, 'authorization presentation');
	const decision = expectStatus(await http.request('POST', '/oauth/authorize', {
		client_id: 'treeseed-admin', redirect_uri: redirectUri, response_type: 'code', code_challenge: challenge,
		code_challenge_method: 'S256', scope, state, decision: input.decision ?? 'approve', identifier: input.identifier, password: input.password,
	}), 200, 'authorization decision').data as { redirectTo?: string; approved?: boolean };
	const target = new URL(String(decision.redirectTo));
	if (target.searchParams.get('state') !== state) throw new Error('Authorization state was not preserved.');
	if (input.decision === 'deny') {
		if (decision.approved !== false || target.searchParams.get('error') !== 'access_denied') throw new Error('Authorization denial was not preserved.');
		return null;
	}
	const code = target.searchParams.get('code');
	if (!code || decision.approved !== true) throw new Error('Authorization approval did not return a code.');
	const token = expectStatus(await http.request('POST', '/oauth/token', {
		grant_type: 'authorization_code', client_id: 'treeseed-admin', redirect_uri: redirectUri, code, code_verifier: verifier,
	}), 200, 'authorization code exchange').body as { access_token?: string; refresh_token?: string };
	if (!token.access_token || !token.refresh_token) throw new Error('Token exchange omitted credentials.');
	expectStatus(await http.request('POST', '/oauth/token', {
		grant_type: 'authorization_code', client_id: 'treeseed-admin', redirect_uri: redirectUri, code, code_verifier: verifier,
	}), 400, 'authorization code replay');
	return { accessToken: token.access_token, refreshToken: token.refresh_token };
}

export async function verifyDeviceFlow(http: VerifierHttp, accessToken: string) {
	const grantType = 'urn:ietf:params:oauth:grant-type:device_code';
	const started = expectStatus(await http.request('POST', '/oauth/device_authorization', {
		client_id: 'trsd', scope: 'treeseed:read treeseed:projects:write',
	}), 200, 'device authorization').body as { device_code?: string; user_code?: string };
	if (!started.device_code || !started.user_code) throw new Error('Device authorization omitted its codes.');
	expectStatus(await http.request('POST', '/oauth/token', { grant_type: grantType, client_id: 'trsd', device_code: started.device_code }), 400, 'pending device token');
	expectStatus(await http.withToken(accessToken).request('POST', '/auth/device/approve', { user_code: started.user_code }), 200, 'device approval');
	const issued = expectStatus(await http.request('POST', '/oauth/token', { grant_type: grantType, client_id: 'trsd', device_code: started.device_code }), 200, 'approved device token').body as { access_token?: string; refresh_token?: string };
	if (!issued.access_token || !issued.refresh_token) throw new Error('Device token exchange omitted credentials.');
	expectStatus(await http.request('POST', '/oauth/token', { grant_type: grantType, client_id: 'trsd', device_code: started.device_code }), 400, 'device code replay');
	expectStatus(await http.request('POST', '/oauth/revoke', { client_id: 'trsd', token: issued.refresh_token }), 200, 'device token revocation');
}
