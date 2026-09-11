import { createHash, createPublicKey, verify, type JsonWebKey } from 'node:crypto';
import type { SignedSourceCandidate } from '@treeseed/sdk/capacity-provider/sandbox';
import { canonicalJson } from '../../../../capacity/security.ts';
import { CapacityGovernanceError, type CapacityGovernanceDatabase } from '../../../../capacity/database.ts';
import { evaluateProviderAssignmentLeaseAuthority } from '../../../../capacity/services/accounts/lease-authority-service.ts';
import { resolveGitHubSourceAuthority } from '../../../../../security/provider-credential-authority.ts';
import type { ProviderPrincipal } from '../provider-runtime-service.ts';
import { assertSourceAssignmentLease, assignmentSourceMode } from './source-workspace-service.ts';
import { readAssignmentSourcePin } from './source-pin.ts';

export function sourceCandidateId(candidate: SignedSourceCandidate) {
  return `source-candidate-${createHash('sha256').update(canonicalJson(candidate.attestation)).digest('hex')}`;
}
function object(value: unknown): Record<string, unknown> {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CapacityGovernanceError('source_candidate_context_invalid', 'Candidate source custody is invalid.', 409);
  return parsed as Record<string, unknown>;
}
export function verifyCandidateSignature(candidate: SignedSourceCandidate, publicJwk: Record<string, unknown>) {
  if (publicJwk.kty !== 'OKP' || publicJwk.crv !== 'Ed25519' || typeof publicJwk.x !== 'string' || publicJwk.d
    || candidate.signature.keyId !== `provider-${createHash('sha256').update(publicJwk.x).digest('hex').slice(0, 16)}`
    || !verify(null, Buffer.from(canonicalJson(candidate.attestation)), createPublicKey({ key: publicJwk as JsonWebKey, format: 'jwk' }), Buffer.from(candidate.signature.value, 'base64url'))) {
    throw new CapacityGovernanceError('source_candidate_signature_invalid', 'Candidate verification must be signed by the registered provider host.', 403);
  }
}
/** Repeated before storage and before acceptance. A provider signature alone never grants publication. */
export async function authorizeSourceCandidate(database: CapacityGovernanceDatabase, contentStore: unknown, actor: ProviderPrincipal,
  assignmentId: string, request: { runnerId: string; leaseToken: string; candidate: SignedSourceCandidate }, controlPlaneId: string, now = new Date()) {
  const row = assertSourceAssignmentLease(await database.first('SELECT * FROM capacity_provider_assignments WHERE id=? AND team_id=? AND capacity_provider_id=? AND membership_id=? LIMIT 1',
    [assignmentId, actor.teamId, actor.capacityProviderId, actor.membershipId]), actor, assignmentId, request.runnerId, request.leaseToken, now);
  const scope = assignmentSourceMode(row), attestation = request.candidate.attestation;
  const context = object(row.workspace_context_json), pin = readAssignmentSourcePin(context);
  if (scope.mode !== 'work' || scope.publication !== 'candidate-only' || !pin
    || attestation.providerId !== actor.capacityProviderId || attestation.assignmentId !== assignmentId || attestation.attempt !== Number(row.attempt_count)
    || attestation.source.controlPlaneId !== controlPlaneId || attestation.source.teamId !== actor.teamId
    || attestation.source.projectId !== String(row.project_id) || attestation.source.repositoryId !== pin.repository.id || attestation.source.commit !== pin.exactCommit
    || attestation.parentCandidateId !== (pin.candidateId ?? null)
    || Date.parse(attestation.verifiedAt) > now.getTime() + 30_000) {
    throw new CapacityGovernanceError('source_candidate_authority_denied', 'Candidate does not match this assignment’s exact source and publication authority.', 403);
  }
  const authority = await evaluateProviderAssignmentLeaseAuthority(database, actor, assignmentId, now.toISOString());
  if (!authority.eligible) throw new CapacityGovernanceError('source_candidate_authority_revoked', 'Assignment or provider authority is no longer active.', 403);
  const identity = await database.first('SELECT public_jwk_json FROM capacity_providers WHERE id=? AND status=\'active\' LIMIT 1', [actor.capacityProviderId]);
  if (!identity) throw new CapacityGovernanceError('source_candidate_provider_revoked', 'Provider signing identity is inactive.', 403);
  verifyCandidateSignature(request.candidate, object(identity.public_jwk_json));
  // Recheck the exact Vault-backed repository binding. Never broaden a source credential into Git write authority.
  const credential = await resolveGitHubSourceAuthority({ store: contentStore, teamId: actor.teamId, owner: pin.repository.owner,
    repository: pin.repository.name, bindingId: pin.credentialBindingId });
  credential.token = '';
  return row;
}
