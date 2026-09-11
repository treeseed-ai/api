import { serializeFrontmatterDocument } from '../content/frontmatter.ts';
import { assertGovernanceContent } from './content-validation.ts';

export function serializeProposalDocument(input: {
	id: string; title: string; summary: string; body: string; date: string;
	proposalTypes: string[]; motivation: string; primaryContributor: string;
	relatedObjectives: unknown; evidenceRefs: unknown; plan: unknown;
}) {
	const source = serializeFrontmatterDocument({ id: input.id, title: input.title, description: input.summary,
		summary: input.summary, date: input.date, status: 'in progress', draft: false,
		proposal_type: input.proposalTypes[0], proposal_types: input.proposalTypes,
		motivation: input.motivation, primary_contributor: input.primaryContributor,
		related_objectives: input.relatedObjectives, evidence_refs: input.evidenceRefs, plan: input.plan }, `${input.body}\n`);
	assertGovernanceContent('proposal', source);
	return source;
}
