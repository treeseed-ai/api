import { describe, expect, it } from 'vitest';
import { cancelArchivedDiscussionCapacity, discussionContinuationReplyEvidence, discussionInvocationParent, discussionRouteFailure } from '../../../src/api/routes/discussions/discussions.ts';

describe('Discussion route errors', () => {
	it('cancels only exact archived-discussion invocations and requests active assignment cancellation', async () => {
		const operations: Array<{ query: string; params: unknown[] }> = [];
		const store = {
			async all(query: string) {
				if (query.includes('agent_invocation_requests')) return [
					{ id: 'invocation-a', status: 'blocked', metadata_json: JSON.stringify({ discussionId: 'topic-a' }) },
					{ id: 'invocation-other', status: 'blocked', metadata_json: JSON.stringify({ discussionId: 'topic-a-old' }) },
				];
				return [{ id: 'assignment-a', team_id:'team-a', invocation_id:'invocation-a',status:'leased',lease_state:'leased',metadata_json: JSON.stringify({ preserved: true }) }];
			},
			async batch(input: typeof operations) { operations.push(...input); },
		};
		await expect(cancelArchivedDiscussionCapacity(store, 'project-a', 'topic-a', '2026-08-14T12:00:00.000Z')).resolves.toEqual({
			invocationIds: ['invocation-a'], assignmentIds: ['assignment-a'],
		});
		expect(operations).toHaveLength(2);
		expect(operations[0].params).toContain('invocation-a');
		expect(JSON.parse(String(operations[1].params[0]))).toEqual({ preserved: true, cancellationRequested: true, cancellationReason: 'discussion_archived', discussionId: 'topic-a' });
	});

	it('terminally cancels an unleased admitted assignment instead of leaving it leasable',async()=>{
		const cancelled:string[]=[];const writes:Array<{query:string;params:unknown[]}>=[];
		const store={
			async all(query:string){return query.includes('agent_invocation_requests')
				?[{id:'invocation-a',status:'admitted',metadata_json:JSON.stringify({discussionId:'topic-a'})}]
				:[{id:'assignment-a',team_id:'team-a',invocation_id:'invocation-a',status:'pending',lease_state:'unleased',metadata_json:'{}'}];},
			async batch(input:typeof writes){writes.push(...input);},async run(query:string,params:unknown[]){writes.push({query,params});},
		};
		await cancelArchivedDiscussionCapacity(store,'project-a','topic-a','2026-08-14T12:00:00.000Z',async(teamId,assignmentId,key)=>{cancelled.push(`${teamId}:${assignmentId}:${key}`);});
		expect(cancelled).toEqual(['team-a:assignment-a:discussion-archive:project-a:topic-a:assignment-a']);
		expect(writes.some((write)=>write.query.includes("agent_invocation_requests SET status='cancelled'"))).toBe(true);
	});

	it('preserves field-addressable content diagnostics for the API envelope', () => {
		const details = [{ severity: 'error', code: 'content_zod_too_small', field: 'title', message: 'Required' }];
		const error = Object.assign(new Error('Discussion content is invalid.'), {
			status: 422, code: 'discussion_content_invalid', details,
		});
		expect(discussionRouteFailure(error, 503, 'discussion_content_unavailable')).toEqual({
			status: 422, message: 'Discussion content is invalid.', code: 'discussion_content_invalid', details,
		});
	});

	it('keeps simulated-human evidence separate from explicit workday containment', () => {
		expect(discussionInvocationParent({ simulateHuman: true, workdayId: 'evidence-workday', reason: 'Observed exact evidence.' })).toEqual({
			parentWorkdayId: null,
			parentAssignmentId: null,
		});
		expect(discussionInvocationParent({ workdayId: 'evidence-workday', parentWorkdayId: 'parent-workday', parentAssignmentId: 'parent-assignment' })).toEqual({
			parentWorkdayId: 'parent-workday',
			parentAssignmentId: 'parent-assignment',
		});
	});

	it('derives exact TreeDX reply relations from a suspended parent assignment',() => {
		const assignment={metadata_json:JSON.stringify({operationalState:'suspended',waitingDiscussionId:'discussion-a',waitingMessageId:'message-question'})};
		expect(discussionContinuationReplyEvidence(assignment,'discussion-a',[{id:'message-question',path:'src/content/discussion-messages/discussion-a/message-question.mdx'}]))
			.toEqual({replyTo:'message-question',sourceMessageRefs:['message-question','src/content/discussion-messages/discussion-a/message-question.mdx']});
		expect(()=>discussionContinuationReplyEvidence(assignment,'discussion-b',[])).toThrow('not suspended on this exact Discussion');
	});
});
