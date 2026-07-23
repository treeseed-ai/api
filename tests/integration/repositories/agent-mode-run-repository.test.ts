import { describe, expect, it } from 'vitest';
import { CapacityGovernanceError } from '../../../src/api/capacity/database.ts';
import { serializeAgentModeRunRow } from '../../../src/api/capacity/repositories/mode-run.ts';

function modeRunRow(overrides: Record<string, unknown> = {}) {
	return {
		id: 'mode-run-a',
		team_id: 'team-a',
		project_id: 'project-a',
		provider_assignment_id: 'assignment-a',
		capacity_provider_id: 'provider-a',
		execution_provider_id: 'codex-a',
		project_agent_class_id: 'class-a',
		agent_id: 'agent-a',
		handler_id: 'handler-a',
		mode: 'planning',
		status: 'running',
		selected_input_json: '{}',
		capacity_envelope_json: '{"teamId":"team-a","projectId":"project-a","mode":"planning"}',
		outputs_json: '{}',
		trace_refs_json: '{}',
		usage_actual_json: '{}',
		validation_json: '{}',
		fallback_reason: null,
		started_at: '2026-07-18T00:00:00.000Z',
		completed_at: null,
		failed_at: null,
		metadata_json: '{}',
		created_at: '2026-07-18T00:00:00.000Z',
		updated_at: '2026-07-18T00:00:00.000Z',
		...overrides,
	};
}

describe('AgentModeRun repository serialization', () => {
	it('preserves canonical assignment, provider, mode, and telemetry provenance', () => {
		expect(serializeAgentModeRunRow(modeRunRow())).toMatchObject({
			id: 'mode-run-a',
			providerAssignmentId: 'assignment-a',
			capacityProviderId: 'provider-a',
			executionProviderId: 'codex-a',
			mode: 'planning',
			status: 'running',
		});
	});

	it.each([
		['missing assignment', { provider_assignment_id: null }, 'agent_mode_run_field_invalid'],
		['unknown mode', { mode: 'observe' }, 'agent_mode_run_mode_invalid'],
		['unknown status', { status: 'complete' }, 'agent_mode_run_status_invalid'],
		['corrupt JSON', { outputs_json: '{' }, 'agent_mode_run_json_invalid'],
		['invalid timestamp', { completed_at: 'eventually' }, 'agent_mode_run_timestamp_invalid'],
		['missing created timestamp', { created_at: null }, 'agent_mode_run_field_invalid'],
	])('fails closed for %s', (_label, overrides, expectedCode) => {
		expect(() => serializeAgentModeRunRow(modeRunRow(overrides))).toThrowError(
			expect.objectContaining<Partial<CapacityGovernanceError>>({ code: expectedCode }),
		);
	});
});
