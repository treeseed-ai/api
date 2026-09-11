import { describe, expect, it } from 'vitest';
import { serializeProposalDocument } from '../../../../src/api/governance/proposal-document.ts';
import { parseFrontmatterDocument } from '../../../../src/api/content/frontmatter.ts';
import { validateContentRecord } from '../../../../src/api/content/content-validation.ts';

describe('proposal document contract', () => {
	it('serializes API fields to canonical SDK content fields and preserves relations', () => {
		const source = serializeProposalDocument({ id: 'proposal-1', title: 'Document source isolation', summary: 'Verify durable candidate transfer.',
			body: 'Read exact source and independently review the work candidate.', date: '2026-09-11T10:00:00.000Z',
			proposalTypes: ['implementation'], motivation: 'Prove source custody.', primaryContributor: 'user-1',
			relatedObjectives: ['objectives/core'], evidenceRefs: ['https://github.com/treeseed-ai/sdk/issues/293'],
			plan: { desiredOutcome: 'Verified handoff', currentProblem: 'Not accepted yet', proposedApproach: 'Run a real task',
				scope: ['documentation'], nonGoals: ['runtime changes'], deliverables: ['reviewed commit'], acceptanceCriteria: ['candidate preserved'],
				risks: ['handoff failure'], dependencies: [], alternatives: ['unit-only testing'], verification: ['review guest reads candidate'], openQuestions: [] } });
		expect(validateContentRecord('proposal', source).ok).toBe(true);
		const { frontmatter } = parseFrontmatterDocument(source);
		expect(frontmatter).toMatchObject({ proposal_type: 'implementation', primary_contributor: 'user-1', related_objectives: ['objectives/core'],
			evidence_refs: ['https://github.com/treeseed-ai/sdk/issues/293'] });
		for (const retired of ['proposalType', 'primaryContributor', 'relatedObjectives', 'evidenceRefs']) expect(frontmatter).not.toHaveProperty(retired);
	});
});
