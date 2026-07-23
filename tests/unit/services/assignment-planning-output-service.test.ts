import { describe, expect, it, vi } from 'vitest';
import { projectCompletedPlanningOutputs } from '../../../src/api/capacity/services/assignment-planning-output-service.ts';

const assignment = {
	id: 'assignment-a', teamId: 'team-a', projectId: 'project-a', decisionId: 'decision-a',
	agentId: 'engineer', mode: 'planning', decisionInput: { input: { planningInputRequestId: 'request-a' } },
} as never;

const estimate = {
	id: 'estimate-a', teamId: 'team-a', projectId: 'project-a', decisionId: 'decision-a', proposalId: 'proposal-a',
	agentClass: 'engineering', agentId: 'engineer', minCredits: 1, expectedCredits: 2, maxCredits: 3,
	confidence: 'medium', riskLevel: 'low', assumptions: [], blockers: [], dependencies: [],
	expectedOutputs: [{ outputType: 'implementation', required: true }], acceptanceCriteria: ['tests pass'], completionEvidence: [],
	createdAt: '2026-07-18T00:00:00.000Z', metadata: {},
};

describe('assignment planning output projection', () => {
	it('persists a correlated structured estimate once as submitted planning evidence', async () => {
		const create = vi.fn(async (_decisionId: string, input: Record<string, unknown>) => ({ ...estimate, ...input }));
		const run = vi.fn(async () => undefined);
		const store = { run, getStructuredAgentEstimate: vi.fn(async () => null), createStructuredAgentEstimate: create };
		await expect(projectCompletedPlanningOutputs(store as never, assignment, { output: { metadata: { structuredEstimate: estimate } } }))
			.resolves.toMatchObject({ id: 'estimate-a', status: 'submitted', metadata: { assignmentId: 'assignment-a' } });
		expect(create).toHaveBeenCalledWith('decision-a', expect.objectContaining({ status: 'submitted', recordMetadata: { source: 'validated_assignment_planning_output', assignmentId: 'assignment-a' } }));
		expect(run).toHaveBeenCalledWith(expect.stringContaining(`UPDATE planning_input_requests SET status = 'complete'`), expect.arrayContaining(['request-a', 'team-a', 'project-a']));
	});

	it('returns the assignment-owned estimate on replay and rejects cross-scope output', async () => {
		const existing = { ...estimate, status: 'submitted', metadata: { assignmentId: 'assignment-a' } };
		const store = { run: vi.fn(async () => undefined), getStructuredAgentEstimate: vi.fn(async () => existing), createStructuredAgentEstimate: vi.fn() };
		await expect(projectCompletedPlanningOutputs(store as never, assignment, { output: { metadata: { structuredEstimate: estimate } } })).resolves.toBe(existing);
		expect(store.createStructuredAgentEstimate).not.toHaveBeenCalled();
		await expect(projectCompletedPlanningOutputs(store as never, assignment, { output: { metadata: { structuredEstimate: { ...estimate, projectId: 'project-b' } } } }))
			.rejects.toMatchObject({ code: 'assignment_planning_estimate_scope_invalid' });
	});
});
