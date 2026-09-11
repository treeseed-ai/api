import { createHash } from 'node:crypto';
import { sourceCandidateChunkBytes, type SourceCandidateAttestation, type SourceCandidateRequest } from '@treeseed/sdk/capacity-provider/sandbox';
import type { R2PublicationClient } from '../../../../providers/cloudflare/r2-publication-client.ts';
import { CapacityGovernanceError } from '../../../../capacity/database.ts';

export function candidateObjectPrefix(candidateId: string, attestation: SourceCandidateAttestation) {
  if (!/^source-candidate-[a-f0-9]{64}$/u.test(candidateId)) throw new Error('Invalid candidate storage identity.');
  return `teams/${encodeURIComponent(attestation.source.teamId)}/projects/${encodeURIComponent(attestation.source.projectId)}/source-candidates/v1/${candidateId}`;
}
const digest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export function candidateChunkKey(candidateId: string, attestation: SourceCandidateAttestation, index: number) {
  if (!Number.isInteger(index) || index < 0 || index >= attestation.bundle.chunks.length) throw new CapacityGovernanceError('source_candidate_chunk_invalid', 'Candidate chunk is outside its signed manifest.', 400);
  return `${candidateObjectPrefix(candidateId, attestation)}/chunks/${index}-${attestation.bundle.chunks[index]!.slice(7)}`;
}
export function assertCandidateChunk(attestation: SourceCandidateAttestation, index: number, bytes: Uint8Array) {
  const remaining = attestation.bundle.bytes - index * sourceCandidateChunkBytes;
  if (index < 0 || index >= attestation.bundle.chunks.length || bytes.byteLength !== Math.min(sourceCandidateChunkBytes, remaining)
    || digest(bytes) !== attestation.bundle.chunks[index]) throw new CapacityGovernanceError('source_candidate_chunk_mismatch', 'Candidate bytes do not match the signed manifest.', 409);
}
export function decodeCandidateChunk(request: Extract<SourceCandidateRequest, { action: 'chunk' }>) {
  const attestation = request.candidate.attestation, bytes = Buffer.from(request.content, 'base64');
  if (bytes.toString('base64') !== request.content) throw new CapacityGovernanceError('source_candidate_encoding_invalid', 'Candidate content must use canonical base64 encoding.', 400);
  assertCandidateChunk(attestation, request.index, bytes);
  return bytes;
}
export async function persistCandidateChunk(client: R2PublicationClient, candidateId: string, request: Extract<SourceCandidateRequest, { action: 'chunk' }>) {
  const attestation = request.candidate.attestation, bytes = decodeCandidateChunk(request);
  const key = candidateChunkKey(candidateId, attestation, request.index);
  await client.putBytes(key, bytes, { contentType: 'application/octet-stream', ifNoneMatch: '*' });
  const readback = await client.getBytes(key, sourceCandidateChunkBytes);
  if (!readback) throw new CapacityGovernanceError('source_candidate_readback_missing', 'Candidate storage read-back failed.', 503);
  assertCandidateChunk(attestation, request.index, readback.body);
  return { accepted: true as const, index: request.index, digest: attestation.bundle.chunks[request.index] };
}
/** Constant-memory full bundle validation; uploaded fragments alone never constitute an accepted candidate. */
export async function verifyStoredCandidate(client: R2PublicationClient, candidateId: string, attestation: SourceCandidateAttestation) {
  const hash = createHash('sha256'); let bytes = 0;
  for (let index = 0; index < attestation.bundle.chunks.length; index++) {
    const chunk = await client.getBytes(candidateChunkKey(candidateId, attestation, index), sourceCandidateChunkBytes);
    if (!chunk) throw new CapacityGovernanceError('source_candidate_incomplete', 'Candidate upload is incomplete; retain the source overlay and retry.', 409);
    assertCandidateChunk(attestation, index, chunk.body); hash.update(chunk.body); bytes += chunk.body.byteLength;
  }
  if (bytes !== attestation.bundle.bytes || `sha256:${hash.digest('hex')}` !== attestation.bundle.digest) throw new CapacityGovernanceError('source_candidate_bundle_mismatch', 'Stored candidate bundle failed its signed digest check.', 409);
}
