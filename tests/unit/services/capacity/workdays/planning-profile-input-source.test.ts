import { describe,expect,it } from 'vitest';
import { isTransientCapacityEvent,projectsToDiscussionLifecycle } from '../../../../../src/api/capacity/services/capacity/workdays/content/workday-event-service.ts';
import { resolvePlanningDemandSource } from '../../../../../src/api/capacity/services/support/planning-demand-source.ts';

describe('planning profile input source', () => {
	it('keeps transient deltas and granular mode activity out of durable Discussion lifecycle content', () => {
		expect(isTransientCapacityEvent('response.output_text.token_delta')).toBe(true);
		expect(projectsToDiscussionLifecycle({ id: 'activity:mode-run:digest', eventType: 'tool.completed' } as never)).toBe(false);
		expect(projectsToDiscussionLifecycle({ id: 'provider-runtime:assignment:completed', eventType: 'provider.assignment.completed' } as never)).toBe(true);
	});
	it('compiles an exact parent-contained conversation from its canonical invocation', async () => {
		const invocation = {
			id: 'invocation-a', decision_id: null, priority_class: 'workday-blocking-agent',
			trigger_kind: 'discussion', parent_workday_id: 'run-a', parent_assignment_id: 'assignment-parent',
			handoff_root_id: 'invocation-root', handoff_parent_id: 'invocation-parent', handoff_depth: 1,
			subject_digest: 'subject-a', content_refs_json: JSON.stringify(['discussions/topic/messages/message-a.mdx', 'knowledge/context.mdx']),
			metadata_json: JSON.stringify({ discussionId: 'topic', sourceMessageId: 'message-a', sourceCommit: 'commit-a' }),
		};
		const store = { async first(sql: string) { return sql.includes('agent_invocation_requests') ? invocation : null; }, async all() { return []; } } as never;
		const result = await resolvePlanningDemandSource(
			store,
			{ id: 'run-a', teamId: 'team-a', parameters: { providerSourceClosureDigest: 'closure-a' } } as never,
			{ id: 'project-a' } as never,
			{ slug: 'guide-steward', activityType: 'chat', projectAgentClassId: 'class-a', handler: 'chat' } as never,
			{ objective: 'Respond.', artifactKind: 'discussion_message', subjectModel: 'discussion', subjectId: 'topic', includeWorkdayArtifacts: true },
		);
		expect(result).toMatchObject({
			sourceId: 'invocation-a', priority: 300,
			payload: {
				agentInvocationId: 'invocation-a', discussionId: 'topic', discussionMessageId: 'message-a',
				subjectPath: 'discussions/topic/messages/message-a.mdx', contentBaseRef: 'commit-a',
				parentWorkdayId: 'run-a', parentAssignmentId: 'assignment-parent', handoffDepth: 1,
				contextPack: { refs: ['discussions/topic/messages/message-a.mdx', 'knowledge/context.mdx'] }, providerSourceClosureDigest: 'closure-a',
			},
		});
	});

	it('routes a scoped input only to its requested activity profile', async () => {
		const row = { id: 'request-1', decision_id: 'decision-1', prompt: 'Review the page.', scope_hash: 'scope-1', metadata_json: JSON.stringify({ agentId: 'reviewer', activityType: 'reviewing', assignmentInput: { chapter: 'foundation', subjectModel: 'knowledge', subjectId: 'guide.foundation.purpose' } }) };
		const store = { async all(sql: string) { return sql.includes('agent_invocation_requests') ? [row] : []; }, async first() { return null; } } as never;
		const run = { id: 'run-1', teamId: 'team-1' } as never;
		const project = { id: 'project-1' } as never;
		const base = { slug: 'reviewer', projectAgentClassId: 'class-1', handler: 'writer' } as never;
		const intent = { objective: 'Review.', artifactKind: 'planning_note', subjectModel: 'objective', subjectId: 'core', includeWorkdayArtifacts: true };
		await expect(resolvePlanningDemandSource(store, run, project, { ...base, activityType: 'reviewing' }, intent)).resolves.toMatchObject({
			sourceType: 'planning-input', payload: { chapter: 'foundation', intent: { chapter: 'foundation', subjectModel: 'knowledge', subjectId: 'guide.foundation.purpose' } },
		});
		await expect(resolvePlanningDemandSource(store, run, project, { ...base, activityType: 'planning' }, intent)).resolves.toMatchObject({ sourceType: 'idle-intent' });
	});
});
