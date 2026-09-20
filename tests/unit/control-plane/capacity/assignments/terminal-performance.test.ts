import { describe, expect, it } from 'vitest';
import type { DurableProviderAssignment } from '../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';
import { terminalPerformance } from '../../../../../src/api/capacity/services/capacity/assignments/lifecycle/completion/assignment-terminal-performance.ts';

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
});
