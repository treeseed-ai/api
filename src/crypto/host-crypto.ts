const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

type Sodium = {
	ready: Promise<void>;
	base64_variants: { ORIGINAL: number };
	crypto_pwhash_ALG_ARGON2ID13: number;
	crypto_pwhash_MEMLIMIT_INTERACTIVE: number;
	crypto_pwhash_OPSLIMIT_INTERACTIVE: number;
	crypto_pwhash_SALTBYTES: number;
	crypto_secretbox_KEYBYTES: number;
	crypto_secretbox_NONCEBYTES: number;
	crypto_pwhash: (keyLength: number, passphrase: Uint8Array, salt: Uint8Array, opsLimit: number, memLimit: number, algorithm: number) => Uint8Array;
	crypto_secretbox_easy: (message: Uint8Array, nonce: Uint8Array, key: Uint8Array) => Uint8Array;
	crypto_secretbox_open_easy: (ciphertext: Uint8Array, nonce: Uint8Array, key: Uint8Array) => Uint8Array | false;
	from_base64: (value: string, variant: number) => Uint8Array;
	randombytes_buf: (length: number) => Uint8Array;
	to_base64: (bytes: Uint8Array, variant: number) => string;
};

export type HostEncryptedPayload = {
	version: 1;
	algorithm: 'secretbox';
	kdf: {
		algorithm: 'argon2id';
		opsLimit: number;
		memLimit: number;
	};
	salt: string;
	nonce: string;
	ciphertext: string;
};

type TestHostEncryptedPayload = {
	algorithm: 'test-json';
	ciphertext: string;
	passphrase?: string;
	testPassphrase?: string;
};

export type HostCredentialConfig = Record<string, unknown>;

export type HostCryptoOptions = {
	opsLimit?: number;
	memLimit?: number;
};

async function loadSodium(): Promise<Sodium> {
	let imported: unknown;
	try {
		imported = await import('libsodium-wrappers-sumo');
	} catch (error) {
		if (typeof process === 'undefined' || !process.versions?.node) throw error;
		const nodeModuleSpecifier = 'node:module';
		const { createRequire } = await import(/* @vite-ignore */ nodeModuleSpecifier);
		const require = createRequire(import.meta.url);
		imported = require('libsodium-wrappers-sumo');
	}
	const sodium = ((imported as { default?: Sodium }).default ?? imported) as Sodium;
	await sodium.ready;
	if (typeof sodium.randombytes_buf !== 'function') {
		throw new Error('Host encryption could not load browser crypto support.');
	}
	return sodium;
}

function toBase64(sodium: Sodium, bytes: Uint8Array): string {
	return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
}

function fromBase64(sodium: Sodium, value: string): Uint8Array {
	return sodium.from_base64(value, sodium.base64_variants.ORIGINAL);
}

function deriveKey(sodium: Sodium, passphrase: string, salt: Uint8Array, opsLimit: number, memLimit: number): Uint8Array {
	return sodium.crypto_pwhash(
		sodium.crypto_secretbox_KEYBYTES,
		TEXT_ENCODER.encode(passphrase.normalize('NFKC')),
		salt,
		opsLimit,
		memLimit,
		sodium.crypto_pwhash_ALG_ARGON2ID13,
	);
}

export async function encryptHostConfig(config: HostCredentialConfig, passphrase: string, options: HostCryptoOptions = {}): Promise<HostEncryptedPayload> {
	if (!passphrase || typeof passphrase !== 'string') {
		throw new Error('A passphrase is required to encrypt a host.');
	}
	const sodium = await loadSodium();
	const opsLimit = Number(options.opsLimit ?? sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE);
	const memLimit = Number(options.memLimit ?? sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE);
	const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
	const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
	const key = deriveKey(sodium, passphrase, salt, opsLimit, memLimit);
	const message = TEXT_ENCODER.encode(JSON.stringify(config ?? {}));
	const ciphertext = sodium.crypto_secretbox_easy(message, nonce, key);
	return {
		version: 1,
		algorithm: 'secretbox',
		kdf: {
			algorithm: 'argon2id',
			opsLimit,
			memLimit,
		},
		salt: toBase64(sodium, salt),
		nonce: toBase64(sodium, nonce),
		ciphertext: toBase64(sodium, ciphertext),
	};
}

export async function decryptHostConfig(envelope: HostEncryptedPayload | TestHostEncryptedPayload | null | undefined, passphrase: string): Promise<HostCredentialConfig> {
	if (!passphrase || typeof passphrase !== 'string') {
		throw new Error('A passphrase is required to decrypt a host.');
	}
	if (!envelope || typeof envelope !== 'object') {
		throw new Error('A valid encrypted host envelope is required.');
	}
	if (
		envelope.algorithm === 'test-json'
		&& (typeof process !== 'undefined')
		&& (process.env.NODE_ENV === 'test' || process.env.TREESEED_LOCAL_DEV_MODE)
	) {
		const expected = envelope.passphrase ?? envelope.testPassphrase ?? passphrase;
		if (expected !== passphrase) {
			throw new Error('Unable to decrypt host config. Check the passphrase.');
		}
		return JSON.parse(TEXT_DECODER.decode(Uint8Array.from(atob(envelope.ciphertext), (char) => char.charCodeAt(0)))) as HostCredentialConfig;
	}
	const sodium = await loadSodium();
	const secretboxEnvelope = envelope as HostEncryptedPayload;
	const salt = fromBase64(sodium, secretboxEnvelope.salt);
	const nonce = fromBase64(sodium, secretboxEnvelope.nonce);
	const ciphertext = fromBase64(sodium, secretboxEnvelope.ciphertext);
	const key = deriveKey(
		sodium,
		passphrase,
		salt,
		Number(secretboxEnvelope.kdf?.opsLimit ?? sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE),
		Number(secretboxEnvelope.kdf?.memLimit ?? sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE),
	);
	const plaintext = sodium.crypto_secretbox_open_easy(ciphertext, nonce, key);
	if (!plaintext) {
		throw new Error('Unable to decrypt host config. Check the passphrase.');
	}
	return JSON.parse(TEXT_DECODER.decode(plaintext)) as HostCredentialConfig;
}
