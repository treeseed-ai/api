import { randomUUID, timingSafeEqual } from 'node:crypto';
import { sourceWorkspaceRequestSchema, sourceWorkspaceResponseSchema, type SourceWorkspaceAuthorization } from '@treeseed/sdk/capacity-provider/sandbox';
import { sealSourceCredential } from '@treeseed/deployment/security/source';
import { resolveGitHubSourceAuthority } from '../../../../../security/provider-credential-authority.ts';
import { CapacityGovernanceError, type CapacityGovernanceDatabase } from '../../../../capacity/database.ts';
import { evaluateProviderAssignmentLeaseAuthority } from '../../../../capacity/services/accounts/lease-authority-service.ts';
import { selectAssignmentSourceRepository } from '../../../../capacity/services/capacity/assignments/context/source-repository.ts';
import { providerPrincipal, type ProviderPrincipal } from '../provider-runtime-service.ts';
import { persistAssignmentSourcePin, readAssignmentSourcePin, resolveAuthorizedSourceCommit } from './source-pin.ts';

type RecordValue = Record<string, unknown>;
interface SourceStore {
  getProject(id: string): Promise<RecordValue | null>;
  listHubRepositories(id: string): Promise<RecordValue[]>;
}
function record(value: unknown): RecordValue {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CapacityGovernanceError('assignment_source_context_invalid', 'Assignment source context is invalid.', 409);
  return parsed as RecordValue;
}
function equalSecret(left: unknown, right: string) {
  if (typeof left !== 'string') return false;
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function assertSourceAssignmentLease(row: RecordValue | null, principal: ProviderPrincipal, assignmentId: string, runnerId: string, leaseToken: string, now: Date) {
  if (!row || row.id !== assignmentId || row.team_id !== principal.teamId || row.capacity_provider_id !== principal.capacityProviderId
    || row.membership_id !== principal.membershipId || row.runner_id !== runnerId || !equalSecret(row.lease_token, leaseToken)
    || !['leased', 'running'].includes(String(row.status)) || row.lease_state !== 'leased'
    || !Number.isFinite(Date.parse(String(row.lease_expires_at))) || Date.parse(String(row.lease_expires_at)) <= now.getTime()
    || !Number.isInteger(Number(row.attempt_count)) || Number(row.attempt_count) < 1) {
    throw new CapacityGovernanceError('assignment_source_lease_invalid', 'Source access requires this provider runner’s current assignment lease.', 403);
  }
  return row;
}

/** Analysis and work are both writable scratch. Only an explicit governed output grants candidate publication. */
export function assignmentSourceMode(row: RecordValue) {
  const work = row.execution_kind !== 'conversation' && row.mode === 'acting';
  const outputs = record(row.allowed_outputs_json ?? {});
  return { mode: work ? 'work' as const : 'analysis' as const,
    publication: work && Array.isArray(outputs.artifactKinds) && outputs.artifactKinds.includes('source-candidate') ? 'candidate-only' as const : 'denied' as const };
}

export function createSourceWorkspaceService(database: CapacityGovernanceDatabase, contentStore: SourceStore, options: {
  controlPlaneId: string; fetchImpl?: typeof fetch; now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());
  const load = (id: string, actor: ProviderPrincipal) => database.first('SELECT * FROM capacity_provider_assignments WHERE id=? AND team_id=? AND capacity_provider_id=? AND membership_id=? LIMIT 1', [id, actor.teamId, actor.capacityProviderId, actor.membershipId]);
  return async (auth: unknown, assignmentId: string, body: unknown) => {
    const actor = providerPrincipal(auth, ['provider:assignments:read']);
    const parsed = sourceWorkspaceRequestSchema.safeParse(body);
    if (!parsed.success) throw new CapacityGovernanceError('assignment_source_request_invalid', 'Source access requires a runner, current lease, and ephemeral recipient key.', 400);
    const request = parsed.data;
    let row = assertSourceAssignmentLease(await load(assignmentId, actor), actor, assignmentId, request.runnerId, request.leaseToken, now());
    const checkAuthority = async () => {
      const authority = await evaluateProviderAssignmentLeaseAuthority(database, actor, assignmentId, now().toISOString());
      if (!authority.eligible) throw new CapacityGovernanceError('assignment_source_authority_revoked', 'Provider membership, capacity grant, or assignment authority is no longer active.', 403);
    };
    await checkAuthority();
    const projectId = String(row.project_id), project = await contentStore.getProject(projectId);
    if (!project || String(project.teamId ?? project.team_id) !== actor.teamId) throw new CapacityGovernanceError('assignment_source_project_forbidden', 'The assignment project is not owned by this team.', 403);
    const configured = selectAssignmentSourceRepository(await contentStore.listHubRepositories(projectId));
    const context = record(row.workspace_context_json);
    let pin = readAssignmentSourcePin(context);
    if (pin && (pin.repository.id !== configured.id || pin.repository.cloneUrl !== configured.cloneUrl)) throw new CapacityGovernanceError('assignment_source_repository_changed', 'The project source repository changed after this assignment was pinned.', 409);
    const credentialFor = (bindingId?: string) => resolveGitHubSourceAuthority({ store: contentStore, teamId: actor.teamId,
      owner: configured.owner, repository: configured.name, ...(bindingId ? { bindingId } : {}), ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
    let credential = await credentialFor(pin?.credentialBindingId);
    if (!pin) {
      const exactCommit = await resolveAuthorizedSourceCommit(configured, credential.token, options.fetchImpl);
      pin = await persistAssignmentSourcePin(database, { assignmentId, teamId: actor.teamId, providerId: actor.capacityProviderId, membershipId: actor.membershipId,
        runnerId: request.runnerId, leaseToken: request.leaseToken, stateVersion: Number(row.state_version), context,
        pin: { schemaVersion: 'treeseed.assignment-source-pin/v1', repository: configured, exactCommit, credentialBindingId: credential.bindingId }, now: now().toISOString() });
    }
    // Re-resolve the winning binding: a concurrent pin or revocation must never reuse a losing credential.
    credential = await credentialFor(pin.credentialBindingId);
    if (pin.repository.id !== configured.id || pin.repository.cloneUrl !== configured.cloneUrl) throw new CapacityGovernanceError('assignment_source_repository_changed', 'Concurrent source pin selected a different repository.', 409);
    await resolveAuthorizedSourceCommit({ ...pin.repository, ref: pin.exactCommit }, credential.token, options.fetchImpl);
    await checkAuthority();
    const issued = now();
    row = assertSourceAssignmentLease(await load(assignmentId, actor), actor, assignmentId, request.runnerId, request.leaseToken, issued);
    const accepted = readAssignmentSourcePin(record(row.workspace_context_json));
    if (JSON.stringify(accepted) !== JSON.stringify(pin)) throw new CapacityGovernanceError('assignment_source_pin_changed', 'Assignment source identity changed during authorization.', 409);
    const credentialExpiry = credential.expiresAt ? Date.parse(credential.expiresAt) : issued.getTime() + 300_000;
    const expiry = Math.min(Date.parse(String(row.lease_expires_at)), credentialExpiry, issued.getTime() + 300_000);
    if (!Number.isFinite(expiry) || expiry <= issued.getTime()) throw new CapacityGovernanceError('assignment_source_credential_expired', 'Source credential expired during authorization.', 409);
    const authorization: SourceWorkspaceAuthorization = { schemaVersion: 'treeseed.source-workspace-authorization/v1', id: randomUUID(),
      providerId: actor.capacityProviderId, assignmentId, attempt: Number(row.attempt_count),
      source: { controlPlaneId: options.controlPlaneId, teamId: actor.teamId, projectId, repositoryId: pin.repository.id, commit: pin.exactCommit, formatVersion: 1, profile: 'source-only' },
      ...assignmentSourceMode(row), credentialBindingId: pin.credentialBindingId, issuedAt: issued.toISOString(), expiresAt: new Date(expiry).toISOString() };
    const sealed = sealSourceCredential({ authorization, recipientPublicKey: request.recipientPublicKey, credential }, issued);
    const { id: _id, ...repository } = pin.repository;
    return sourceWorkspaceResponseSchema.parse({ authorization, repository, credential: sealed });
  };
}
