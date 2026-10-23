import { serializeFrontmatterDocument } from '../content/frontmatter.ts';
import { assertGovernanceContent } from './content-validation.ts';

export function serializeProposalDocument(input: {
	schemaVersion?: 'treeseed.proposal/v1' | 'treeseed.proposal/v2';
	id: string; projectId: string; title: string; request: string; summary?: string;
	status: 'draft' | 'discussing' | 'ready' | 'decided' | 'withdrawn';
	objectiveRefs?: unknown; evidenceRefs?: unknown; discussionRef?: unknown; executionPlan?: unknown;
	groupIds?: unknown;
}) {
	const source = serializeFrontmatterDocument({
		schemaVersion: input.schemaVersion ?? 'treeseed.proposal/v2', id: input.id, projectId: input.projectId,
		title: input.title, request: input.request, ...(input.summary ? { summary: input.summary } : {}), status: input.status,
		...(input.groupIds !== undefined ? { groupIds: input.groupIds } : {}),
		...(input.objectiveRefs ? { objectiveRefs: input.objectiveRefs } : {}),
		...(input.evidenceRefs ? { evidenceRefs: input.evidenceRefs } : {}),
		...(input.discussionRef ? { discussionRef: input.discussionRef } : {}),
		...(input.executionPlan ? { executionPlan: input.executionPlan } : {}),
	}, '');
	assertGovernanceContent('proposal', source);
	return source;
}
