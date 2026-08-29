import { validateCapacityProviderProofPayload, validateCapacityProviderPublicJwk } from '@treeseed/sdk/capacity-provider';
import type {
CapacityProviderProofPayload,
CapacityProviderPublicJwk,
CapacityProviderSignedProof,
} from '@treeseed/sdk/capacity-provider/contracts';
import {
createHash,
createHmac,
createPublicKey,
randomBytes,
timingSafeEqual,
verify,
} from 'node:crypto';
import { EncryptedEnvelopeCodec, StaticEnvelopeKeyProvider, encryptedEnvelopeSchema } from '@treeseed/sdk/security';
import { CapacityGovernanceError } from './database.ts';

export type CapacitySecretKind = 'registration' | 'credential' | 'access';

const SECRET_PREFIX: Record<CapacitySecretKind, string> = {
	registration: 'tsreg',
	credential: 'tspc',
	access: 'tspa',
};

export const canonicalJson = canonicalCapacityProviderJson;
export const sha256 = capacityProviderSha256;

function canonicalValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalValue);
	if (!value || typeof value !== 'object') return value;
	return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonicalValue(entry)]));
}

export function canonicalCapacityProviderJson(value: unknown) { return JSON.stringify(canonicalValue(value)); }
export function capacityProviderSha256(value: string | Uint8Array) { return createHash('sha256').update(value).digest('base64url'); }
export function capacityProviderFingerprint(publicJwk: CapacityProviderPublicJwk) { return `sha256:${capacityProviderSha256(canonicalCapacityProviderJson({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x }))}`; }

export class CapacitySecretCodec {
	readonly #hashKey: Buffer;
	readonly #envelopes: EncryptedEnvelopeCodec;

	constructor(secret: string, encryptionSecret = 'treeseed-test-only-capacity-encryption-key', keyVersion = 1, historical: Array<{ version: number; secret: string }> = []) {
		if (secret.trim().length < 24) throw new Error('Capacity governance secret must be at least 24 characters.');
		if (encryptionSecret.trim().length < 24) throw new Error('Capacity encryption key must be at least 24 characters.');
		this.#hashKey = createHash('sha256').update(`treeseed-capacity-hash:${secret}`).digest();
		const key = createHash('sha256').update(encryptionSecret).digest();
		this.#envelopes = new EncryptedEnvelopeCodec(new StaticEnvelopeKeyProvider('systemd-credential', { id: 'capacity-governance', version: keyVersion, key }, historical.map((entry) => ({ id: 'capacity-governance', version: entry.version, key: createHash('sha256').update(entry.secret).digest() }))));
	}

	issue(kind: CapacitySecretKind) {
		const prefix = randomBytes(8).toString('hex');
		const secret = randomBytes(32).toString('base64url');
		const plaintext = `${SECRET_PREFIX[kind]}_${prefix}_${secret}`;
		return { plaintext, prefix: `${SECRET_PREFIX[kind]}_${prefix}`, hash: this.hash(plaintext) };
	}

	derive(kind: CapacitySecretKind, issuanceId: string) {
		if (!issuanceId.trim()) throw new Error('Capacity secret issuance identity is required.');
		const prefix = createHmac('sha256', this.#hashKey)
			.update(`prefix:${kind}:${issuanceId}`)
			.digest('hex')
			.slice(0, 16);
		const secret = createHmac('sha256', this.#hashKey)
			.update(`secret:${kind}:${issuanceId}`)
			.digest('base64url');
		const plaintext = `${SECRET_PREFIX[kind]}_${prefix}_${secret}`;
		return { plaintext, prefix: `${SECRET_PREFIX[kind]}_${prefix}`, hash: this.hash(plaintext) };
	}

	hash(plaintext: string) {
		return createHmac('sha256', this.#hashKey).update(plaintext).digest('base64url');
	}

	verify(plaintext: string, expectedHash: string) {
		const actual = Buffer.from(this.hash(plaintext));
		const expected = Buffer.from(expectedHash);
		return actual.length === expected.length && timingSafeEqual(actual, expected);
	}

	encrypt(plaintext: string, resourceId = 'capacity-registration-reveal') {
		return JSON.stringify(this.#envelopes.encrypt(plaintext, { purpose: 'capacity-secret', resourceType: 'registration-reveal', resourceId, schemaVersion: 'treeseed.encrypted-envelope/v1' }));
	}

	decrypt(envelope: string, expectedResourceId?: string) {
		try {
			const parsed = encryptedEnvelopeSchema.parse(JSON.parse(envelope));
			if (expectedResourceId && parsed.aad.resourceId !== expectedResourceId) throw new Error('Capacity secret envelope resource binding mismatch.');
			return this.#envelopes.decrypt(parsed).toString('utf8');
		} catch {
			throw new CapacityGovernanceError('registration_key_reveal_invalid', 'Registration key reveal envelope cannot be authenticated by the active secret generation.', 500);
		}
	}

	rewrap(envelope: string) { return JSON.stringify(this.#envelopes.rewrap(encryptedEnvelopeSchema.parse(JSON.parse(envelope)))); }
}

export interface VerifiedProviderProof {
	payload: CapacityProviderProofPayload;
	fingerprint: string;
}

export function verifyCapacityProviderProof(input: {
	proof: CapacityProviderSignedProof;
	publicJwk: CapacityProviderPublicJwk;
	method: string;
	path: string;
	audience: string;
	body: unknown;
	now?: Date;
}): VerifiedProviderProof {
	const keyValidation = validateCapacityProviderPublicJwk(input.publicJwk);
	if (!keyValidation.ok) throw new CapacityGovernanceError('provider_identity_invalid', 'Provider Ed25519 public identity is invalid.', 400, { diagnostics: keyValidation.diagnostics });
	let header: Record<string, unknown>;
	let payload: CapacityProviderProofPayload;
	try {
		header = JSON.parse(Buffer.from(input.proof.protected, 'base64url').toString('utf8')) as Record<string, unknown>;
		payload = JSON.parse(Buffer.from(input.proof.payload, 'base64url').toString('utf8')) as CapacityProviderProofPayload;
	} catch {
		throw new CapacityGovernanceError('provider_proof_invalid', 'Provider proof is not valid JWS JSON.', 401);
	}
	if (header.alg !== 'EdDSA') throw new CapacityGovernanceError('provider_proof_algorithm_invalid', 'Provider proof must use EdDSA.', 401);
	const fingerprint = capacityProviderFingerprint(input.publicJwk);
	if (payload.providerFingerprint !== fingerprint) throw new CapacityGovernanceError('provider_proof_fingerprint_mismatch', 'Provider proof fingerprint does not match its public identity.', 401);
	if (payload.bodySha256 !== sha256(canonicalJson(input.body))) throw new CapacityGovernanceError('provider_proof_body_mismatch', 'Provider proof body digest does not match the request.', 401);
	const validation = validateCapacityProviderProofPayload(payload, {
		now: input.now,
		expectedMethod: input.method,
		expectedPath: input.path,
		expectedAudience: input.audience,
	});
	if (!validation.ok) throw new CapacityGovernanceError('provider_proof_invalid', 'Provider proof claims are invalid.', 401, { diagnostics: validation.diagnostics });
	const signingInput = Buffer.from(`${input.proof.protected}.${input.proof.payload}`);
	const publicKeyInput = { key: input.publicJwk, format: 'jwk' } as unknown as Parameters<typeof createPublicKey>[0];
	const valid = verify(null, signingInput, createPublicKey(publicKeyInput), Buffer.from(input.proof.signature, 'base64url'));
	if (!valid) throw new CapacityGovernanceError('provider_proof_signature_invalid', 'Provider proof signature is invalid.', 401);
	return { payload, fingerprint };
}
