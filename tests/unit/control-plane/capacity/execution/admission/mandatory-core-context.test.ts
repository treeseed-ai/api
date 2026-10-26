import { describe, expect, it } from 'vitest';
import type { ExactEntityReference } from '@treeseed/sdk/agent-capacity';
import { buildAssignmentAttempt } from '../../../../../../src/api/capacity/services/capacity/assignments/planning/execution/assignment-attempt-builder.ts';
import { canonicalOfferBuildInput } from '../fixtures/assignment-attempt-fixtures.ts';

// Reproduces API625 / real assignment_PC1y_bx9s6IeIBw3MgTD9o7KF6M1eAQE:
// the activity ceiling permits core context, while the contribution requests
// only its proposal. Required refs must survive without admitting other knowledge.
function coreContextInput() {
	const input = structuredClone(canonicalOfferBuildInput());
	const project = { store: 'treedx' as const, repository: 'library', commit: 'b'.repeat(40) };
	const team = { ...project, repository: 'team-library', commit: 'a'.repeat(40) };
	const identity = { ...input.candidate.effectiveProfile.profileRef, ...project, path: 'agents/engineer.mdx' };
	const required: ExactEntityReference[] = [identity,
		{ ...team, model: 'knowledge', id: 'team:team-readme', path: 'README.md' },
		{ ...team, model: 'objective', id: 'team:team-objective', path: 'objectives/core' },
		{ ...project, model: 'objective', id: `${input.candidate.node.projectId}:project-objective`, path: 'objectives/core' }];
	const unrelated: ExactEntityReference = { ...project, model: 'knowledge', id: 'unrelated', path: 'knowledge/unrelated.mdx' };
	input.candidate.effectiveProfile.profileRef = identity;
	input.candidate.effectiveProfile.permissionCeiling.content.read.push('agent', 'knowledge', 'objective');
	input.candidate.contextRefs.push(...required, unrelated);
	return { input, required, unrelated };
}

describe('mandatory canonical execution context', () => {
	it('retains exact core identity/objectives despite narrower task reads, without unrelated knowledge', () => {
		const { input, required, unrelated } = coreContextInput();
		const { assignment } = buildAssignmentAttempt(input);
		expect(assignment.contextRefs).toEqual(expect.arrayContaining(required));
		expect(assignment.grant.contentRead).toEqual(expect.arrayContaining(required));
		expect(assignment.contextRefs).not.toContainEqual(unrelated);
		expect(assignment.grant.contentRead).not.toContainEqual(unrelated);
		expect(assignment.grant.tools).toEqual(input.candidate.node.requestedPermissions!.tools);
	});
	it('reports missing mandatory objective authority instead of silently omitting it', () => {
		const { input } = coreContextInput();
		input.candidate.effectiveProfile.permissionCeiling.content.read = ['proposal', 'agent', 'knowledge'];
		expect(() => buildAssignmentAttempt(input)).toThrow(expect.objectContaining({ code: 'assignment_permission_ceiling_exceeded' }));
	});
});
