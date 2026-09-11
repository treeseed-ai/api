import { sourceCandidateAttestationSchema } from '@treeseed/sdk/capacity-provider/sandbox';
import { CapacityGovernanceError, type CapacityGovernanceDatabase } from '../../../../capacity/database.ts';
import type { SourceRepository } from './source-pin.ts';

/** Only the control-plane assignment graph selects predecessor work. A caller never chooses a foreign candidate. */
export async function assignmentPredecessorCandidate(database: CapacityGovernanceDatabase, assignment: Record<string, unknown>, repository: SourceRepository, controlPlaneId: string) {
  const parentId = assignment.parent_assignment_id;
  if (typeof parentId !== 'string' || !parentId) return null;
  const parent = await database.first('SELECT * FROM capacity_provider_assignments WHERE id=? AND team_id=? AND project_id=? LIMIT 1',
    [parentId, assignment.team_id, assignment.project_id]);
  if (!parent) throw new CapacityGovernanceError('source_parent_assignment_unavailable', 'Source handoff parent is not in the same project and team.', 409);
  const candidates = await database.all(`SELECT id,attestation_json FROM provider_source_candidates
    WHERE assignment_id=? AND team_id=? AND project_id=? AND attempt=? AND state='accepted' LIMIT 1`, [parentId, assignment.team_id, assignment.project_id, parent.attempt_count]);
  const candidate = candidates[0];
  if (!candidate) {
    const outputs: unknown = typeof parent.allowed_outputs_json === 'string' ? JSON.parse(parent.allowed_outputs_json) : parent.allowed_outputs_json;
    if (outputs && typeof outputs === 'object' && 'artifactKinds' in outputs && Array.isArray(outputs.artifactKinds) && outputs.artifactKinds.includes('source-candidate')) {
      throw new CapacityGovernanceError('source_parent_candidate_missing', 'The parent requires a durable source candidate; do not fall back to a released branch.', 409);
    }
    return null;
  }
  if (parent.status !== 'completed') throw new CapacityGovernanceError('source_parent_not_completed', 'Source handoff requires completed parent work.', 409);
  const attestation = sourceCandidateAttestationSchema.parse(typeof candidate.attestation_json === 'string' ? JSON.parse(candidate.attestation_json) : candidate.attestation_json);
  if (attestation.assignmentId !== parentId || attestation.source.teamId !== assignment.team_id || attestation.source.projectId !== assignment.project_id
    || attestation.source.repositoryId !== repository.id || attestation.source.controlPlaneId !== controlPlaneId) throw new CapacityGovernanceError('source_candidate_scope_mismatch', 'Accepted source candidate belongs to another source authority.', 403);
  return { id: String(candidate.id), attestation };
}
