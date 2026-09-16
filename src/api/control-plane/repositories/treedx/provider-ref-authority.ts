import { CapacityGovernanceError } from '../../../capacity/database.ts';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';

/** Only persisted assignment authority and its own journaled commits may extend a read. */
export function providerRefAuthority(input: {
  handle: Record<string, unknown>; projectId: string; workspace: boolean; requestedRef?: unknown;
  producedCommits?: string[];
}) {
  const { handle } = input, metadata = record(handle.metadata);
  const primaryProjectId = text(handle.repositoryProjectId ?? metadata.repositoryProjectId) || text(handle.projectId);
  const primary = primaryProjectId === input.projectId;
  const grants = handle.readRepositories ?? metadata.readRepositories;
  const requested = text(input.requestedRef);
  const projectGrants = Array.isArray(grants) ? grants.map(record).filter(candidate => candidate.projectId === input.projectId) : [];
  const exactGrant = requested ? projectGrants.find(candidate => text(candidate.baseRef) === requested) : undefined;
  const grant = exactGrant ?? projectGrants[0];
  const primaryBase = text(handle.baseCommitSha ?? metadata.baseCommitSha ?? handle.baseRef ?? metadata.baseRef);
  const base = exactGrant ? text(exactGrant.baseRef) : primary ? primaryBase : text(grant?.baseRef);
  if (!base) throw new CapacityGovernanceError('treedx_assignment_ref_missing', 'Assignment has no pinned TreeDX read authority.', 409);
  if (input.workspace) {
    if (!primary) throw new CapacityGovernanceError('treedx_assignment_workspace_denied', 'Secondary project grants cannot access an assignment workspace.', 403);
    return { ref: base, refs: [...new Set([base, text(handle.baseRef ?? metadata.baseRef), text(handle.branchName ?? metadata.branchName)].filter(Boolean))] };
  }
  const selected = requested || base;
  if (selected !== base && !(primary && /^[a-f0-9]{40}$/u.test(selected) && input.producedCommits?.includes(selected))) {
    throw new CapacityGovernanceError('treedx_assignment_ref_denied', 'The requested commit is outside this assignment’s TreeDX authority.', 403);
  }
  return { ref: selected, refs: [selected] };
}
