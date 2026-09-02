import { readFile } from 'node:fs/promises';
import type { HostedInfrastructureAuthorityRequest } from '@treeseed/deployment/infrastructure/opentofu';

type Store = { first(query: string, params?: unknown[]): Promise<any> };
type ResolverInput = { authority: Record<string, unknown>; request: HostedInfrastructureAuthorityRequest };

const vaultReference = /^openbao:\/\/([0-9a-f-]{36})\/(teams\/[^?#]+)$/u;
const segment = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function object(value: unknown) {
	if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
	try { const parsed = JSON.parse(String(value ?? '')); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; }
}

function required(value: unknown, name: string) {
	const result = String(value ?? '').trim(); if (!result) throw new Error(`OpenBao ${name} is required.`); return result;
}

function safeAddress(value: unknown, env: NodeJS.ProcessEnv) {
	const address = new URL(required(value, 'address'));
	const local = ['127.0.0.1', 'localhost'].includes(address.hostname) && env.NODE_ENV === 'test';
	if (address.protocol !== 'https:' && !(local && address.protocol === 'http:')) throw new Error('OpenBao address must use HTTPS.');
	return address.href.replace(/\/$/u, '');
}

function pathFor(input: ResolverInput) {
	if (input.request.purpose === 'state-encryption') {
		const secretRef = required(input.request.secretRef, 'state encryption reference');
		if (!segment.test(secretRef)) throw new Error('OpenBao state encryption reference is invalid.');
		return { connectionId: null, path: `teams/${input.request.teamId}/state-encryption/${secretRef}` };
	}
	const match = required(input.authority.reference, 'authority reference').match(vaultReference);
	if (!match) throw new Error('OpenBao authority reference must identify a team vault connection and canonical team path.');
	return { connectionId: match[1]!, path: match[2]! };
}

async function login(input: { address: string; config: Record<string, unknown>; env: NodeJS.ProcessEnv; fetchImpl: typeof fetch }) {
	const jwtFile = input.env.TREESEED_OPENBAO_WORKLOAD_JWT_FILE;
	const appRoleId = input.env.TREESEED_OPENBAO_ROLE_ID, appRoleSecret = input.env.TREESEED_OPENBAO_SECRET_ID;
	let mount: string, body: Record<string, string>;
	if (jwtFile) {
		mount = String(input.config.authMount ?? 'jwt');
		body = { role: required(input.config.role, 'workload role'), jwt: (await readFile(jwtFile, 'utf8')).trim() };
	} else if (appRoleId && appRoleSecret) {
		mount = String(input.env.TREESEED_OPENBAO_APPROLE_AUTH_MOUNT ?? 'approle'); body = { role_id: appRoleId, secret_id: appRoleSecret };
	} else throw new Error('OpenBao workload JWT or AppRole bootstrap identity is required.');
	if (!segment.test(mount)) throw new Error('OpenBao auth mount is invalid.');
	const response = await input.fetchImpl(`${input.address}/v1/auth/${encodeURIComponent(mount)}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
	if (!response.ok) throw new Error(`OpenBao workload authentication failed (HTTP ${response.status}).`);
	const payload: any = await response.json(), token = String(payload?.auth?.client_token ?? ''), lease = Number(payload?.auth?.lease_duration ?? 0);
	if (!token || !Number.isFinite(lease) || lease < 60) throw new Error('OpenBao returned an invalid workload lease.');
	return { token, expiresAt: new Date(Date.now() + Math.min(lease, 3600) * 1_000).toISOString() };
}

export function createOpenBaoHostedAuthorityResolver(options: { store: Store; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }) {
	const env = options.env ?? process.env, fetchImpl = options.fetchImpl ?? fetch;
	return async (input: ResolverInput) => {
		const selected = pathFor(input), expectedPrefix = `teams/${input.request.teamId}/`;
		if (!selected.path.startsWith(expectedPrefix) || selected.path.split('/').some((value) => !segment.test(value))) throw new Error('OpenBao authority reference escapes its team namespace.');
		let connectionId = selected.connectionId;
		if (!connectionId) {
			const reference = required(input.authority.reference, 'authority reference').match(vaultReference);
			connectionId = reference?.[1] ?? null;
		}
		if (!connectionId) throw new Error('OpenBao state encryption authority has no vault connection.');
		const connection = await options.store.first(`SELECT c.* FROM team_service_connections c
			JOIN team_service_capability_bindings b ON b.connection_id = c.id AND b.team_id = c.team_id
				AND b.capability_type = 'secret-enclave' AND b.status = 'configured'
			WHERE c.id = ? AND c.team_id = ? AND c.provider_id = 'openbao' AND c.status = 'active'`, [connectionId, input.request.teamId]);
		if (!connection) throw new Error('Active team-scoped OpenBao service connection is required.');
		const config = object(connection.non_secret_config_json), address = safeAddress(config.address, env), mount = required(config.mount, 'KV mount');
		if (!segment.test(mount)) throw new Error('OpenBao KV mount is invalid.');
		const session = await login({ address, config, env, fetchImpl });
		const response = await fetchImpl(`${address}/v1/${encodeURIComponent(mount)}/data/${selected.path.split('/').map(encodeURIComponent).join('/')}`, { headers: { 'x-vault-token': session.token } });
		if (!response.ok) throw new Error(`OpenBao secret resolution failed (HTTP ${response.status}).`);
		const values = object((await response.json() as any)?.data?.data), strings = Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
		if (Object.keys(strings).length !== Object.keys(values).length || !Object.keys(strings).length) throw new Error('OpenBao secret material is empty or contains unsupported values.');
		return { values: strings, expiresAt: session.expiresAt };
	};
}
