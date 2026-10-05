import { assignmentAttemptSchema, assignmentResultSchema } from '@treeseed/sdk/agent-capacity';
import { serializeProviderAssignmentRow } from '../../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';
import { assignment as originalAttempt } from '../fixtures/assignment.ts';

export const candidateCommit = 'b'.repeat(40);
export const assignedAt = '2026-10-02T12:00:00.000Z';
export const completedAt = '2026-10-02T12:00:10.000Z';
export function reviewDecision() {
	return { schemaVersion: 'treeseed.decision/v1', id: 'review-one', projectId: 'project', decisionClass: 'work-review',
		decisionMethod: 'authority', subjectRef: { store: 'git', model: 'source', id: 'candidate', repository: 'source', commit: candidateCommit },
		disposition: 'approved', rationale: 'Exact candidate independently verified against its assigned criteria.',
		authorityRefs: [{ store: 'treedx', model: 'proposal', id: 'proposal', revision: 1, digest: `sha256:${'a'.repeat(64)}` }],
		decidedByRefs: [{ store: 'treedx', model: 'agent', id: 'arbitrary-auditor', revision: 1, digest: `sha256:${'c'.repeat(64)}` }],
		decidedAt: completedAt };
}
export function actorResult() {
	return assignmentResultSchema.parse({ schemaVersion: 'treeseed.assignment-result/v1', id: 'actor-result', assignmentId: 'actor-assignment',
		status: 'completed', summary: 'Isolated native SQL input, not live provider evidence.',
		references: [{ kind: 'git', repository: 'source', commit: candidateCommit }], verification: [], diagnostics: [],
		usage: { elapsedSeconds: 1 }, completedAt: '2026-10-02T11:59:50.000Z' });
}
export function reviewResult(commit: string, path = 'decisions/review-one.mdx') {
	return assignmentResultSchema.parse({ ...actorResult(), id: 'review-result', assignmentId: 'review-assignment',
		references: [{ kind: 'treedx', projectId: 'project', repository: 'repository', commit, path, workspaceId: 'workspace' }], completedAt });
}
export function reviewAssignment() {
	const attempt = assignmentAttemptSchema.parse({ ...structuredClone(originalAttempt), id: 'review-assignment',
		idempotencyKey: 'review-assignment', nodeId: 'review-node', agentClass: 'arbitrary-auditor', predecessorResultIds: ['actor-result'],
		effectiveProfile: { ...originalAttempt.effectiveProfile, activity: 'reviewing', handler: 'reviewer',
			profileRef: reviewDecision().decidedByRefs[0], permissionCeiling: { content: { read: ['proposal', 'decision'], write: ['decision'] }, tools: ['verification', 'source.read'] } },
		grant: { contentRead: reviewDecision().authorityRefs, contentWrite: [{ store: 'treedx', model: 'decision', id: 'review-one', revision: 1, digest: `sha256:${'d'.repeat(64)}`,
			repository: 'repository', path: 'decisions/review-one.mdx' }],
			sourceRead: ['source'], sourceWrite: [], tools: ['verification', 'source.read'] },
		workspace: { mode: 'treedx', workspaceId: 'workspace', repository: 'repository', baseCommit: 'd'.repeat(40), writablePaths: ['decisions/review-one.mdx'] },
		estimate: { expectedSeconds: 30, maximumSeconds: 60 },
		limits: { ...originalAttempt.limits, maximumSeconds: 60 },
		createdAt: assignedAt, deadline: '2026-10-02T12:01:00.000Z' });
	return serializeProviderAssignmentRow({ id: 'review-assignment', membership_id: 'membership', team_id: 'team', project_id: 'project',
		capacity_provider_id: 'provider', project_agent_class_id: 'arbitrary-auditor', mode: 'acting', status: 'running', lease_state: 'leased',
		work_day_id: attempt.workdayId, execution_provider_id: attempt.provider.executionProviderId,
		reservation_id: attempt.reservationId, attempt_count: attempt.attempt, graph_revision: attempt.graphRevision,
		capacity_envelope_json: { teamId: 'team', projectId: 'project', mode: 'acting', requestedSeconds: 60, reservedSeconds: 60,
			workDayId: attempt.workdayId, capacityProviderId: attempt.provider.providerId, executionProviderId: attempt.provider.executionProviderId,
			reservationId: attempt.reservationId, projectAgentClassId: 'arbitrary-auditor' },
		agent_id: 'arbitrary-auditor', execution_node_id: 'review-node', execution_node_revision: 1,
		assignment_attempt_json: attempt, assigned_at: assignedAt, created_at: assignedAt, updated_at: assignedAt })!;
}
