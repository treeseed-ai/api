import { createHash } from 'node:crypto';
import { canonicalStandardsJson } from '@treeseed/sdk/standards';
import { authorizedContextItemSchema, type AssignmentAttempt } from '@treeseed/sdk/agent-capacity';
import type { CapacityGovernanceDatabase } from '../../../../database.ts';
import { CapacityGovernanceError } from '../../../../database.ts';
import { redactSensitiveValue } from '../../../../../../security/redact-sensitive-value.ts';
import { serializeCapacityLedgerEntryRow } from '../../../../repositories/capacity/accounting/ledger.ts';

/** Snapshot existing execution authority for the native Reporter; never copy credential custody. */
export async function workdayReportContext(store: CapacityGovernanceDatabase, assignment: AssignmentAttempt) {
	if (assignment.effectiveProfile.activity !== 'reporting') return [];
	if (assignment.sourceRef.store !== 'postgresql' || assignment.sourceRef.model !== 'workday'
		|| assignment.sourceRef.id !== assignment.workdayId) throw new CapacityGovernanceError(
			'reporter_workday_authority_required', 'Reporter must reference its own workday.', 409);
	const scope = [assignment.teamId, assignment.workdayId];
	const [nodes, edges, attempts, reservations, usage, ledger] = await Promise.all([
		store.all(`SELECT id,kind,pair_role,status,node_revision,source_ref_json,authority_refs_json
			FROM execution_nodes WHERE team_id=? AND workday_id=? ORDER BY id`, scope),
		store.all(`SELECT edge.id,edge.from_node_id,edge.to_node_id,edge.provenance
			FROM execution_edges edge JOIN execution_nodes node ON node.team_id=edge.team_id AND node.id=edge.to_node_id
			WHERE node.team_id=? AND node.workday_id=? AND edge.graph_revision_removed IS NULL ORDER BY edge.id`, scope),
		store.all(`SELECT id,execution_node_id,execution_node_revision,status,reservation_id,execution_provider_id,
			assignment_result_json,lifecycle_code,created_at,completed_at,failed_at,
			lifecycle_output_json::jsonb #>> '{activityCompletion,reviewDisposition}' AS review_disposition,
			lifecycle_output_json::jsonb #> '{teardown}' AS teardown_result,
			lifecycle_output_json::jsonb #>> '{teardown,status}' AS teardown_status
			FROM capacity_provider_assignments WHERE team_id=? AND work_day_id=? ORDER BY created_at,id`, scope),
		store.all(`SELECT id,assignment_id,state,requested_seconds,reserved_seconds,active_seconds,elapsed_seconds,
			released_seconds,overrun_seconds FROM capacity_reservations WHERE team_id=? AND work_day_id=? ORDER BY id`, scope),
		store.all(`SELECT usage.id,usage.assignment_id,usage.assignment_attempt,usage.usage_dimension,
			usage.active_seconds,usage.elapsed_seconds,usage.input_tokens,usage.cached_input_tokens,usage.output_tokens,
			usage.reasoning_tokens FROM capacity_usage_actuals usage JOIN capacity_provider_assignments assignment
			ON assignment.id=usage.assignment_id WHERE assignment.team_id=? AND assignment.work_day_id=? ORDER BY usage.id`, scope),
		store.all(`SELECT id,settlement_key,membership_id,capacity_provider_id,reservation_id,assignment_id,mode,
			team_id,project_id,work_day_id,task_id,phase,active_seconds,elapsed_seconds,provider_units,usd,source,metadata_json,created_at
			FROM capacity_ledger_entries WHERE team_id=? AND work_day_id=?
			AND phase='task_completed_actual_settlement' ORDER BY created_at,id`, scope),
	]);
	if (attempts.some(row => ['pending', 'leased', 'running'].includes(String(row.status)))
		|| reservations.some(row => !['consumed', 'released', 'expired', 'failed'].includes(String(row.state)))) {
		throw new CapacityGovernanceError('reporter_unsettled_workday', 'Reporter requires settled predecessor attempts.', 409);
	}
	const publicAttempts = attempts.map(row => Object.hasOwn(row, 'teardown_result')
		? { ...row, teardown_result: redactSensitiveValue(row.teardown_result) } : row);
	const settlements = ledger.map(row => serializeCapacityLedgerEntryRow(row)!.usageSettlement);
	if (reservations.some(reservation => reservation.state === 'consumed' && !settlements.some(settlement =>
		settlement?.reservationId === reservation.id && settlement.assignmentId === reservation.assignment_id))) {
		throw new CapacityGovernanceError('reporter_unsettled_workday', 'Consumed reservations require their original canonical settlements.', 409);
	}
	const value = { teamId: assignment.teamId, workdayId: assignment.workdayId, nodes, edges,
		attempts: publicAttempts, reservations, usage, settlements };
	return [authorizedContextItemSchema.parse({ ref: assignment.sourceRef, mediaType: 'application/json',
		digest: `sha256:${createHash('sha256').update(canonicalStandardsJson(value)).digest('hex')}`, value })];
}
