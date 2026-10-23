import assert from 'node:assert/strict';
import { expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { stringify } from 'yaml';
import { assignmentAttemptSchema, assignmentResultSchema, type ExactEntityReference, type AgentDefinition, type ExecutionNode } from '@treeseed/sdk/agent-capacity';
import { assignment as original } from '../../../capacity/execution/fixtures/assignment.ts';
import { readyContributionProposal, nativeProposalProfileInputs } from './ready-proposal-fixture.ts';
import type { relationAuthoringDatabase } from '../../../knowledge/workspaces/architecture/relation-authoring-fixture.ts';
import { verifyAssignmentContent, recordAssignmentContentIntegration } from '../../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-content-readback.ts';

/** Controlled governance inputs, not live agents, estimates, settlement or usage. */
export function nativeSubscriberInputs(configured: Record<string, AgentDefinition>, projectId: string, id: string, canonicalSupply: boolean) {
	const { profileInputs, closeout } = nativeProposalProfileInputs(configured, projectId, canonicalSupply);
	const subscribers = profileInputs.slice(0, 2); assert.equal(subscribers.length, 2);
	for (const [index, profile] of subscribers.entries()) {
		const acting = profile.definition.activityProfiles.acting; assert.ok(acting);
		const { dependsOn: _dependency, ...independent } = acting;
		profile.definition.groupIds = ['portfolio-runtime'];
		for (const activity of ['chat', 'planning', 'estimating', 'acting', 'reviewing'] as const) {
			profile.definition.activityProfiles[activity] = { ...structuredClone(independent),
				...(activity === 'acting' && index === 1 ? { dependsOn: { agents: [subscribers[0]!.definition.id.split('/').at(-1)!] } } : {}) };
		}
		profile.definition.activityProfiles.estimating!.permissions.content.write = ['proposal'];
		profile.raw = `---\n${stringify(profile.definition)}---\n`;
	}
	const base = readyContributionProposal(), item = base.executionPlan.workItems[0]!;
	const declaration = { ...base, id, projectId, executionPlan: { workItems: subscribers.map((profile, index) => ({
		...structuredClone(item), id: index ? 'peer-contribution' : item.id,
		objective: `Controlled own contribution from ${profile.definition.name}.`,
		estimateRef: { ...item.estimateRef, id: `controlled-estimate-${id}-${index}` },
		...(canonicalSupply ? { requiredCapabilities: ['treeseed.research.verification'],
			requestedPermissions: { content: { read: ['proposal', 'decision'], write: [] }, tools: [] } } : {}),
	})) } };
	return { declaration, profileInputs, subscribers, closeout };
}

/** Supplied completed attempts/results enter the ORIGINAL exact read-back and
 * receipt writer. Never seed an integration receipt or an accepted Decision. */
export async function recordNativeSubscriberInputs(f: Awaited<ReturnType<typeof relationAuthoringDatabase>>,
	input: ReturnType<typeof nativeSubscriberInputs>, sourceRef: ExactEntityReference, open: Set<string>) {
	assert.ok(sourceRef.repository && sourceRef.commit && sourceRef.path);
	const now = new Date().toISOString(), ids: string[] = [];
	for (const [index, profile] of input.subscribers.entries()) {
		const item = input.declaration.executionPlan.workItems[index]!;
		const created = await f.client.workspaces.create(sourceRef.repository, { baseRef: sourceRef.commit,
			branchName: `refs/heads/controlled-estimate-${randomUUID()}`, mode: 'writable', allowedPaths: [sourceRef.path] });
		assert.ok(created && typeof created === 'object' && 'workspaceId' in created && typeof created.workspaceId === 'string');
		const workspaceId = created.workspaceId; open.add(workspaceId);
		const estimating = profile.definition.activityProfiles.estimating!;
		const attempt = assignmentAttemptSchema.parse({ ...original, id: item.estimateRef.id, idempotencyKey: item.estimateRef.id,
			projectId: input.declaration.projectId, agentClass: profile.definition.agentClass, workItemId: undefined, sourceRef,
			status: 'completed', createdAt: now, deadline: new Date(Date.parse(now) + Date.parse(original.deadline) - Date.parse(original.createdAt)).toISOString(),
			effectiveProfile: { ...original.effectiveProfile, handler: estimating.handler, prompt: estimating.prompt,
				activity: 'estimating', permissionCeiling: estimating.permissions,
				profileRef: { store: 'treedx', model: 'agent', id: profile.definition.id, repository: sourceRef.repository, commit: sourceRef.commit, path: profile.path } },
			workspace: { mode: 'treedx', workspaceId, repository: sourceRef.repository, baseCommit: sourceRef.commit, writablePaths: [sourceRef.path] },
			grant: { contentRead: [sourceRef], contentWrite: [sourceRef], sourceRead: [], sourceWrite: [], tools: [] } });
		const result = assignmentResultSchema.parse({ schemaVersion: 'treeseed.assignment-result/v1', id: `result-${attempt.id}`,
			assignmentId: attempt.id, status: 'completed', summary: 'Controlled native governance INPUT, no live completion or usage claimed.',
			references: [{ kind: 'treedx', projectId: attempt.projectId, repository: sourceRef.repository,
				commit: sourceRef.commit, path: sourceRef.path, workspaceId }], verification: [], diagnostics: [], usage: { elapsedSeconds: 0 }, completedAt: now });
		await f.query(`INSERT INTO capacity_provider_assignments
			(id,membership_id,team_id,project_id,capacity_provider_id,project_agent_class_id,mode,status,agent_id,
			assignment_attempt_json,assignment_result_json,completed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			[attempt.id, 'controlled-membership', 'team', attempt.projectId, 'controlled-provider', `${attempt.projectId}:${attempt.agentClass}`,
				'planning', 'completed', profile.definition.id, JSON.stringify(attempt), JSON.stringify(result), now, now, now]);
		const scope = { id: attempt.id, teamId: 'team', projectId: attempt.projectId, agentId: profile.definition.id, assignmentAttempt: attempt };
		const references = await verifyAssignmentContent(f.store, scope, result);
		await recordAssignmentContentIntegration(f.store, scope, result, references);
		await f.client.workspaces.close(workspaceId); open.delete(workspaceId); ids.push(attempt.id);
	}
	return ids.sort();
}

export function expectNativeSubscriberGraph(input: ReturnType<typeof nativeSubscriberInputs>, nodes: ExecutionNode[]) {
	expect(nodes.filter(node => node.pairRole === 'actor')).toHaveLength(2);
	expect(nodes.filter(node => node.pairRole === 'reviewer')).toHaveLength(2);
	for (const [index, subscriber] of input.subscribers.entries()) {
		const workItemId = input.declaration.executionPlan.workItems[index]!.id;
		const actor = nodes.find(node => node.workItemId === workItemId && node.pairRole === 'actor'); assert.ok(actor);
		const reviewer = nodes.find(node => node.workItemId === workItemId && node.pairRole === 'reviewer'); assert.ok(reviewer);
		expect(actor.authorityRefs).toContainEqual(expect.objectContaining({ model: 'agent', id: subscriber.definition.id }));
		expect(reviewer.authorityRefs).toContainEqual(expect.objectContaining({ model: 'agent', id: input.subscribers[1 - index]!.definition.id }));
	}
}
