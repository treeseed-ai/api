import { CapacityGovernanceError } from '../../../capacity/database.ts';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';

/** Only persisted assignment authority and its own journaled commits may extend a read. */
export function providerRefAuthority(input: {
  handle: Record<string, unknown>; projectId: string; workspace: boolean; requestedRef?: unknown;
  producedCommits?: string[];
}) {
  const { handle } = input, metadata = record(handle.metadata);
  const own = String(handle.projectId) === input.projectId;
  const grants = handle.readRepositories ?? metadata.readRepositories;
  const grant = Array.isArray(grants) ? grants.map(record).find(candidate => candidate.projectId === input.projectId) : undefined;
  const base = own ? text(handle.baseCommitSha ?? metadata.baseCommitSha ?? handle.baseRef ?? metadata.baseRef) : text(grant?.baseRef);
  if (!base) throw new CapacityGovernanceError('treedx_assignment_ref_missing', 'Assignment has no pinned TreeDX read authority.', 409);
  if (input.workspace) {
    if (!own) throw new CapacityGovernanceError('treedx_assignment_workspace_denied', 'Cross-project grants cannot access an assignment workspace.', 403);
    return { ref: base, refs: [...new Set([base, text(handle.baseRef ?? metadata.baseRef), text(handle.branchName ?? metadata.branchName)].filter(Boolean))] };
  }
  const requested = text(input.requestedRef) || base;
  if (requested !== base && !(own && /^[a-f0-9]{40}$/u.test(requested) && input.producedCommits?.includes(requested))) {
    throw new CapacityGovernanceError('treedx_assignment_ref_denied', 'The requested commit is outside this assignment’s TreeDX authority.', 403);
  }
  return { ref: requested, refs: [requested] };
}
