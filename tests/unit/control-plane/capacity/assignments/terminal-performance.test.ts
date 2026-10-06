import { describe, expect, it } from 'vitest';
import type { DurableProviderAssignment } from '../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';
import { terminalPerformance } from '../../../../../src/api/capacity/services/capacity/assignments/lifecycle/completion/assignment-terminal-performance.ts';
import { capacityUsageInsertOperation } from '../../../../../src/api/capacity/services/capacity/accounting/usage-report-service.ts';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { assignment as originalAttempt } from '../execution/fixtures/assignment.ts';

describe('terminal assignment performance', () => {
	it('uses the committed aggregate usage rather than an empty completion payload', () => {
		const assignment = {
			id: 'assignment-1', workDayId: 'workday-1', teamId: 'team-1', projectId: 'project-1',
			projectAgentClassId: 'project-1:architect', agentId: 'sdk/architect', mode: 'planning',
			handlerId: 'writer', capacityProviderId: 'provider-1', executionProviderId: 'codex-implementation',
			attemptCount: 0, metadata: {}, capacityEnvelope: {},
		} as unknown as DurableProviderAssignment;
		const performance = terminalPerformance(assignment, { completion: { disposition: 'completed' } },
			'completed', '2026-09-20T00:00:00.000Z', {
				active_seconds: 50, elapsed_seconds: 54, input_tokens: 455633,
				cached_input_tokens: 396544, reasoning_tokens: 292, output_tokens: 1785,
			});
		expect(performance.actual).toMatchObject({ activeSeconds: 50, elapsedSeconds: 54,
			inputTokens: 455633, cachedInputTokens: 396544, reasoningTokens: 292, outputTokens: 1785 });
	});
	it('attributes a governance review to the immutable effective activity, not its planning workday mode', () => {
		const assignment = {
			id: 'review-1', workDayId: 'workday-1', teamId: 'team-1', projectId: 'project-1',
			projectAgentClassId: 'project-1:reviewer', agentId: 'sdk/reviewer', mode: 'planning',
			handlerId: 'writer', capacityProviderId: 'provider-1', executionProviderId: 'codex-implementation',
			attemptCount: 0, metadata: { activityProfile: 'planning' }, capacityEnvelope: {},
			assignmentAttempt: { effectiveProfile: { activity: 'reviewing' } },
		} as unknown as DurableProviderAssignment;
		const performance = terminalPerformance(assignment, { completion: { disposition: 'completed' } },
			'completed', '2026-09-22T00:00:00.000Z');
		expect(performance.activityProfile).toBe('reviewing');
		expect(performance.taskSignature).toBe('project-1:reviewer:reviewing');
	});
	it('commits the same exact activity into usage history despite a provider-supplied signature', () => {
		const attempt = assignmentAttemptSchema.parse({ ...originalAttempt, id: 'review-1', idempotencyKey: 'review-1',
			teamId: 'team-1', projectId: 'project-1', workdayId: 'workday-1',
			effectiveProfile: { ...originalAttempt.effectiveProfile, activity: 'reviewing' } });
		const operation = capacityUsageInsertOperation({ teamId: 'team-1', membershipId: 'member-1',
			reservationId: 'reservation-1', assignmentId: 'review-1', idempotencyKey: 'usage-1',
			usageDimension: 'aggregate', accountingMode: 'aggregate', activeSeconds: 56, elapsedSeconds: 56,
			source: 'provider_assignment_complete', usageActual: { taskSignature: 'incorrect:planning' } },
		{ project_agent_class_id: 'project-1:reviewer', mode: 'planning',
			assignment_attempt_json: JSON.stringify(attempt) },
		{ id: 'usage:review-1:1:aggregate', idempotencyKey: 'usage-1', assignmentAttempt: attempt.attempt,
			usageDimension: 'aggregate' }, { column: 'settlement_token', token: 'token-1' }, '2026-09-22T00:00:00.000Z');
		expect(operation.params?.[5]).toBe('project-1:reviewer:reviewing');
	});
});
