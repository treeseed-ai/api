import { CapacityGovernanceError } from '../../../../capacity/database.ts';
import { selectAssignmentSourceRepository } from '../../../../capacity/services/capacity/assignments/context/source-repository.ts';

export type SourceRepository = ReturnType<typeof selectAssignmentSourceRepository>;
export interface AssignmentSourcePin {
  schemaVersion: 'treeseed.assignment-source-pin/v1';
  repository: SourceRepository;
  exactCommit: string;
  credentialBindingId: string;
  candidateId?: string;
}
interface PinStore {
  first(sql: string, parameters: unknown[]): Promise<Record<string, unknown> | null>;
  run(sql: string, parameters: unknown[]): Promise<unknown>;
}

/** GitHub authorization is rechecked even for a cached pin. Never follow a credential-bearing redirect. */
export async function resolveAuthorizedSourceCommit(repository: SourceRepository, token: string, fetchImpl: typeof fetch = fetch) {
  // Revalidate the tuple rather than trusting a stored transport URL.
  const validated = selectAssignmentSourceRepository([{ ...repository, role: 'software', currentBranch: repository.ref }]);
  const response = await fetchImpl(`https://api.github.com/repos/${encodeURIComponent(validated.owner)}/${encodeURIComponent(validated.name)}/commits/${encodeURIComponent(validated.ref)}`, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github.sha', 'x-github-api-version': '2022-11-28', 'user-agent': 'treeseed-source-custody' },
  });
  if (!response.ok) throw new CapacityGovernanceError('assignment_source_access_denied', 'The selected connection cannot read the assigned repository revision.', 403);
  // A SHA response is tiny. Bound consumption instead of buffering arbitrary provider error/output bodies.
  const reader = response.body?.getReader();
  if (!reader) throw new CapacityGovernanceError('assignment_source_revision_invalid', 'The repository did not return an exact revision.', 502);
  let text = '';
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      text += new TextDecoder().decode(next.value);
      if (text.length > 128) throw new CapacityGovernanceError('assignment_source_revision_invalid', 'The repository returned an invalid revision.', 502);
    }
  } finally { await reader.cancel(); }
  const commit = text.trim();
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new CapacityGovernanceError('assignment_source_revision_invalid', 'The repository did not return an exact revision.', 502);
  if (/^[a-f0-9]{40}$/u.test(validated.ref) && commit !== validated.ref) throw new CapacityGovernanceError('assignment_source_revision_changed', 'The repository response does not match the pinned revision.', 409);
  return commit;
}

export function readAssignmentSourcePin(context: Record<string, unknown>): AssignmentSourcePin | null {
  if (context.sourceWorkspace === undefined) return null;
  const pin = context.sourceWorkspace as Partial<AssignmentSourcePin> | null;
  if (!pin || pin.schemaVersion !== 'treeseed.assignment-source-pin/v1' || !pin.repository
    || !/^[a-f0-9]{40}$/u.test(String(pin.exactCommit)) || typeof pin.credentialBindingId !== 'string' || !pin.credentialBindingId) {
    throw new CapacityGovernanceError('assignment_source_pin_invalid', 'The assignment source pin is invalid; refusing to replace it.', 409);
  }
  const repository = selectAssignmentSourceRepository([{ ...pin.repository, role: 'software', currentBranch: pin.repository.ref }]);
  if (pin.candidateId !== undefined && !/^source-candidate-[a-f0-9]{64}$/u.test(pin.candidateId)) throw new CapacityGovernanceError('assignment_source_candidate_invalid', 'Assignment candidate identity is invalid.', 409);
  return { schemaVersion: pin.schemaVersion, repository, exactCommit: pin.exactCommit!, credentialBindingId: pin.credentialBindingId,
    ...(pin.candidateId ? { candidateId: pin.candidateId } : {}) };
}

/** CAS preserves the first exact revision across concurrent requests and moving protected refs. */
export async function persistAssignmentSourcePin(store: PinStore, input: {
  assignmentId: string; teamId: string; providerId: string; membershipId: string; runnerId: string;
  leaseToken: string; stateVersion: number; context: Record<string, unknown>; pin: AssignmentSourcePin; now: string;
}) {
  if (readAssignmentSourcePin(input.context)) throw new CapacityGovernanceError('assignment_source_already_pinned', 'An existing source pin cannot be replaced.', 409);
  const pin = readAssignmentSourcePin({ sourceWorkspace: input.pin })!;
  await store.run(`UPDATE capacity_provider_assignments SET workspace_context_json=?,state_version=state_version+1,updated_at=?
    WHERE id=? AND team_id=? AND capacity_provider_id=? AND membership_id=? AND runner_id=?
    AND lease_token=? AND state_version=? AND status IN ('leased','running') AND lease_state='leased' AND lease_expires_at>?`,
    [JSON.stringify({ ...input.context, sourceWorkspace: pin }), input.now, input.assignmentId, input.teamId, input.providerId,
      input.membershipId, input.runnerId, input.leaseToken, input.stateVersion, input.now]);
  const current = await store.first(`SELECT workspace_context_json FROM capacity_provider_assignments
    WHERE id=? AND team_id=? AND capacity_provider_id=? AND membership_id=? AND runner_id=?
    AND lease_token=? AND status IN ('leased','running') AND lease_state='leased' AND lease_expires_at>?`,
    [input.assignmentId, input.teamId, input.providerId, input.membershipId, input.runnerId, input.leaseToken, input.now]);
  let context: Record<string, unknown> = {};
  try { context = typeof current?.workspace_context_json === 'string' ? JSON.parse(current.workspace_context_json) : (current?.workspace_context_json ?? {}) as Record<string, unknown>; } catch { /* Fail closed below. */ }
  const accepted = readAssignmentSourcePin(context);
  if (!accepted) throw new CapacityGovernanceError('assignment_source_pin_conflict', 'The assignment changed before its source revision could be pinned. Retry with current authority.', 409);
  return accepted;
}
