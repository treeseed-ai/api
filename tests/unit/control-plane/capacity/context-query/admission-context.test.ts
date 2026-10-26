import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { canonicalStandardsJson } from '@treeseed/sdk/standards';
import { assignmentQueryContext, type AssignmentQueryContext } from '../../../../../src/api/capacity/services/capacity/agents/context-query-check-service.ts';
import { buildAssignmentAttempt } from '../../../../../src/api/capacity/services/capacity/assignments/planning/execution/assignment-attempt-builder.ts';
import { canonicalOfferBuildInput } from '../execution/fixtures/assignment-attempt-fixtures.ts';
import { initialAdmission } from '../execution/architecture/initial/initial-admission-fixture.ts';

function view(): AssignmentQueryContext {
	const value = { definition: { kind: 'query', id: 'repair-history', revision: 1, commit: 'a'.repeat(40) },
		projectId: 'project', entry: { node: { id: 'section:repair', path: 'knowledge/repair.mdx', text: 'Retain original deadlines.' }, text: 'Retain original deadlines.', tokenEstimate: 7 } };
	const digest = `sha256:${createHash('sha256').update(canonicalStandardsJson(value)).digest('hex')}`;
	const ref = { store: 'treedx' as const, model: 'knowledge', id: 'section:repair', repository: 'library', commit: 'b'.repeat(40), path: 'knowledge/repair.mdx', anchor: 'section:repair', digest };
	return { references: [ref], authorizedContext: [{ ref, value, digest, mediaType: 'application/json' }],
		selectors: [{ kind: 'query', id: 'repair-history', revision: 1, layer: 'agent' }], checks: [{ status: 'resolved', definition: value.definition }] };
}

it('keeps configured query views within the profile ceiling when task reads are narrower', () => {
	const input = canonicalOfferBuildInput(), queryContext = view();
	input.candidate = { ...input.candidate, queryContext, contextRefs: [...input.candidate.contextRefs, ...queryContext.references] };
	input.candidate.effectiveProfile.permissionCeiling.content.read.push('knowledge');
	const built = buildAssignmentAttempt(input).assignment;
	expect(built.contextRefs).toContainEqual(queryContext.references[0]);
	expect(built.grant.contentRead).toContainEqual(queryContext.references[0]);
	expect(assignmentQueryContext(built, queryContext)).toEqual(queryContext.authorizedContext);
	input.candidate.effectiveProfile.permissionCeiling.content.read = ['proposal', 'agent'];
	expect(() => buildAssignmentAttempt(input)).toThrow('Exact assignment scope exceeds');
});

it('freezes bounded query views and observations through original SQL admission and replays the same stored context', async () => {
	const f = await initialAdmission(undefined, true);
	try {
		const queryContext = view(), attempt = structuredClone(f.attempt);
		attempt.contextRefs.push(...queryContext.references); attempt.grant.contentRead.push(...queryContext.references);
		attempt.effectiveProfile.permissionCeiling.content.read.push('knowledge');
		const input = { ...f.input(attempt), queryContext };
		const admitted = await f.admit(input);
		expect(admitted.workspaceContext.authorizedContext).toEqual(queryContext.authorizedContext);
		expect(admitted.metadata.contextQueries).toEqual({ selectors: queryContext.selectors, checks: queryContext.checks });
		const before = await f.snapshot();
		expect(await f.admit(input)).toEqual(admitted); expect(await f.snapshot()).toEqual(before);
		for (const failure of ['content', 'grant', 'reference', 'duplicate'] as const) {
			const invalid = structuredClone(input);
			if (failure === 'content') invalid.queryContext.authorizedContext[0]!.value = { replaced: true };
			if (failure === 'grant') invalid.assignment.grant.contentRead = [];
			if (failure === 'reference') invalid.queryContext.authorizedContext[0]!.ref = { ...invalid.queryContext.authorizedContext[0]!.ref, commit: 'c'.repeat(40) };
			if (failure === 'duplicate') invalid.queryContext.authorizedContext.push(invalid.queryContext.authorizedContext[0]!);
			await expect(f.admit(invalid)).rejects.toMatchObject({ code: 'assignment_context_query_authority_mismatch' });
			expect(await f.snapshot()).toEqual(before);
		}
	} finally { await f.db.close(); }
});
