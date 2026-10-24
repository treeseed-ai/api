import { describe, expect, it } from 'vitest';
import { mergeAssignmentEstimate } from '../../../../../../src/api/capacity/services/capacity/assignments/planning/estimates/integration.ts';
import { assignment as original } from '../../execution/fixtures/assignment.ts';

type Row = Record<string, unknown>;
const draft = { schemaVersion: 'treeseed.proposal/v2', id: 'prepared-runner', projectId: 'agent',
	title: 'Preserve prepared workload inputs', request: 'Document, reproduce and repair the actual request handoff.',
	summary: 'Deliver the opaque runner repair through the subscribed team.', status: 'discussing', groupIds: ['provider-runtime'] };
const estimate = { expectedSeconds: 120, maximumSeconds: 240, rationale: 'Own bounded source change and closeout.' };
function input(name: string, itemId: string, frozen: Row = draft) {
	const id = `estimate-${name}`, ref = { store: 'postgresql', model: 'assignment-attempt', id, revision: 1 };
	const assignment = { id, teamId: 'team', projectId: 'agent', agentId: `agent/${name}`, assignmentAttempt: {
		...original, id, attempt: 1, teamId: 'team', projectId: 'agent', agentClass: 'maintenance',
		sourceRef: { ...original.sourceRef, store: 'treedx', model: 'proposal', id: draft.id },
		effectiveProfile: { ...original.effectiveProfile, activity: 'estimating', profileRef: { ...original.effectiveProfile.profileRef, id: `agent/${name}` } },
	} };
	const work = { id: itemId, activity: 'acting', objective: `Own ${itemId} contribution.`, estimateRef: ref,
		estimate, reviewEstimate: { ...estimate, rationale: 'Own independent peer-review effort.' }, workspace: 'git',
		review: 'required', maximumReviewCycles: 2, dependsOn: [],
		requestedPermissions: { content: { read: ['proposal'], write: [] }, tools: ['source.read', 'source.write', 'verification'] },
		contextRefs: [{ store: 'git', model: 'repository', id: 'agent', repository: 'treeseed-ai/agent', commit: 'a'.repeat(40) }],
		acceptanceCriteria: ['Deliver the accepted source change and preserve its exact authority.'] };
	const items = ((frozen.executionPlan as { workItems?: Row[] } | undefined)?.workItems ?? []);
	return { frozen, current: frozen, candidate: { ...frozen, executionPlan: { workItems: [...items, work] } },
		assignment, ownedEstimateRefs: [] as Row[], agentClass: 'maintenance', work, ref };
}

describe('subscriber-owned estimate contributions', () => {
	it('keeps an already integrated contribution current when the proposal orders work by workflow rather than alphabetically', () => {
		const engineer = input('engineer', 'z-repair-request'), tester = input('tester', 'a-reproduce-request');
		const current = { ...draft, executionPlan: { workItems: [engineer.work, tester.work] } }, held = structuredClone(current);
		for (const author of [engineer, tester]) expect(mergeAssignmentEstimate({ ...author,
			frozen: current, candidate: current, current } as never)).toEqual(current);
		expect(current).toEqual(held);
	});
	it('keeps multiple own work items deterministic on repeated publication and refuses concurrent ID collisions', () => {
		const author = input('engineer', 'repair-request');
		author.candidate.executionPlan.workItems.push({ ...author.work, id: 'document-request' });
		const current = mergeAssignmentEstimate(author as never);
		expect((current.executionPlan as { workItems: Row[] }).workItems.map(item => item.id)).toEqual(['document-request', 'repair-request']);
		expect(mergeAssignmentEstimate({ ...author, current } as never)).toEqual(current);
		const peer = input('tester', 'repair-request');
		expect(() => mergeAssignmentEstimate({ ...peer, current } as never)).toThrow(/conflicting IDs/u);
	});
	it('merges distinct subscribers sharing one class without a winner or lost concurrent contribution', () => {
		const writer = input('technical-writer', 'document-boundary'), tester = input('tester', 'reproduce-request');
		for (const [first, second] of [[writer, tester], [tester, writer]]) {
			const a = mergeAssignmentEstimate(first as never), b = mergeAssignmentEstimate({ ...second, current: a } as never);
			const before = structuredClone(b);
			expect((b.executionPlan as { workItems: Row[] }).workItems.map(item => item.id)).toEqual(['document-boundary', 'reproduce-request']);
			expect(mergeAssignmentEstimate({ ...second, current: b } as never)).toEqual(before);
			expect(b).toEqual(before); expect(draft).not.toHaveProperty('executionPlan');
		}
	});
	it('allows an admitted author to refine its own contribution while preserving the peer contribution', () => {
		const writer = input('technical-writer', 'document-boundary'), tester = input('tester', 'reproduce-request');
		const a = mergeAssignmentEstimate(writer as never), both = mergeAssignmentEstimate({ ...tester, current: a } as never);
		const next = input('technical-writer-round-two', 'document-boundary', both);
		next.assignment.agentId = writer.assignment.agentId;
		next.assignment.assignmentAttempt.effectiveProfile.profileRef.id = writer.assignment.agentId;
		next.ownedEstimateRefs = [writer.ref];
		next.candidate.executionPlan.workItems = [tester.work, { ...next.work, estimate: { ...estimate, expectedSeconds: 150 } }];
		const result = mergeAssignmentEstimate(next as never);
		expect((result.executionPlan as { workItems: Row[] }).workItems).toEqual([
			{ ...next.work, estimate: { ...estimate, expectedSeconds: 150 } }, tester.work,
		]);
	});
	it('rejects forged ownership foreign content and invalid own estimates without changing any supplied input', () => {
		const author = input('tester', 'reproduce-request');
		for (const patch of [
			{ candidate: { ...author.candidate, request: 'A different objective.' } },
			{ current: { ...draft, groupIds: ['different-team'] } },
			{ assignment: { ...author.assignment, agentId: 'agent/another-author' } },
			{ candidate: { ...draft, executionPlan: { workItems: [{ ...author.work, estimateRef: { ...author.ref, id: 'foreign-estimate' } }] } } },
			{ candidate: { ...draft, executionPlan: { workItems: [{ ...author.work, estimateRef: { ...author.ref, revision: 2 } }] } } },
			{ candidate: { ...draft, executionPlan: { workItems: [{ ...author.work, estimate: { ...estimate, expectedSeconds: 500 } }] } } },
		]) {
			const value = { ...author, ...patch }, held = structuredClone(value);
			expect(() => mergeAssignmentEstimate(value as never)).toThrow(); expect(value).toEqual(held);
		}
	});
	it('rejects peer edits missing peer work and collisions instead of reassigning another subscriber contribution', () => {
		const writer = input('technical-writer', 'document-boundary'), existing = mergeAssignmentEstimate(writer as never);
		const tester = input('tester', 'reproduce-request', existing);
		for (const items of [[tester.work], [{ ...writer.work, objective: 'Changed peer scope.' }, tester.work],
			[writer.work, { ...tester.work, id: writer.work.id }]]) {
			const value = { ...tester, candidate: { ...tester.candidate, executionPlan: { workItems: items } } }, held = structuredClone(value);
			expect(() => mergeAssignmentEstimate(value as never)).toThrow(); expect(value).toEqual(held);
		}
	});
});
