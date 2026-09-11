import { CapacityGovernanceError, type CapacityGovernanceDatabase } from '../../../../capacity/database.ts';
import { assignmentSourceMode } from './source-workspace-service.ts';
import type { ProviderPrincipal } from '../provider-runtime-service.ts';

/** Source-producing assignments cannot be marked complete while their only copy is an execution overlay. */
export async function assertDurableSourceCloseout(database: CapacityGovernanceDatabase, actor: ProviderPrincipal, assignmentId: string) {
  const row = await database.first('SELECT * FROM capacity_provider_assignments WHERE id=? AND team_id=? AND capacity_provider_id=? AND membership_id=? LIMIT 1',
    [assignmentId, actor.teamId, actor.capacityProviderId, actor.membershipId]);
  if (!row) throw new CapacityGovernanceError('source_closeout_assignment_missing', 'Assignment is outside this provider authority.', 403);
  if (assignmentSourceMode(row).publication !== 'candidate-only') return;
  const candidate = await database.first(`SELECT id FROM provider_source_candidates WHERE assignment_id=? AND attempt=? AND team_id=? AND project_id=? AND provider_id=? AND state='accepted' LIMIT 1`,
    [assignmentId, row.attempt_count, actor.teamId, row.project_id, actor.capacityProviderId]);
  if (!candidate) throw new CapacityGovernanceError('source_candidate_required', 'Persist and verify the source candidate before completing this work assignment.', 409);
}
