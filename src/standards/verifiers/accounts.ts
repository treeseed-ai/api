import { mailpitToken } from './mailpit.ts';
import { authorize } from './oauth.ts';
import { expectStatus, VerifierHttp } from './http.ts';

export interface VerifiedAccount { id: string; email: string; username: string; password: string; accessToken: string; refreshToken: string; }

export async function createVerifiedAccount(http: VerifierHttp, mailpitOrigin: string, adminOrigin: string, label: string): Promise<VerifiedAccount> {
	const nonce = `${Date.now()}${Math.floor(Math.random() * 100_000)}`;
	const email = `guarantee-${label}-${nonce}@example.test`;
	const username = `g${label}${nonce}`.slice(0, 30);
	const password = `TreeSeed-${label}-${nonce}-Verifier!`;
	expectStatus(await http.request('POST', '/v1/auth/web/sign-up', { email, username, password }), 200, `${label} registration`);
	const token = await mailpitToken(mailpitOrigin, email, 'Confirm your TreeSeed email', 'token');
	expectStatus(await http.request('POST', '/v1/auth/web/confirm-email', { token }), 200, `${label} email confirmation`);
	expectStatus(await http.request('POST', '/v1/auth/web/confirm-email', { token }), 401, `${label} confirmation replay`);
	await authorize(http, { identifier: email, password, adminOrigin, decision: 'deny' });
	const authorized = await authorize(http, { identifier: email, password, adminOrigin });
	if (!authorized) throw new Error('Account authorization unexpectedly denied.');
	const current = expectStatus(await http.withToken(authorized.accessToken).request('GET', '/v1/me'), 200, `${label} current identity`);
	const id = String((current.data as { principal?: { id?: string } }).principal?.id ?? '');
	if (!id) throw new Error('Authorized account omitted its durable user identifier.');
	return { id, email, username, password, ...authorized };
}

export async function verifyAccountJourneys(http: VerifierHttp, mailpitOrigin: string, adminOrigin: string, account: VerifiedAccount) {
	const anonymous = await http.request('GET', '/v1/me');
	expectStatus(anonymous, 401, 'anonymous identity');
	const client = http.withToken(account.accessToken);
	expectStatus(await client.request('GET', '/v1/me'), 200, 'current identity');
	const identity = expectStatus(await client.request('GET', '/v1/auth/web/account/identity'), 200, 'account identity');
	const etag = identity.headers.get('etag') ?? String((identity.data as { updatedAt?: string }).updatedAt ?? '0');
	expectStatus(await client.request('PATCH', '/v1/auth/web/profile', { displayName: 'Guarantee Owner', website: 'https://example.test' }, { 'if-match': etag }), 200, 'profile update');
	const publicProfile = expectStatus(await http.request('GET', `/v1/users/by-username/${encodeURIComponent(account.username)}/profile`), 200, 'public account profile');
	const publicProfileText = JSON.stringify(publicProfile.data);
	for (const privateValue of [account.email, account.password, account.accessToken, account.refreshToken]) {
		if (publicProfileText.includes(privateValue)) throw new Error('Public account profile disclosed private account state.');
	}
	const preferences = expectStatus(await client.request('GET', '/v1/auth/web/preferences'), 200, 'preferences read');
	const preferenceTag = preferences.headers.get('etag') ?? '0';
	const updatedPreferences = expectStatus(await client.request('PATCH', '/v1/auth/web/preferences', {
		colorScheme: 'fern', themeMode: 'dark', timeZone: 'America/New_York', realTimeUpdates: true,
	}, { 'if-match': preferenceTag }), 200, 'preferences update');
	if ((updatedPreferences.data as { themeMode?: string }).themeMode !== 'dark') throw new Error(`Appearance preference was not persisted: ${JSON.stringify(updatedPreferences.data)}`);
	const additional = await authorize(http, { identifier: account.email, password: account.password, adminOrigin });
	if (!additional) throw new Error('Additional session authorization unexpectedly denied.');
	const sessions = expectStatus(await client.request('GET', '/v1/auth/web/sessions'), 200, 'session list');
	const revocable = ((sessions.data as { items?: Array<{ id: string; current?: boolean }> }).items ?? []).find((entry) => !entry.current);
	if (!revocable) throw new Error('Session list omitted the additional revocable session.');
	expectStatus(await client.confirmed('POST', `/v1/auth/web/sessions/${revocable.id}/revoke`, {}), 200, 'session revocation');
	expectStatus(await http.request('POST', '/oauth/token', { grant_type: 'refresh_token', client_id: 'treeseed-admin', refresh_token: additional.refreshToken }), 400, 'revoked session refresh');
	expectStatus(await client.request('GET', '/v1/auth/web/notifications'), 200, 'notification list');
	expectStatus(await client.request('GET', '/v1/auth/web/account/deletion-blockers'), 200, 'account deletion blockers');
	expectStatus(await http.request('POST', '/v1/auth/web/password-reset/request', { email: account.email }), 200, 'password reset request');
	const reset = await mailpitToken(mailpitOrigin, account.email, 'Reset your TreeSeed password', 'token');
	const nextPassword = `${account.password}-reset`;
	expectStatus(await http.request('POST', '/v1/auth/web/password-reset/complete', { token: reset, password: nextPassword }), 200, 'password reset completion');
	expectStatus(await http.request('POST', '/v1/auth/web/password-reset/complete', { token: reset, password: nextPassword }), 401, 'password reset replay');
	account.password = nextPassword;
	const refreshed = expectStatus(await http.request('POST', '/oauth/token', { grant_type: 'refresh_token', client_id: 'treeseed-admin', refresh_token: account.refreshToken }), 200, 'refresh rotation').body as { access_token?: string; refresh_token?: string };
	if (!refreshed.access_token || !refreshed.refresh_token) throw new Error('Refresh rotation omitted credentials.');
	expectStatus(await http.request('POST', '/oauth/token', { grant_type: 'refresh_token', client_id: 'treeseed-admin', refresh_token: account.refreshToken }), 400, 'refresh replay');
	account.accessToken = refreshed.access_token;
	account.refreshToken = refreshed.refresh_token;
}

export async function deleteVerifiedAccount(http: VerifierHttp, account: VerifiedAccount) {
	const client = http.withToken(account.accessToken);
	const identity = expectStatus(await client.request('GET', '/v1/auth/web/account/identity'), 200, 'cleanup account identity');
	const revision = identity.headers.get('etag') ?? String((identity.data as { updatedAt?: string }).updatedAt ?? '0');
	expectStatus(await client.confirmed('DELETE', '/v1/auth/web/account', {
		confirmation: 'DELETE MY ACCOUNT', currentPassword: account.password,
	}, { 'if-match': revision }), 200, 'account cleanup');
	expectStatus(await client.request('GET', '/v1/me'), 401, 'deleted account session');
}
