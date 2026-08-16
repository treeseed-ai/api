import { describe,expect,it } from 'vitest';
import { enforceProviderSignalContract,resolveSignalSubjectGroups } from '../../../../../src/api/capacity/routes/capacity/assignments/provider-signal-policy.ts';

const contract = {
	schemaVersion: 'treeseed.agent-signal/v1' as const, id: 'artifact-changed', label: 'Changed', description: 'Artifact changed.',
	subjectKinds: ['note'], allowedOrigins: ['agent-tool'] as const, payloadSchema: {}, commitEvidence: 'required' as const,
	idempotency: 'commit-subject' as const, supersession: 'append' as const, coalescing: 'none' as const,
};

describe('provider signal subject group policy', () => {
	it('uses explicit subject groups instead of producer membership', () => {
		expect(resolveSignalSubjectGroups(
			{ subjectGroupIds: ['group:proposal', 'group:proposal'] },
			new Set(['group:proposal', 'group:producer-primary']),
		)).toEqual({ directGroupIds: ['group:proposal'], source: 'subject' });
	});

	it('leaves omitted subject groups unscoped and rejects unknown explicit groups', () => {
		expect(resolveSignalSubjectGroups({}, new Set(['group:primary']))).toEqual({ directGroupIds: [], source: 'unscoped' });
		try { resolveSignalSubjectGroups({ subjectGroupIds: ['group:outside'] }, new Set(['group:secondary','group:primary'])); }
		catch (error) {
			expect(error).toMatchObject({ code:'assignment_signal_subject_groups_invalid',details:{
				unknownGroupIds:['group:outside'],allowedGroupIds:['group:primary','group:secondary'],
			} });
			return;
		}
		throw new Error('Expected invalid subject groups to be rejected.');
	});

	it('requires commit-bearing signals to carry matching assignment-scoped mutation receipts', () => {
		const assignment = { id: 'assignment-1', teamId: 'team-1', projectId: 'project-1', mode: 'planning', metadata: {} };
		const evidence = { commitSha: 'a'.repeat(40), immutableRef: 'a'.repeat(40) };
		expect(() => enforceProviderSignalContract(assignment, { subjectKind: 'note', subjectId: 'note-1', causationId: 'cause-1', evidence }, contract))
			.toThrowError(expect.objectContaining({ code: 'assignment_signal_mutation_receipt_required' }));
		const mutationReceipt = { schemaVersion: 'treeseed.artifact-mutation-receipt/v1', id: 'receipt-1', kind: 'treedx-content', phase: 'provisional',
			executionMode: 'simulation', upstreamMutationPolicy: 'denied',
			assignmentId: 'assignment-1', modeRunId: 'run-1', teamId: 'team-1', projectId: 'project-1', baseRef: 'b'.repeat(40), effectiveRef: 'a'.repeat(40),
			changedPaths: ['src/content/notes/note-1.mdx'], before: { ref: 'b'.repeat(40), artifactRefs: [] }, after: { ref: 'a'.repeat(40), artifactRefs: ['content-receipt-1'] }, createdAt: '2026-08-13T12:00:00.000Z' };
		expect(enforceProviderSignalContract(assignment, { subjectKind: 'note', subjectId: 'note-1', causationId: 'cause-1', evidence: { ...evidence, mutationReceipt } }, contract))
			.toBe(`${'a'.repeat(40)}:note-1`);
	});
});
