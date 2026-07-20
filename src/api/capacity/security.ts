import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createHmac,
	createPublicKey,
	randomBytes,
	timingSafeEqual,
	verify,
} from 'node:crypto';
import {
	canonicalCapacityProviderJson,
	capacityProviderFingerprint,
	capacityProviderSha256,
	validateCapacityProviderProofPayload,
	validateCapacityProviderPublicJwk,
} from '@treeseed/sdk/capacity-provider';
import type {
	CapacityProviderProofPayload,
	CapacityProviderPublicJwk,
	CapacityProviderSignedProof,
} from '@treeseed/sdk/capacity-provider/contracts';
import { CapacityGovernanceError } from './database.ts';

export type CapacitySecretKind = 'registration' | 'credential' | 'access';

const SECRET_PREFIX: Record<CapacitySecretKind, string> = {
	registration: 'tsreg',
	credential: 'tspc',
	access: 'tspa',
};

export const canonicalJson = canonicalCapacityProviderJson;
export const sha256 = capacityProviderSha256;
export { capacityProviderFingerprint };

export class CapacitySecretCodec {
	readonly #hashKey: Buffer;
	readonly #encryptionKey: Buffer;

	constructor(secret: string) {
		if (secret.trim().length < 24) throw new Error('Capacity governance secret must be at least 24 characters.');
		this.#hashKey = createHash('sha256').update(`treeseed-capacity-hash:${secret}`).digest();
		this.#encryptionKey = createHash('sha256').update(`treeseed-capacity-encryption:${secret}`).digest();
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

	encrypt(plaintext: string) {
		const iv = randomBytes(12);
		const cipher = createCipheriv('aes-256-gcm', this.#encryptionKey, iv);
		const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
		return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
	}

	decrypt(envelope: string) {
		const [ivValue, tagValue, encryptedValue] = envelope.split('.');
		if (!ivValue || !tagValue || !encryptedValue) throw new CapacityGovernanceError('registration_key_reveal_invalid', 'Registration key reveal envelope is invalid.', 500);
		const decipher = createDecipheriv('aes-256-gcm', this.#encryptionKey, Buffer.from(ivValue, 'base64url'));
		decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
		return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64url')), decipher.final()]).toString('utf8');
	}
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
	const valid = verify(null, signingInput, createPublicKey({ key: input.publicJwk, format: 'jwk' }), Buffer.from(input.proof.signature, 'base64url'));
	if (!valid) throw new CapacityGovernanceError('provider_proof_signature_invalid', 'Provider proof signature is invalid.', 401);
	return { payload, fingerprint };
}
