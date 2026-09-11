import { describe, expect, it } from 'vitest';
import { candidateFixture } from './fixture.ts';
import { sourceCandidateId, verifyCandidateSignature } from '../../../../../../src/api/control-plane/repositories/providers/source/candidate-authority.ts';
import { candidateChunkKey, persistCandidateChunk, verifyStoredCandidate } from '../../../../../../src/api/control-plane/repositories/providers/source/candidate-storage.ts';

describe('private durable candidate storage', () => {
  it('stores immutable team/project scoped chunks and independently reads back their exact bytes', async () => {
    const f = candidateFixture(), id = sourceCandidateId(f.candidate);
    expect(await persistCandidateChunk(f.client, id, f.request)).toMatchObject({ accepted: true, index: 0 });
    await persistCandidateChunk(f.client, id, f.request);
    await verifyStoredCandidate(f.client, id, f.candidate.attestation);
    expect([...f.chunks.keys()]).toEqual([candidateChunkKey(id, f.candidate.attestation, 0)]);
    expect([...f.chunks.keys()][0]).toMatch(/^teams\/team\/projects\/project\/source-candidates\/v1\//u);
    expect(() => candidateChunkKey('../other-team', f.candidate.attestation, 0)).toThrow();
  });
  it('rejects missing, corrupted, oversized, wrong-index and noncanonical chunks', async () => {
    const f = candidateFixture(), id = sourceCandidateId(f.candidate);
    await expect(verifyStoredCandidate(f.client, id, f.candidate.attestation)).rejects.toThrow('incomplete');
    await expect(persistCandidateChunk(f.client, id, { ...f.request, index: 1 })).rejects.toThrow();
    await expect(persistCandidateChunk(f.client, id, { ...f.request, content: Buffer.from('different').toString('base64') })).rejects.toThrow('signed manifest');
    await expect(persistCandidateChunk(f.client, id, { ...f.request, content: `${f.request.content}\n` })).rejects.toThrow('canonical');
    await persistCandidateChunk(f.client, id, f.request);
    f.chunks.set(candidateChunkKey(id, f.candidate.attestation, 0), Buffer.from('corrupted'));
    await expect(verifyStoredCandidate(f.client, id, f.candidate.attestation)).rejects.toThrow('signed manifest');
  });
  it('rejects forged host evidence and post-signature scope changes', () => {
    const f = candidateFixture();
    expect(() => verifyCandidateSignature(f.candidate, f.publicJwk)).not.toThrow();
    expect(() => verifyCandidateSignature(f.candidate, candidateFixture().publicJwk)).toThrow('registered provider');
    f.candidate.attestation.source.teamId = 'other';
    expect(() => verifyCandidateSignature(f.candidate, f.publicJwk)).toThrow('registered provider');
  });
});
