import { describe, expect, it } from 'vitest';
import { buildAssignmentAttempt } from '../../../../../../src/api/capacity/services/capacity/assignments/planning/execution/assignment-attempt-builder.ts';
import { permissions, provider, canonicalOfferBuildInput, invalidCanonicalOffers } from '../fixtures/assignment-attempt-fixtures.ts';
import { assignmentAttemptSchema, assignmentResultSchema } from '@treeseed/sdk/agent-capacity';

describe('immutable assignment-attempt construction', () => {
	it('preserves explicit integration authority and one exact base when the governed class using the same Releaser handler is renamed', () => {
		const original = canonicalOfferBuildInput();
		original.candidate.node.agentClass = 'releaser';
		original.candidate.node.workItemId = 'combine-reviewed-candidates';
		original.candidate.node.requestedPermissions!.tools.push('release');
		original.candidate.effectiveProfile.handler = 'releaser';
		original.candidate.effectiveProfile.permissionCeiling.tools.push('release');
		original.candidate.predecessorResults = ['8', '9'].map(digit => assignmentResultSchema.parse({
			schemaVersion: 'treeseed.assignment-result/v1', id: `reviewed-input-${digit}`, assignmentId: `earlier-input-${digit}`,
			status: 'completed', summary: 'Supplied separate reviewed input, not a native review.',
			references: [{ kind: 'git', repository: 'treeseed-ai/sdk', commit: digit.repeat(40) }], verification: [],
			usage: { elapsedSeconds: 1 }, diagnostics: [], completedAt: original.now,
		}));
		for (const agentClass of ['releaser', 'configured-integration-author', 'customer-composition-worker']) {
			const input = structuredClone(original); input.candidate.node.agentClass = agentClass;
			input.candidate.effectiveProfile.profileRef.id = `configured/${agentClass}`;
			const before = structuredClone(input), result = buildAssignmentAttempt(input);
			expect(result.assignment.agentClass).toBe(agentClass);
			expect(result.assignment.effectiveProfile).toEqual(input.candidate.effectiveProfile);
			expect(result.assignment.workspace).toMatchObject({ mode: 'git', repository: 'treeseed-ai/sdk', baseCommit: 'c'.repeat(40) });
			expect(result.assignment.predecessorResultIds).toEqual(['reviewed-input-8', 'reviewed-input-9']);
			expect(result.assignment.grant.tools).toContain('release');
			expect(result.assignment.limits.maximumSeconds).toBe(3);
			expect(input).toEqual(before);
			const denied = structuredClone(input);
			denied.candidate.node.requestedPermissions!.tools = denied.candidate.node.requestedPermissions!.tools.filter(tool => tool !== 'release');
			denied.candidate.effectiveProfile.permissionCeiling.tools = denied.candidate.effectiveProfile.permissionCeiling.tools.filter(tool => tool !== 'release');
			const unchanged = structuredClone(denied);
			expect(() => buildAssignmentAttempt(denied)).toThrowError(expect.objectContaining({ status: 409, code: 'assignment_git_integration_required' }));
			expect(denied).toEqual(unchanged);
		}
	});
	it('freezes complete canonical supplied offer selection without changing scope quota or original assignment clocks on replay', () => {
		const supplied = canonicalOfferBuildInput(), before = structuredClone(supplied);
		const first = buildAssignmentAttempt(supplied);
		expect(first.assignment).toEqual(assignmentAttemptSchema.parse(first.assignment));
		expect(first.assignment.provider).toEqual({ providerId: 'provider', offerId: 'canonical-code-change', executionProviderId: 'codex',
			modelConfigurationId: 'terra-medium', executionCapabilityId: 'treeseed.engineering.code-change', offerRevision: 1, runtimeBuild: provider.runtimeBuild });
		expect(first.assignment.requiredCapabilities).toEqual(['treeseed.engineering.code-change']);
		expect(first.assignment.sourceRef).toEqual(supplied.candidate.node.sourceRef);
		expect(first.assignment.authorityRefs).toEqual(supplied.candidate.node.authorityRefs);
		expect(first.assignment.contextRefs).toEqual(supplied.candidate.contextRefs);
		expect(first.assignment.effectiveProfile).toEqual(supplied.candidate.effectiveProfile);
		expect(first.assignment.workspace).toEqual({ mode: 'git', repository: 'treeseed-ai/sdk', baseCommit: 'c'.repeat(40),
			branch: `simulation/local/workday/${first.assignment.id}`, writablePaths: ['**'] });
		expect(first.assignment.grant).toEqual({ contentRead: [supplied.candidate.node.sourceRef], contentWrite: [],
			sourceRead: ['treeseed-ai/sdk'], sourceWrite: ['treeseed-ai/sdk'], tools: [...permissions.tools] });
		expect(first.assignment.createdAt).toBe(supplied.now); expect(first.assignment.limits.maximumSeconds).toBe(3);
		// Active allocation does not precharge separately bounded infrastructure or
		// queue time. The user's explicit contract retains original phase authority.
		expect(first.assignment.deadline).toBe(supplied.run.parameters.appliedPlan!.endsAt);
		expect(first.accountingLimits).toEqual(supplied.providers[0]!.accountingLimits);
		expect(first.providerConcurrencyLimit).toBe(1); expect(first.laneId).toBe('work');
		for (let retry = 0; retry < 3; retry++) expect(buildAssignmentAttempt(structuredClone(supplied))).toEqual(first);
		expect(supplied).toEqual(before);
		// Canonical supplied qualification bytes are not native attestation proof.
	});
	it('denies changed malformed expired failed revoked or ambiguous supplied offer qualification before freezing an assignment without repairing any input', () => {
		const original = canonicalOfferBuildInput(), outcomes: Array<{ name: string; cause: unknown }> = [];
		for (const variant of invalidCanonicalOffers(original.providers[0]!.offers[0]!, original.now)) {
			const supplied = structuredClone(original); Object.assign(supplied.providers[0]!, { offers: [variant.offer] });
			const before = structuredClone(supplied); let cause: unknown;
			try { buildAssignmentAttempt(supplied); } catch (error) { cause = error; }
			outcomes.push({ name: variant.name, cause }); expect(supplied).toEqual(before);
		}
		for (const outcome of outcomes) expect(outcome.cause, outcome.name).toMatchObject({ status: 409, code: 'capacity_execution_provider_unavailable' });
		expect(buildAssignmentAttempt(original).assignment.provider.offerId).toBe('canonical-code-change');
	});
});
