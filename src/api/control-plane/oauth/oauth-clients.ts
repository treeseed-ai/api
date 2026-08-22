import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { isFirstPartyOAuthClient } from './oauth-metadata.ts';

export interface OAuthClientMetadata {
	clientId: string;
	redirectUris: string[];
	grantTypes: string[];
	responseTypes: string[];
	tokenEndpointAuthMethod: 'none';
	firstParty: boolean;
}

function privateAddress(address: string) {
	return address === '::1' || address.startsWith('fe80:') || address.startsWith('fc') || address.startsWith('fd')
		|| /^127\./u.test(address) || /^10\./u.test(address) || /^192\.168\./u.test(address)
		|| /^172\.(?:1[6-9]|2\d|3[01])\./u.test(address) || /^169\.254\./u.test(address);
}

function validHttpsRedirect(value: string) {
	try {
		const url = new URL(value);
		return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
	} catch {
		return false;
	}
}

function fetchPinnedMetadata(url: URL, address: string, family: number): Promise<{ ok: boolean; headers: Headers; text(): Promise<string> }> {
	return new Promise((resolve, reject) => {
		const requestHandle = request(url, {
			method: 'GET', headers: { accept: 'application/json' },
			lookup: ((_hostname: string, _options: unknown, callback: (error: Error | null, address?: string, family?: number) => void) => {
				callback(null, address, family);
			}) as never,
		}, (response) => {
			const chunks: Buffer[] = [];
			let size = 0;
			response.on('data', (chunk: Buffer) => {
				size += chunk.length;
				if (size > 65_536) requestHandle.destroy(new Error('OAuth client metadata exceeds 64 KiB.'));
				else chunks.push(chunk);
			});
			response.on('end', () => resolve({
				ok: Boolean(response.statusCode && response.statusCode >= 200 && response.statusCode < 300),
				headers: new Headers(Object.entries(response.headers).flatMap(([key, value]) => value === undefined ? [] : [[key, Array.isArray(value) ? value.join(', ') : value]])),
				async text() { return Buffer.concat(chunks).toString('utf8'); },
			}));
		});
		requestHandle.setTimeout(5_000, () => requestHandle.destroy(new Error('OAuth client metadata request timed out.')));
		requestHandle.on('error', reject);
		requestHandle.end();
	});
}

export async function resolveOAuthClient(
	clientId: string,
	dependencies: {
		fetch?: typeof fetch;
		lookup?: typeof lookup;
	} = {},
): Promise<OAuthClientMetadata> {
	if (isFirstPartyOAuthClient(clientId)) return {
		clientId, redirectUris: [], grantTypes: ['authorization_code', 'urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
		responseTypes: ['code'], tokenEndpointAuthMethod: 'none', firstParty: true,
	};
	let documentUrl: URL;
	try {
		documentUrl = new URL(clientId);
	} catch {
		throw new Error('OAuth client_id must be registered or an HTTPS metadata document URL.');
	}
	if (documentUrl.protocol !== 'https:' || documentUrl.username || documentUrl.password || documentUrl.hash || documentUrl.port) {
		throw new Error('OAuth Client ID Metadata Document URLs must use canonical HTTPS without credentials, fragments, or custom ports.');
	}
	const resolveHost = dependencies.lookup ?? lookup;
	const addresses = await resolveHost(documentUrl.hostname, { all: true, verbatim: true });
	if (addresses.length === 0 || addresses.some(({ address }) => !isIP(address) || privateAddress(address))) {
		throw new Error('OAuth client metadata must resolve only to public addresses.');
	}
	const chosen = addresses[0];
	const response = dependencies.fetch
		? await dependencies.fetch(documentUrl, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(5_000) })
		: await fetchPinnedMetadata(documentUrl, chosen.address, chosen.family);
	if (!response.ok || !response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
		throw new Error('OAuth client metadata response must be successful JSON.');
	}
	const declaredLength = Number(response.headers.get('content-length') ?? 0);
	if (declaredLength > 65_536) throw new Error('OAuth client metadata exceeds 64 KiB.');
	const body = await response.text();
	if (Buffer.byteLength(body) > 65_536) throw new Error('OAuth client metadata exceeds 64 KiB.');
	const metadata = JSON.parse(body) as Record<string, unknown>;
	const redirectUris = Array.isArray(metadata.redirect_uris) ? metadata.redirect_uris.map(String) : [];
	const grantTypes = Array.isArray(metadata.grant_types) ? metadata.grant_types.map(String) : [];
	const responseTypes = Array.isArray(metadata.response_types) ? metadata.response_types.map(String) : [];
	if (metadata.client_id !== clientId || redirectUris.length === 0 || !redirectUris.every(validHttpsRedirect)
		|| !grantTypes.includes('authorization_code') || !responseTypes.includes('code') || metadata.token_endpoint_auth_method !== 'none') {
		throw new Error('OAuth client metadata is incomplete or inconsistent with the requested client.');
	}
	return { clientId, redirectUris, grantTypes, responseTypes, tokenEndpointAuthMethod: 'none', firstParty: false };
}

export function clientAllowsRedirect(client: OAuthClientMetadata, value: string) {
	if (client.firstParty) {
		try {
			const url = new URL(value);
			return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname) && !url.username && !url.password && !url.hash;
		} catch {
			return false;
		}
	}
	return client.redirectUris.includes(value);
}
