import { expect, it } from 'vitest';
import { assignmentResultSchema } from '@treeseed/sdk/agent-capacity';
import { buildAssignmentAttempt } from '../../../../../../../src/api/capacity/services/capacity/assignments/planning/execution/assignment-attempt-builder.ts';
import { canonicalOfferBuildInput } from '../../fixtures/assignment-attempt-fixtures.ts';

// Controlled predecessor facts exercise compilation, not live agent products or usage.
function reviewedInput() {
	const input = structuredClone(canonicalOfferBuildInput());
	const note = { store: 'treedx' as const, model: 'note', id: 'review-note', repository: 'peer-library', commit: 'f'.repeat(40), path: 'notes/review.mdx' };
	const decision = { ...note, model: 'decision', id: 'review-decision', path: 'decisions/review.mdx' };
	const unrelated = { ...note, model: 'knowledge', id: 'unrelated', path: 'knowledge/unrelated.md' };
	const git = { store: 'git' as const, model: 'repository', id: 'documented-source', repository: 'treeseed-ai/sdk', commit: 'e'.repeat(40) };
	input.candidate.node.requestedPermissions!.content.read = [];
	input.candidate.effectiveProfile.permissionCeiling.content.read = ['proposal', 'note', 'decision', 'knowledge', 'agent'];
	input.candidate.contextRefs.push(git, note, decision, unrelated);
	const actor = assignmentResultSchema.parse({ schemaVersion: 'treeseed.assignment-result/v1', id: 'documented-result', assignmentId: 'documented-attempt',
		status: 'completed', summary: 'Controlled candidate.', references: [{ kind: 'git', repository: git.repository, commit: git.commit }],
		verification: [], usage: { elapsedSeconds: 1 }, diagnostics: [], completedAt: input.now });
	const review = assignmentResultSchema.parse({ ...actor, id: 'reviewed-result', assignmentId: 'reviewed-attempt', references: [note, decision].map(ref => ({
		kind: 'treedx', projectId: 'peer-project', repository: ref.repository, commit: ref.commit, path: ref.path,
	})) });
	input.candidate.predecessorResults = [actor, review];
	return { input, note, decision, unrelated, git };
}

it('compiles every exact reviewed predecessor read within the profile ceiling even when supplementary reads are empty', () => {
	const f = reviewedInput(), held = structuredClone(f.input);
	const assignment = buildAssignmentAttempt(f.input).assignment;
	expect(assignment.grant.contentRead).toEqual([f.input.candidate.node.sourceRef, f.input.candidate.effectiveProfile.profileRef, f.note, f.decision]);
	for (const ref of [f.note, f.decision, f.git]) expect(assignment.contextRefs).toContainEqual(ref);
	expect(assignment.contextRefs).not.toContainEqual(f.unrelated);
	expect(assignment.grant.contentRead).not.toContainEqual(f.unrelated);
	expect(assignment.grant.contentWrite).toEqual([]);
	expect(assignment.grant.sourceRead).toEqual(['treeseed-ai/sdk']);
	expect(assignment.grant.sourceWrite).toEqual(['treeseed-ai/sdk']);
	expect(assignment.grant.tools).toEqual(f.input.candidate.node.requestedPermissions!.tools);
	expect(assignment.workspace).toMatchObject({ mode: 'git', baseCommit: f.git.commit });
	expect(assignment.predecessorResultIds).toEqual(['documented-result', 'reviewed-result']);
	expect(f.input).toEqual(held);
});

it('denies a required predecessor model outside the exact profile ceiling without mutating or broadening authority', () => {
	for (const denied of ['note', 'decision']) {
		const f = reviewedInput();
		f.input.candidate.effectiveProfile.permissionCeiling.content.read = ['proposal', 'note', 'decision', 'agent'].filter(model => model !== denied) as never;
		const held = structuredClone(f.input);
		expect(() => buildAssignmentAttempt(f.input)).toThrow('Exact assignment scope exceeds its effective activity profile.');
		expect(f.input).toEqual(held);
	}
});

it('does not infer missing moved or unrelated predecessor context from an artifact path', () => {
	for (const mode of ['missing', 'commit', 'path'] as const) {
		const f = reviewedInput();
		f.input.candidate.contextRefs = f.input.candidate.contextRefs.filter(ref => ref.id !== f.note.id);
		if (mode !== 'missing') f.input.candidate.contextRefs.push({ ...f.note, [mode]: mode === 'commit' ? 'a'.repeat(40) : 'notes/foreign.mdx' });
		const held = structuredClone(f.input);
		expect(() => buildAssignmentAttempt(f.input)).toThrow('Every predecessor artifact requires its exact context and read grant.');
		expect(f.input).toEqual(held);
	}
});

it('deduplicates mandatory and explicitly requested predecessor reads without changing the requested authority', () => {
	const f = reviewedInput(); f.input.candidate.node.requestedPermissions!.content.read = ['proposal', 'note', 'decision'];
	const held = structuredClone(f.input), assignment = buildAssignmentAttempt(f.input).assignment;
	expect(assignment.grant.contentRead).toEqual([f.input.candidate.node.sourceRef, f.input.candidate.effectiveProfile.profileRef, f.note, f.decision]);
	expect(assignment.grant.contentRead).toHaveLength(4); expect(f.input).toEqual(held);
});
