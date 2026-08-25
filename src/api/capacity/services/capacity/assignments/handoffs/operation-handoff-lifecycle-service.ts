import type { CapacityGovernanceDatabase } from '../../../../database.ts';
import { CapacityGovernanceError } from '../../../../database.ts';
import { decodeDurableJsonObject } from '../../../../durable-json.ts';
import { appendDiscussionEvent } from '../../../../../discussions/content.ts';

type Row = Record<string, unknown>;
function text(value: unknown) { return typeof value === 'string' && value.trim() ? value.trim() : null; }

export type ApprovedOperationHandoff = {
	id: string; discussionId: string; sourceMessageRefs: string[];
};

export async function approvedOperationHandoffForWorkUnit(database: CapacityGovernanceDatabase, input: {
	teamId: string; projectId: string; decisionId: string; proposalId: string | null;
	workUnitId: string; workGraphNodeId: string;
}): Promise<ApprovedOperationHandoff | null> {
	const rows = await database.all(
		`SELECT id,discussion_id,inputs_json,source_message_refs_json,proposal_id FROM agent_operation_handoffs
		 WHERE team_id=? AND project_id=? AND status='approved' AND (decision_id=? OR (decision_id IS NULL AND proposal_id=?))
		 ORDER BY created_at ASC,id ASC`,
		[input.teamId,input.projectId,input.decisionId,input.proposalId],
	);
	const matches = rows.filter((row) => {
		if (text(row.proposal_id) && text(row.proposal_id) !== input.proposalId) return false;
		const values = decodeDurableJsonObject(row.inputs_json, { owner: 'operation handoff', ownerId: String(row.id), column: 'inputs_json' });
		return text(values.workUnitId) === input.workUnitId || text(values.workGraphNodeId) === input.workGraphNodeId;
	});
	if (matches.length > 1) throw new CapacityGovernanceError(
		'operation_handoff_work_unit_ambiguous',
		'The accepted work unit has more than one approved operation handoff.', 409,
		{ decisionId: input.decisionId, workUnitId: input.workUnitId, workGraphNodeId: input.workGraphNodeId, handoffIds: matches.map((row) => row.id) },
	);
	const match = matches[0];
	if (!match) return null;
	const refs = Array.isArray(match.source_message_refs_json)
		? match.source_message_refs_json
		: JSON.parse(String(match.source_message_refs_json ?? '[]'));
	return { id: String(match.id), discussionId: String(match.discussion_id), sourceMessageRefs: refs.map(String).filter(Boolean) };
}

async function project(store: CapacityGovernanceDatabase, row: Row, phase: string, assignmentId: string, message: string) {
	try {
		await appendDiscussionEvent({ store, projectId: String(row.project_id), teamId: String(row.team_id), discussionId: String(row.discussion_id), event: {
			id: `operation-handoff:${String(row.id)}:${phase}`, eventType: `operation-handoff.${phase}`, assignmentId,
			refs: { operationHandoffId: String(row.id), sourceMessageRefs: JSON.parse(String(row.source_message_refs_json ?? '[]')) },
			metadata: { target: row.target, resultingAssignmentId: assignmentId }, message,
		} });
	} catch (error) {
		console.warn('[api] Operation handoff Discussion projection remains pending.', { handoffId: row.id, phase, error: error instanceof Error ? error.message : String(error) });
	}
}

export async function bindOperationHandoffAssignment(store: CapacityGovernanceDatabase, handoffId: string, assignmentId: string, decisionId: string, now: string) {
	const row = await store.first(`SELECT * FROM agent_operation_handoffs WHERE id=? LIMIT 1`, [handoffId]);
	if (!row) throw new CapacityGovernanceError('operation_handoff_missing', 'The approved operation handoff no longer exists.', 409, { handoffId });
	if (row.resulting_assignment_id && row.resulting_assignment_id !== assignmentId) throw new CapacityGovernanceError(
		'operation_handoff_assignment_conflict', 'The operation handoff is already bound to another assignment.', 409,
		{ handoffId, resultingAssignmentId: row.resulting_assignment_id },
	);
	await store.run(`UPDATE agent_operation_handoffs SET status='scheduled',decision_id=COALESCE(decision_id,?),resulting_assignment_id=?,updated_at=? WHERE id=? AND status IN ('approved','scheduled') AND (resulting_assignment_id IS NULL OR resulting_assignment_id=?)`, [decisionId,assignmentId,now,handoffId,assignmentId]);
	await project(store, row, 'scheduled', assignmentId, 'The approved operation handoff was admitted through the governed operation lifecycle.');
}

export async function markOperationHandoffRunning(store: CapacityGovernanceDatabase, handoffId: string, assignmentId: string, now: string) {
	await store.run(`UPDATE agent_operation_handoffs SET status='running',updated_at=? WHERE id=? AND resulting_assignment_id=? AND status IN ('scheduled','running')`, [now,handoffId,assignmentId]);
}

export async function terminalizeOperationHandoff(store: CapacityGovernanceDatabase, handoffId: string, assignmentId: string, status: 'completed'|'failed', now: string) {
	const row = await store.first(`SELECT * FROM agent_operation_handoffs WHERE id=? AND resulting_assignment_id=? LIMIT 1`, [handoffId,assignmentId]);
	if (!row) return;
	await store.run(`UPDATE agent_operation_handoffs SET status=?,updated_at=? WHERE id=? AND resulting_assignment_id=? AND status IN ('scheduled','running',?)`, [status,now,handoffId,assignmentId,status]);
	await project(store, row, status, assignmentId, status === 'completed'
		? 'The governed operation handoff completed.' : 'The governed operation handoff failed.');
}

export async function recoverOperationHandoff(store: CapacityGovernanceDatabase, handoffId: string, assignmentId: string, input: { retry: boolean; completed: boolean }, now: string) {
	if (input.retry) {
		await store.run(`UPDATE agent_operation_handoffs SET status='approved',resulting_assignment_id=NULL,updated_at=? WHERE id=? AND resulting_assignment_id=? AND status IN ('scheduled','running')`, [now,handoffId,assignmentId]);
		return;
	}
	await terminalizeOperationHandoff(store,handoffId,assignmentId,input.completed?'completed':'failed',now);
}
