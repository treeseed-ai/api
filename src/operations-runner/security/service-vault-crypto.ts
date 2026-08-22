import sodiumModule from 'libsodium-wrappers-sumo';

type Sodium = { ready: Promise<void>; base64_variants: { ORIGINAL: number }; crypto_box_keypair(): { publicKey: Uint8Array; privateKey: Uint8Array }; crypto_box_seal_open(ciphertext: Uint8Array, publicKey: Uint8Array, privateKey: Uint8Array): Uint8Array; from_base64(value: string, variant: number): Uint8Array; to_base64(value: Uint8Array, variant: number): string; memzero(value: Uint8Array): void };
let sodiumPromise: Promise<Sodium> | undefined;
async function sodium() { sodiumPromise ??= Promise.resolve().then(async () => { const loaded = sodiumModule as Sodium; await loaded.ready; return loaded; }); return sodiumPromise; }

export async function createServiceVaultUserKeyPair() { const crypto = await sodium(); const pair = crypto.crypto_box_keypair(); return { publicKey: crypto.to_base64(pair.publicKey, crypto.base64_variants.ORIGINAL), privateKey: pair.privateKey }; }
export async function openSecretOperationPayload(sealedPayload: string, operationPublicKey: string, operationPrivateKey: Uint8Array): Promise<Record<string, string>> {
	const crypto = await sodium(); try { const plaintext = crypto.crypto_box_seal_open(crypto.from_base64(sealedPayload, crypto.base64_variants.ORIGINAL), crypto.from_base64(operationPublicKey, crypto.base64_variants.ORIGINAL), operationPrivateKey); const parsed = JSON.parse(new TextDecoder().decode(plaintext)); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some((value) => typeof value !== 'string')) throw new Error(); return parsed as Record<string, string>; } catch { throw new Error('The operation payload cannot be opened by this runner lease.'); }
}
export function clearServiceVaultKey(value: Uint8Array | undefined) { if (value) void sodium().then((crypto) => crypto.memzero(value)); }
