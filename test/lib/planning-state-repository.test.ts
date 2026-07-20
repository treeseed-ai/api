import { describe, expect, it } from 'vitest';
import { CapacityGovernanceError } from '../../src/api/capacity/database.ts';
import {
	serializeDecisionExecutionInputRow,
	serializeDecisionPlanningStatusRow,
	serializePlanningInputRequestRow,
} from '../../src/api/capacity/repositories/planning-state.ts';

const timestamps = { created_at: '2026-07-18T00:00:00.000Z', updated_at: '2026-07-18T00:00:00.000Z' };

describe('planning state repository serialization', () => {
	it('strictly reconstructs all three planning provenance records', () => {
		expect(serializeDecisionPlanningStatusRow({ id: 'status-a', team_id: 'team-a', project_id: 'project-a', decision_id: 'decision-a', human_approval_state: 'approved', execution_readiness: 'ready', planning_inputs_status: 'complete', scope_hash: 'scope-a', metadata_json: '{}', ready_at: timestamps.created_at, stale_at: null, stale_reason: null, ...timestamps })).toMatchObject({ executionReadiness: 'ready', planningInputsStatus: 'complete' });
		expect(serializePlanningInputRequestRow({ id: 'request-a', team_id: 'team-a', project_id: 'project-a', decision_id: 'decision-a', project_agent_class_id: null, mode: 'planning', status: 'requested', scope_hash: 'scope-a', prompt: null, response_json: '{}', metadata_json: '{}', requested_at: timestamps.created_at, completed_at: null, stale_at: null })).toMatchObject({ mode: 'planning', status: 'requested' });
		expect(serializeDecisionExecutionInputRow({ id: 'input-a', team_id: 'team-a', project_id: 'project-a', decision_id: 'decision-a', project_agent_class_id: 'class-a', mode: 'acting', status: 'accepted', scope_hash: 'scope-a', input_json: '{"teamId":"team-a","projectId":"project-a","projectAgentClassId":"class-a","mode":"acting","input":{}}', metadata_json: '{}', accepted_at: timestamps.created_at, revision_requested_at: null, stale_at: null, ...timestamps })).toMatchObject({ mode: 'acting', status: 'accepted', projectAgentClassId: 'class-a' });
	});

	it.each([
		['readiness', () => serializeDecisionPlanningStatusRow({ id: 'status-a', team_id: 'team-a', project_id: 'project-a', decision_id: 'decision-a', execution_readiness: 'running', planning_inputs_status: 'complete', scope_hash: 'scope-a', metadata_json: '{}', ...timestamps }), 'decision_execution_readiness_invalid'],
		['request mode', () => serializePlanningInputRequestRow({ id: 'request-a', team_id: 'team-a', project_id: 'project-a', decision_id: 'decision-a', mode: 'observe', status: 'requested', scope_hash: 'scope-a', response_json: '{}', metadata_json: '{}', requested_at: timestamps.created_at }), 'planning_input_mode_invalid'],
		['execution status', () => serializeDecisionExecutionInputRow({ id: 'input-a', team_id: 'team-a', project_id: 'project-a', decision_id: 'decision-a', project_agent_class_id: 'class-a', mode: 'acting', status: 'approved', scope_hash: 'scope-a', input_json: '{}', metadata_json: '{}', ...timestamps }), 'decision_execution_input_status_invalid'],
		['execution JSON', () => serializeDecisionExecutionInputRow({ id: 'input-a', team_id: 'team-a', project_id: 'project-a', decision_id: 'decision-a', project_agent_class_id: 'class-a', mode: 'acting', status: 'accepted', scope_hash: 'scope-a', input_json: '[]', metadata_json: '{}', ...timestamps }), 'capacity_durable_json_invalid'],
	])('fails closed for invalid %s', (_label, action, code) => {
		expect(action).toThrowError(expect.objectContaining<Partial<CapacityGovernanceError>>({ code }));
	});
});
