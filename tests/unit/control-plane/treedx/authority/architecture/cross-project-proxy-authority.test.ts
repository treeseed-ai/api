import { describe, expect, it } from 'vitest';
import { selectTreeDxReadRepositoryGrant } from '../../../../../../src/api/control-plane/repositories/treedx/proxy-operation-service.ts';
import { providerRefAuthority } from '../../../../../../src/api/control-plane/repositories/treedx/provider-ref-authority.ts';
import { evaluateTreeDxProxyHandleAccess } from '../../../../../../src/api/capacity/policy/treedx-proxy-access.ts';
import { treeDxBoundedScopedPaths } from '../../../../../../src/api/control-plane/treedx/upstream-operation.ts';
import { readGrants, secondaryProject, secondaryRepository, firstRef, secondRef } from './cross-project-proxy-fixture.ts';

describe('secondary repository exact immutable grant authority', () => {
	it('selects each sole exact secondary grant without rewriting its sibling commit or original primary authority', () => {
		const grants = readGrants(), before = structuredClone(grants);
		for (const [index, ref] of [firstRef, secondRef].entries()) {
			expect(selectTreeDxReadRepositoryGrant(grants, secondaryProject, secondaryRepository, ref)).toEqual(grants[index]);
				expect(providerRefAuthority({ handle: { projectId: 'project', baseRef: 'a'.repeat(40), metadata: { readRepositories: grants } },
					projectId: secondaryProject, workspace: false, requestedRef: ref })).toEqual({ ref, refs: [ref] });
			expect(treeDxBoundedScopedPaths(grants[index]!.allowedPaths, [])).toEqual(grants[index]!.allowedPaths);
			for (const requested of [['*'], ['**'], ['private/foreign.md']]) {
				expect(treeDxBoundedScopedPaths(grants[index]!.allowedPaths, requested)).toEqual([]);
			}
		}
		expect(grants).toEqual(before);
	});
	it('denies duplicate exact grants and ambiguous omitted selectors rather than granting the first entry', () => {
		const observations: unknown[] = [];
		for (const mutation of ['exact-duplicate', 'conflicting-paths', 'omitted-ref', 'omitted-repository']) {
			const grants = readGrants();
			if (mutation === 'exact-duplicate' || mutation === 'conflicting-paths') grants.push({ ...grants[1]!,
				...(mutation === 'conflicting-paths' ? { allowedPaths: ['books/foreign.md'] } : {}) });
			if (mutation === 'omitted-repository') grants.push({ ...grants[1]!, repositoryId: 'other-library' });
			const before = structuredClone(grants);
			observations.push(selectTreeDxReadRepositoryGrant(grants, secondaryProject, mutation === 'omitted-repository' ? '' : secondaryRepository,
				mutation === 'omitted-ref' ? '' : secondRef));
			expect(grants).toEqual(before);
		}
		expect(observations).toEqual([undefined, undefined, undefined, undefined]);
	});
	it('denies foreign missing moved and workspace secondary authority without widening to primary commits or produced history', () => {
		const handle = { projectId: 'project', baseRef: 'a'.repeat(40), metadata: { readRepositories: readGrants() } }, before = structuredClone(handle);
		for (const value of [{ projectId: 'foreign', workspace: false, requestedRef: secondRef },
			{ projectId: secondaryProject, workspace: false, requestedRef: 'd'.repeat(40), producedCommits: ['d'.repeat(40)] },
			{ projectId: secondaryProject, workspace: true, requestedRef: secondRef }]) {
			expect(() => providerRefAuthority({ handle, ...value })).toThrow();
		}
		expect(selectTreeDxReadRepositoryGrant(readGrants(), secondaryProject, 'foreign-library', secondRef)).toBeUndefined();
		expect(selectTreeDxReadRepositoryGrant([], secondaryProject, secondaryRepository, secondRef)).toBeUndefined();
		expect(handle).toEqual(before);
	});
	it('denies revoked expired and malformed explicit handle clocks for exact reads without accepting unknown time as active', () => {
		const now = new Date('2026-10-03T10:00:00.000Z'), observations: boolean[] = [];
		for (const mutation of ['revoked', 'expired', 'not-a-clock', '2026-99-99T99:99:99.999Z']) {
			const handle = { id: 'handle', teamId: 'team', projectId: 'project', repositoryId: 'primary-library', assignmentId: 'assignment',
				status: mutation === 'revoked' ? 'revoked' : 'issued', expiresAt: mutation === 'expired' ? now.toISOString() : mutation,
				allowedOperations: ['files:read'], allowedReadPaths: ['books/primary.md'] }, before = structuredClone(handle);
			observations.push(evaluateTreeDxProxyHandleAccess(handle, { teamId: 'team', projectId: 'project', assignmentId: 'assignment',
				repositoryId: 'primary-library', operation: 'files:read', path: 'books/primary.md', now }).ok);
			expect(handle).toEqual(before);
		}
		expect(observations).toEqual([false, false, false, false]);
	});
});
