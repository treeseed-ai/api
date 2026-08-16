import { describe,expect,it } from 'vitest';
import { CapacityGovernanceError } from '../../../../../src/api/capacity/database.ts';
import { serializeProviderAssignmentRow } from '../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';
import { commitCapacityAdmission } from '../../../../../src/api/capacity/services/support/admission-service.ts';
import { capacityAdmissionInput,createCapacityAdmissionTestHarness,seedCapacityAdmissionDependencies } from '../../../../support/capacity/admission.ts';

function assignmentRow(overrides: Record<string, unknown> = {}) {
	return {
		id: 'assignment-a',
		membership_id: 'membership-a',
		state_version: 1,
		team_id: 'team-a',
		project_id: 'project-a',
		capacity_provider_id: 'provider-a',
		project_agent_class_id: 'class-a',
		mode: 'planning',
		status: 'pending',
		lease_state: 'unleased',
		workspace_context_json: '{}',
		capacity_envelope_json: '{"teamId":"team-a","projectId":"project-a","mode":"planning"}',
		decision_input_json: '{"teamId":"team-a","projectId":"project-a","projectAgentClassId":"class-a","mode":"planning","input":{}}',
		allowed_outputs_json: '{}',
		explanation_json: '{}',
		lifecycle_output_json: '{}',
		treedx_proxy_handle_json: '{}',
		metadata_json: '{}',
		created_at: '2026-07-18T00:00:00.000Z',
		updated_at: '2026-07-18T00:00:00.000Z',
		...overrides,
	};
}

describe('ProviderAssignmentRepository serialization', () => {
	it('preserves durable CAS and membership provenance', () => {
		expect(serializeProviderAssignmentRow(assignmentRow())).toMatchObject({
			id: 'assignment-a',
			membershipId: 'membership-a',
			stateVersion: 1,
			mode: 'planning',
		});
	});

	it('fails closed for corrupt JSON', () => {
		expect(() => serializeProviderAssignmentRow(assignmentRow({ metadata_json: '{' }))).toThrowError(
			expect.objectContaining<Partial<CapacityGovernanceError>>({ code: 'provider_assignment_json_invalid' }),
		);
	});

	it.each([
		['unknown mode', { mode: 'observe' }, 'provider_assignment_mode_invalid'],
		['invalid CAS version', { state_version: 0 }, 'provider_assignment_state_version_invalid'],
		['invalid lease expiry', { lease_expires_at: 'eventually' }, 'provider_assignment_timestamp_invalid'],
		['invalid status', { status: 'abandoned' }, 'provider_assignment_status_invalid'],
		['invalid lease state', { lease_state: 'claimed' }, 'provider_assignment_lease_state_invalid'],
		['invalid synthesis source', { synthesized_from: 'capacity_workday' }, 'provider_assignment_synthesis_source_invalid'],
		['invalid attempt count', { attempt_count: -1 }, 'provider_assignment_attempt_count_invalid'],
	])('fails closed for %s', (_label, overrides, expectedCode) => {
		expect(() => serializeProviderAssignmentRow(assignmentRow(overrides))).toThrowError(
			expect.objectContaining<Partial<CapacityGovernanceError>>({ code: expectedCode }),
		);
	});
});

describe('invocation assignment admission',()=>{
	it('binds the exact invocation in the same atomic admission batch',async()=>{
		const {database,store}=createCapacityAdmissionTestHarness();
		try{
			await store.ensureInitialized(); const now=new Date().toISOString();
			await seedCapacityAdmissionDependencies(store,now);
			await store.run(`INSERT INTO workday_capacity_envelopes (id,team_id,project_id,allocation_set_id,status,started_at,envelope_json,metadata_json,created_at,updated_at) VALUES ('workday-a','team-a','project-a','allocation-a','active',?,'{"availableSeconds":10,"totalSeconds":10}','{}',?,?)`,[now,now,now]);
			await store.run(`INSERT INTO agent_invocation_requests (id,team_id,project_id,project_agent_class_id,agent_id,mode,execution_kind,trigger_kind,status,scope_hash,blocking_state_json,available_at,idempotency_key,request_digest,requested_at,updated_at) VALUES ('invocation-a','team-a','project-a','class-a','agent-a','planning','conversation','discussion','admitted','scope-a','{"code":"communication_admission_claimed"}',?,'invoke-a','digest-a',?,?)`,[now,now,now]);
			const input=capacityAdmissionInput(1,0,now);
			const admitted=await commitCapacityAdmission(store,{idempotencyKey:'admit-invocation-a',admission:input,reservationId:'reservation-a',assignmentId:'assignment-a',assignment:{projectAgentClassId:'class-a',workDayId:'workday-a',providerSessionId:null,invocationId:'invocation-a',executionKind:'conversation',triggerKind:'discussion'}});
			expect(admitted.assignment.id).toBe('assignment-a');
			expect(await store.first(`SELECT status,assignment_id,blocking_state_json FROM agent_invocation_requests WHERE id='invocation-a'`)).toEqual({status:'running',assignment_id:'assignment-a',blocking_state_json:'{}'});
		}finally{await database.close();}
	});
});
