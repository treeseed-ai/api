import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ConfirmationState, InputRequired } from '@treeseed/sdk/operator-contracts';

interface ConfirmationClaims {
	schemaVersion: 'treeseed.confirmation-state/v1';
	principalId: string;
	clientId: string;
	operationId: string;
	argumentsDigest: `sha256:${string}`;
	expiresAt: string;
	nonce: string;
}

export interface ConfirmationNonceStore {
	consume(nonce: string, claims: ConfirmationClaims): Promise<boolean>;
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
		.sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
	return JSON.stringify(value) ?? 'null';
}

function digest(value: unknown): `sha256:${string}` {
	return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

function signature(claims: ConfirmationClaims, secret: string) {
	return createHmac('sha256', secret).update(canonical(claims)).digest('base64url');
}

function equal(left: string, right: string) {
	const leftBuffer = Buffer.from(left); const rightBuffer = Buffer.from(right);
	return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export class ConfirmationService {
	constructor(private readonly secret: string, private readonly nonces: ConfirmationNonceStore, private readonly ttlMs = 5 * 60_000) {
		if (secret.length < 16) throw new Error('Confirmation signing requires at least 16 characters of secret material.');
	}

	request(input: { principalId: string; clientId: string; operationId: string; arguments: unknown; requestId: string }): InputRequired {
		const claims: ConfirmationClaims = { schemaVersion: 'treeseed.confirmation-state/v1', principalId: input.principalId,
			clientId: input.clientId, operationId: input.operationId, argumentsDigest: digest(input.arguments),
			expiresAt: new Date(Date.now() + this.ttlMs).toISOString(), nonce: randomBytes(24).toString('base64url') };
		return { type: 'input_required', requestId: input.requestId,
			prompt: `Confirm ${input.operationId} with the exact arguments shown by the client.`,
			confirmation: { ...claims, signature: signature(claims, this.secret) } };
	}

	async verify(state: ConfirmationState, input: { principalId: string; clientId: string; operationId: string; arguments: unknown }) {
		const { signature: supplied, ...claims } = state;
		if (claims.schemaVersion !== 'treeseed.confirmation-state/v1' || !equal(supplied, signature(claims, this.secret))) return false;
		if (claims.principalId !== input.principalId || claims.clientId !== input.clientId || claims.operationId !== input.operationId) return false;
		if (claims.argumentsDigest !== digest(input.arguments) || new Date(claims.expiresAt).getTime() <= Date.now()) return false;
		return this.nonces.consume(claims.nonce, claims);
	}
}

export function encodeConfirmation(state: ConfirmationState) {
	return Buffer.from(JSON.stringify(state)).toString('base64url');
}

export function decodeConfirmation(value: string | undefined): ConfirmationState | null {
	if (!value) return null;
	try { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as ConfirmationState; } catch { return null; }
}
