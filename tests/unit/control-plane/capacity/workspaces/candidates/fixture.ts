import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { sourceCandidateAttestationSchema, type SignedSourceCandidate } from '@treeseed/sdk/capacity-provider/sandbox';
import { canonicalJson } from '../../../../../../src/api/capacity/security.ts';
import type { R2PublicationClient } from '../../../../../../src/api/providers/cloudflare/r2-publication-client.ts';

export const digest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export function candidateFixture() {
  const bytes = Buffer.from('synthetic source bundle'), { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicJwk = publicKey.export({ format: 'jwk' });
  const attestation = sourceCandidateAttestationSchema.parse({ schemaVersion: 'treeseed.source-candidate-attestation/v1', providerId: 'provider', assignmentId: 'assignment', attempt: 1,
    leaseId: 'lease', source: { controlPlaneId: 'control', teamId: 'team', projectId: 'project', repositoryId: 'repo', commit: 'a'.repeat(40), formatVersion: 1, profile: 'source-only' },
    commit: 'b'.repeat(40), parentCandidateId: null, bundle: { digest: digest(bytes), bytes: bytes.length, chunks: [digest(bytes)] },
    verification: { clean: true, objectClosure: true, ancestry: true, isolatedVerifier: true, executionStopped: true, verifierStopped: true }, verifiedAt: '2026-09-10T00:00:00.000Z' });
  const candidate: SignedSourceCandidate = { attestation, signature: { keyId: `provider-${createHash('sha256').update(publicJwk.x!).digest('hex').slice(0, 16)}`,
    algorithm: 'Ed25519', value: sign(null, Buffer.from(canonicalJson(attestation)), privateKey).toString('base64url') } };
  const chunks = new Map<string, Uint8Array>(), texts = new Map<string, string>();
  const client = {
    async putBytes(key: string, body: Uint8Array) { const old = chunks.get(key); if (old && digest(old) !== digest(body)) throw new Error('conditional conflict'); chunks.set(key, body); return { sha256: digest(body), byteLength: body.length }; },
    async getBytes(key: string) { const body = chunks.get(key); return body ? { body, etag: 'etag', sha256: digest(body) } : null; },
    async put(key: string, body: string) { const old = texts.get(key); if (old && old !== body) throw new Error('conditional conflict'); texts.set(key, body); },
    async get(key: string) { const body = texts.get(key); return body ? { body, etag: 'etag' } : null; },
  } as R2PublicationClient;
  return { candidate, publicJwk, bytes, chunks, texts, client,
    request: { action: 'chunk' as const, runnerId: 'runner', leaseToken: 'test-lease', candidate, index: 0, content: bytes.toString('base64') } };
}
