import { assignmentAttemptSchema, type AssignmentAttempt } from '@treeseed/sdk/agent-capacity';
import { assignment } from '../fixtures/assignment.ts';
import { admitLivingExecutionAssignment } from '../../../../../../src/api/capacity/services/capacity/assignments/admission/living-execution-admission.ts';

// Complete isolated immutable input. These values are not live approval,
// provider supply, native usage, or a claim that atomic admission has run.
export function replayAttempt(): AssignmentAttempt {
	const proposal = { store: 'treedx', model: 'proposal', id: 'proposal', revision: 1,
		digest: `sha256:${'a'.repeat(64)}`, repository: 'library', commit: 'a'.repeat(40), path: 'proposals/proposal.mdx' };
	const decision = { ...proposal, model: 'decision', id: 'decision', path: 'decisions/decision.mdx' };
	return assignmentAttemptSchema.parse({ ...structuredClone(assignment), agentClass: 'configured-builder',
		sourceRef: proposal, authorityRefs: [decision], requiredCapabilities: ['code-change'],
		effectiveProfile: { ...assignment.effectiveProfile, profileRef: { ...proposal, model: 'agent', id: 'configured-builder', path: 'agents/builder.yaml' },
			permissionCeiling: { content: { read: ['proposal', 'decision'], write: [] }, tools: ['source.read', 'source.write'] } },
		grant: { ...assignment.grant, contentRead: [proposal, decision] }, contextRefs: [proposal, decision],
		workspace: { ...assignment.workspace, branch: 'simulation/fixture/workday/assignment', writablePaths: ['src'] } });
}

export type ReplayChange = { name: string; change: (value: AssignmentAttempt) => void };
export const replayChanges: ReplayChange[] = [
	{ name: 'grant or mutable workspace', change: value => { value.grant.sourceWrite.push('unassigned-repository'); value.workspace = {
		...value.workspace, mode: 'git', repository: 'treeseed-ai/sdk', baseCommit: 'd'.repeat(40), branch: 'simulation/fixture/workday/assignment', writablePaths: ['.'] }; } },
	{ name: 'profile handler or parameters', change: value => { value.effectiveProfile.handler = 'different-handler'; value.effectiveProfile.parameters = { alternate: true }; } },
	{ name: 'source and Decision authority', change: value => { value.sourceRef.commit = 'f'.repeat(40); value.authorityRefs[0]!.digest = `sha256:${'f'.repeat(64)}`; } },
	{ name: 'provider build and original deadline', change: value => { value.provider.runtimeBuild = `sha256:${'f'.repeat(64)}`; value.deadline = '2026-09-15T00:00:00.000Z'; } },
	{ name: 'graph context and predecessor custody', change: value => { value.graphRevision += 1; value.predecessorResultIds = ['unassigned-result']; value.contextRefs = []; } },
	{ name: 'accepted estimate or reserved limit', change: value => { value.estimate.maximumSeconds += 1; value.limits.maximumSeconds += 1; } },
];

export function replayInput(value: AssignmentAttempt): Parameters<typeof admitLivingExecutionAssignment>[1] {
	return { assignment: value, principal: { teamId: 'team', capacityProviderId: 'provider', membershipId: 'membership' } as Parameters<typeof admitLivingExecutionAssignment>[1]['principal'],
		allocation: { admitted: true, allocatedSeconds: value.limits.maximumSeconds, opportunity: { phase: 'acting' } } as Parameters<typeof admitLivingExecutionAssignment>[1]['allocation'],
		accountingLimits: { modelConfigurationId: 'terra-medium', dailyActiveSecondsLimit: 28800, capabilityLimits: { 'code-change': { dailyActiveSecondsLimit: 28800 } } },
		projectAgentClassId: 'configured-builder', providerSessionId: 'session', executionProviderId: 'codex', laneId: 'work', lanePurpose: 'workday',
		executionKind: 'workday', workdayConcurrencyLimit: 1, predecessorResults: [], treedxProxyHandle: {}, now: value.createdAt };
}
