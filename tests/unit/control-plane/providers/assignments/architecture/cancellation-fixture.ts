import { readFileSync } from 'node:fs';
import { assignmentAttemptSchema, emptyCapacityBudget } from '@treeseed/sdk/agent-capacity';
import { splitPostgresSqlStatements } from '../../../../../../src/api/persistence/postgres-sql-statements.ts';
import { ProviderAssignmentRepository, serializeProviderAssignmentRow } from '../../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';
import { frozenAttempt, settlementDatabase } from '../../../capacity/accounting/architecture/settlement-fixture.ts';

export const cancelNow = '2026-10-02T21:00:04.000Z';
export function recoveryAssignment(started: boolean) {
	const budget = emptyCapacityBudget(frozenAttempt.deadline, frozenAttempt.limits.maximumSeconds);
	const result = serializeProviderAssignmentRow({ id: frozenAttempt.id, team_id: frozenAttempt.teamId,
		project_id: frozenAttempt.projectId, membership_id: 'membership', capacity_provider_id: 'provider',
		project_agent_class_id: frozenAttempt.agentClass, work_day_id: frozenAttempt.workdayId, mode: 'acting',
		status: 'leased', lease_state: 'leased', lease_token: 'lease-token', lease_expires_at: frozenAttempt.deadline,
		execution_kind: 'work', trigger_kind: 'graph', reservation_id: frozenAttempt.reservationId, attempt_count: 1,
		state_version: 1, execution_node_id: frozenAttempt.nodeId, execution_node_revision: frozenAttempt.nodeRevision,
		assignment_attempt_json: JSON.stringify({ ...frozenAttempt, status: 'created' }), created_at: frozenAttempt.createdAt,
		updated_at: frozenAttempt.createdAt, capacity_envelope_json: JSON.stringify({ teamId: 'team', projectId: 'project',
			mode: 'acting', budget: { ...budget, time: { ...budget.time,
				executionStartedAt: started ? frozenAttempt.createdAt : null, executionDeadlineAt: started ? frozenAttempt.deadline : null } } }) });
	if (!result) throw new Error('Missing isolated full assignment');
	return result;
}
/** Isolated original SQL and parsed attempt. Clock and usage inputs are not
 * provider-generated evidence, actual admission or a physical teardown receipt. */
export async function cancellationDatabase(status = 'leased', started = false) {
	const fixture = await settlementDatabase();
	try {
		const original = splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0000_control_plane.sql', 'utf8'));
		for (const table of ['treedx_proxy_handles', 'teams', 'capacity_provider_availability_sessions',
			'capacity_audit_events', 'treedx_project_proxy_audit', 'agent_fallback_outputs', 'agent_invocation_requests']) {
			const ddl = original.filter(sql => sql.startsWith(`CREATE TABLE "${table}" (`));
			if (ddl.length !== 1) throw new Error(`Missing original ${table} DDL`);
			await fixture.db.exec(ddl[0]!);
		}
		const attempt = assignmentAttemptSchema.parse({ ...frozenAttempt, status: 'created' });
		const budget = emptyCapacityBudget(attempt.deadline, attempt.limits.maximumSeconds);
		const time = { ...budget.time, authorityDeadlineAt: attempt.deadline,
			executionStartedAt: started ? attempt.createdAt : null, executionDeadlineAt: started ? attempt.deadline : null };
		await fixture.query(`UPDATE capacity_provider_assignments SET reservation_id='reservation',status=?,lease_state=?,
			lease_token=?,lease_expires_at=?,state_version=1,execution_node_revision=1,assignment_result_json=NULL,
			completed_at=NULL,claimed_at=?,created_at=?,assignment_attempt_json=?,capacity_envelope_json=?,metadata_json=?,
			workspace_context_json='{}',treedx_proxy_handle_json='{}',lifecycle_output_json='{}' WHERE id=?`,
			[status, status === 'leased' ? 'leased' : 'released', status === 'leased' ? 'lease-token' : null,
				status === 'leased' ? attempt.deadline : null, attempt.createdAt, attempt.createdAt, JSON.stringify(attempt),
				JSON.stringify({ teamId: 'team', projectId: 'project', mode: 'acting', budget: { ...budget, time } }),
				JSON.stringify({ operationalState: started ? 'executing' : 'preparing' }), attempt.id]);
		await fixture.query("UPDATE execution_nodes SET status='running',agent_class=?,node_revision=1 WHERE id='report-node'", [attempt.agentClass]);
		const assignment = await new ProviderAssignmentRepository(fixture.owner).get('team', attempt.id);
		if (!assignment) throw new Error('Missing isolated parsed cancellation assignment');
		return { ...fixture, attempt, assignment };
	} catch (error) { await fixture.db.close(); throw error; }
}
