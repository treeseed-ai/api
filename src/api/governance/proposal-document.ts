import { serializeFrontmatterDocument } from '../content/frontmatter.ts';
import { assertGovernanceContent } from './content-validation.ts';

export function serializeProposalDocument(input: {
	id: string; projectId: string; title: string; request: string; summary?: string;
	status: 'draft' | 'discussing' | 'ready' | 'decided' | 'withdrawn';
	objectiveRefs?: unknown; evidenceRefs?: unknown; discussionRef?: unknown; executionPlan?: unknown;
}) {
	const source = serializeFrontmatterDocument({
		schemaVersion: 'treeseed.proposal/v1', id: input.id, projectId: input.projectId,
		title: input.title, request: input.request, ...(input.summary ? { summary: input.summary } : {}), status: input.status,
		...(input.objectiveRefs ? { objectiveRefs: input.objectiveRefs } : {}),
		...(input.evidenceRefs ? { evidenceRefs: input.evidenceRefs } : {}),
		...(input.discussionRef ? { discussionRef: input.discussionRef } : {}),
		...(input.executionPlan ? { executionPlan: input.executionPlan } : {}),
	}, '');
	assertGovernanceContent('proposal', source);
	return source;
}
