import { describe, expect, it } from 'vitest';
import { CapacityGovernanceError } from '../../src/api/capacity/database.ts';
import { serializeAgentCapacityPlanRow } from '../../src/api/capacity/repositories/agent-capacity-plan.ts';

function row(overrides: Record<string, unknown> = {}) {
	return {
		id: 'plan-a',
		team_id: 'team-a',
		project_id: 'project-a',
		decision_id: 'decision-a',
		status: 'draft',
		scope_hash: 'scope-a',
		allocation_set_id: null,
		work_day_id: null,
		expected_credits: 2,
		high_credits: 3,
		work_units_json: '[]',
		capability_needs_json: '["repo_read"]',
		environment_needs_json: '[]',
		reserves_json: '{}',
		blockers_json: '[]',
		priority_rationale: null,
		review_json: '{}',
		metadata_json: '{}',
		accepted_at: null,
		scheduled_at: null,
		superseded_at: null,
		created_at: '2026-07-18T00:00:00.000Z',
		updated_at: '2026-07-18T00:00:00.000Z',
		...overrides,
	};
}

describe('agent capacity plan repository serialization', () => {
	it('preserves governance, estimate, work-unit, and lifecycle provenance', () => {
		expect(serializeAgentCapacityPlanRow(row())).toMatchObject({
			id: 'plan-a',
			teamId: 'team-a',
			projectId: 'project-a',
			decisionId: 'decision-a',
			status: 'draft',
			scopeHash: 'scope-a',
			expectedCredits: 2,
			highCredits: 3,
			capabilityNeeds: ['repo_read'],
		});
	});

	it.each([
		['unknown status', { status: 'approved' }, 'agent_capacity_plan_status_invalid'],
		['missing team', { team_id: null }, 'agent_capacity_plan_field_invalid'],
		['negative estimate', { expected_credits: -1 }, 'agent_capacity_plan_amount_invalid'],
		['inverted estimate', { expected_credits: 4, high_credits: 3 }, 'agent_capacity_plan_amount_invalid'],
		['corrupt work units', { work_units_json: '{}' }, 'capacity_durable_json_invalid'],
		['corrupt metadata', { metadata_json: '[]' }, 'capacity_durable_json_invalid'],
	])('fails closed for %s', (_label, overrides, code) => {
		expect(() => serializeAgentCapacityPlanRow(row(overrides))).toThrowError(
			expect.objectContaining<Partial<CapacityGovernanceError>>({ code }),
		);
	});
});
