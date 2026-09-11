import { sourceCandidateChunkBytes, sourceChunkRequestSchema } from '@treeseed/sdk/capacity-provider/sandbox';
import type { R2PublicationClient } from '../../../../providers/cloudflare/r2-publication-client.ts';
import { CapacityGovernanceError, type CapacityGovernanceDatabase } from '../../../../capacity/database.ts';
import { evaluateProviderAssignmentLeaseAuthority } from '../../../../capacity/services/accounts/lease-authority-service.ts';
import { resolveGitHubSourceAuthority } from '../../../../../security/provider-credential-authority.ts';
import { providerPrincipal } from '../provider-runtime-service.ts';
import { assertSourceAssignmentLease } from './source-workspace-service.ts';
import { readAssignmentSourcePin } from './source-pin.ts';
import { assignmentPredecessorCandidate } from './candidate-handoff.ts';
import { assertCandidateChunk, candidateChunkKey } from './candidate-storage.ts';

export function createSourceChunkService(database: CapacityGovernanceDatabase, contentStore: unknown, options: {
  controlPlaneId: string; withStorage<T>(run: (client: R2PublicationClient) => Promise<T>): Promise<T>; now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());
  return async (auth: unknown, assignmentId: string, value: unknown) => {
    const actor = providerPrincipal(auth, ['provider:assignments:read']), validation = sourceChunkRequestSchema.safeParse(value);
    if (!validation.success) throw new CapacityGovernanceError('source_chunk_request_invalid', 'Source read requires the current assignment lease and bounded chunk identity.', 400);
    const request = validation.data;
    const check = async () => {
      const row = assertSourceAssignmentLease(await database.first('SELECT * FROM capacity_provider_assignments WHERE id=? AND team_id=? AND capacity_provider_id=? AND membership_id=? LIMIT 1',
        [assignmentId, actor.teamId, actor.capacityProviderId, actor.membershipId]), actor, assignmentId, request.runnerId, request.leaseToken, now());
      const authority = await evaluateProviderAssignmentLeaseAuthority(database, actor, assignmentId, now().toISOString());
      if (!authority.eligible) throw new CapacityGovernanceError('source_chunk_authority_revoked', 'Source read authority is no longer active.', 403);
      const context = typeof row.workspace_context_json === 'string' ? JSON.parse(row.workspace_context_json) : row.workspace_context_json;
      const pin = readAssignmentSourcePin(context as Record<string, unknown>);
      if (!pin || pin.candidateId !== request.artifactId) throw new CapacityGovernanceError('source_chunk_not_assigned', 'This artifact is not pinned to the current assignment.', 403);
      const candidate = await assignmentPredecessorCandidate(database, row, pin.repository, options.controlPlaneId);
      if (!candidate || candidate.id !== request.artifactId || candidate.attestation.commit !== pin.exactCommit) throw new CapacityGovernanceError('source_chunk_handoff_changed', 'The source handoff is no longer available.', 403);
      const credential = await resolveGitHubSourceAuthority({ store: contentStore, teamId: actor.teamId, owner: pin.repository.owner, repository: pin.repository.name, bindingId: pin.credentialBindingId });
      credential.token = '';
      return candidate;
    };
    const candidate = await check();
    const bytes = await options.withStorage(async client => {
      const found = await client.getBytes(candidateChunkKey(candidate.id, candidate.attestation, request.index), sourceCandidateChunkBytes);
      if (!found) throw new CapacityGovernanceError('source_chunk_missing', 'The accepted source artifact is unavailable; do not substitute another revision.', 503);
      assertCandidateChunk(candidate.attestation, request.index, found.body);
      return found.body;
    });
    await check();
    return { artifactId: candidate.id, index: request.index, digest: candidate.attestation.bundle.chunks[request.index], content: Buffer.from(bytes).toString('base64') };
  };
}
