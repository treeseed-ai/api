import { CapacityGovernanceError, type CapacityGovernanceDatabase } from '../../../../database.ts';
import type { AssignmentReference } from '@treeseed/sdk/agent-capacity';

/** Publication records content authority; normal completion retains lease/result authority. */
export async function recordAssignmentDiscussionResponse(store: Pick<CapacityGovernanceDatabase, 'batch' | 'first'>, input: {
	assignmentId: string; invocationId: string; teamId: string; leaseToken: string;
	messagePath: string; outcome: 'responded' | 'abstained'; reference: AssignmentReference;
}) {
	const now = new Date().toISOString();
	await store.batch([{ query: `UPDATE agent_invocation_requests SET final_message_ref=?,response_json=?,updated_at=?
		WHERE id=? AND team_id=? AND assignment_id=? AND status IN ('admitted','running')
		AND EXISTS (SELECT 1 FROM capacity_provider_assignments assignment WHERE assignment.id=? AND assignment.team_id=?
			AND assignment.status='leased' AND assignment.lease_state='leased' AND assignment.lease_token=?)`,
		params: [input.messagePath, JSON.stringify({ outcome: input.outcome, reference: input.reference }), now,
			input.invocationId, input.teamId, input.assignmentId, input.assignmentId, input.teamId, input.leaseToken] }]);
	const observed = await store.first(`SELECT final_message_ref FROM agent_invocation_requests WHERE id=? AND team_id=? AND assignment_id=?
		AND EXISTS (SELECT 1 FROM capacity_provider_assignments assignment WHERE assignment.id=? AND assignment.team_id=?
			AND assignment.status='leased' AND assignment.lease_state='leased' AND assignment.lease_token=?)`,
		[input.invocationId, input.teamId, input.assignmentId, input.assignmentId, input.teamId, input.leaseToken]);
	if (observed?.final_message_ref !== input.messagePath) throw new CapacityGovernanceError('communication_response_record_failed',
		'The published response did not retain exact invocation and lease authority.', 409);
}
