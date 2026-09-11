import { sourceCandidateRequestSchema, sourceCandidateReceiptSchema, type SourceCandidateReceipt } from '@treeseed/sdk/capacity-provider/sandbox';
import type { R2PublicationClient } from '../../../../providers/cloudflare/r2-publication-client.ts';
import { CapacityGovernanceError, type CapacityGovernanceDatabase } from '../../../../capacity/database.ts';
import { canonicalJson } from '../../../../capacity/security.ts';
import { providerPrincipal } from '../provider-runtime-service.ts';
import { authorizeSourceCandidate, sourceCandidateId } from './candidate-authority.ts';
import { candidateObjectPrefix, decodeCandidateChunk, persistCandidateChunk, verifyStoredCandidate } from './candidate-storage.ts';

function parsed(value: unknown): unknown { return typeof value === 'string' ? JSON.parse(value) : value; }
export function createSourceCandidateService(database: CapacityGovernanceDatabase, contentStore: unknown, options: {
  controlPlaneId: string; withStorage<T>(run: (client: R2PublicationClient) => Promise<T>): Promise<T>; now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());
  return async (auth: unknown, assignmentId: string, value: unknown) => {
    const actor = providerPrincipal(auth, ['provider:assignments:write']);
    const validation = sourceCandidateRequestSchema.safeParse(value);
    if (!validation.success) throw new CapacityGovernanceError('source_candidate_request_invalid', 'Candidate requires bounded content and signed independent-verifier evidence.', 400);
    const request = validation.data, candidate = request.candidate, attestation = candidate.attestation;
    if (request.action === 'chunk') decodeCandidateChunk(request);
    const check = () => authorizeSourceCandidate(database, contentStore, actor, assignmentId, request, options.controlPlaneId, now());
    await check();
    const id = sourceCandidateId(candidate), createdAt = now().toISOString();
    await database.run(`INSERT INTO provider_source_candidates(id,team_id,project_id,assignment_id,provider_id,attempt,state,attestation_json,signature_json,created_at)
      VALUES (?,?,?,?,?,?,'uploading',?::jsonb,?::jsonb,?) ON CONFLICT DO NOTHING`, [id, actor.teamId, attestation.source.projectId, assignmentId,
      actor.capacityProviderId, attestation.attempt, canonicalJson(attestation), canonicalJson(candidate.signature), createdAt]);
    const load = () => database.first('SELECT * FROM provider_source_candidates WHERE assignment_id=? AND attempt=? AND team_id=? AND provider_id=?',
      [assignmentId, attestation.attempt, actor.teamId, actor.capacityProviderId]);
    const current = await load();
    if (!current || current.id !== id || canonicalJson(parsed(current.attestation_json)) !== canonicalJson(attestation)
      || canonicalJson(parsed(current.signature_json)) !== canonicalJson(candidate.signature) || current.state === 'quarantined') {
      throw new CapacityGovernanceError('source_candidate_attempt_conflict', 'This assignment attempt already owns different or quarantined candidate custody.', 409);
    }
    if (current.state === 'accepted') {
      if (request.action === 'chunk') return { accepted: true, index: request.index, digest: attestation.bundle.chunks[request.index] };
      return sourceCandidateReceiptSchema.parse(parsed(current.receipt_json));
    }
    if (request.action === 'chunk') {
      const receipt = await options.withStorage(client => persistCandidateChunk(client, id, request));
      await check();
      return receipt;
    }
    const receipt: SourceCandidateReceipt = sourceCandidateReceiptSchema.parse({ schemaVersion: 'treeseed.source-candidate-receipt/v1', id,
      leaseId: attestation.leaseId, source: attestation.source, parentCandidateId: attestation.parentCandidateId, commit: attestation.commit,
      bundle: { artifactId: id, digest: attestation.bundle.digest, bytes: attestation.bundle.bytes },
      verification: { objectClosure: true, ancestry: true, authority: true }, persistedAt: now().toISOString() });
    await options.withStorage(async client => {
      await verifyStoredCandidate(client, id, attestation);
      const key = `${candidateObjectPrefix(id, attestation)}/manifest.json`, body = canonicalJson(candidate);
      await client.put(key, body, { contentType: 'application/json', ifNoneMatch: '*' });
      if ((await client.get(key, Buffer.byteLength(body)))?.body !== body) throw new CapacityGovernanceError('source_candidate_manifest_unverified', 'Candidate manifest read-back failed.', 503);
    });
    await check();
    // A late assignment lease transition cannot accept a candidate, even after successful external storage IO.
    await database.run(`UPDATE provider_source_candidates SET state='accepted',receipt_json=?::jsonb,accepted_at=?
      WHERE id=? AND state='uploading' AND EXISTS (SELECT 1 FROM capacity_provider_assignments assignment
      WHERE assignment.id=? AND assignment.team_id=? AND assignment.capacity_provider_id=? AND assignment.membership_id=?
      AND assignment.runner_id=? AND assignment.lease_token=? AND assignment.attempt_count+1=?
      AND assignment.status IN ('leased','running') AND assignment.lease_state='leased' AND assignment.lease_expires_at>?)`,
      [canonicalJson(receipt), receipt.persistedAt, id, assignmentId, actor.teamId, actor.capacityProviderId, actor.membershipId,
        request.runnerId, request.leaseToken, attestation.attempt, now().toISOString()]);
    const accepted = await load();
    if (accepted?.state !== 'accepted') throw new CapacityGovernanceError('source_candidate_acceptance_conflict', 'Assignment authority changed; retain the source overlay for recovery.', 409);
    return sourceCandidateReceiptSchema.parse(parsed(accepted.receipt_json));
  };
}
