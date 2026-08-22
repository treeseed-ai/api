import { RESEARCH_WORKFLOW_STAGES,type ResearchWorkflowRecord } from '@treeseed/sdk/agent-capacity';
import { validateResearchCitations } from './citation.ts';

export interface ResearchWorkflowDiagnostic { code: string; path: string; message: string }

export function validateResearchWorkflow(value: ResearchWorkflowRecord) {
	const diagnostics: ResearchWorkflowDiagnostic[] = [];
	const add = (code: string, path: string, message: string) => diagnostics.push({ code, path, message });
	if (value.schemaVersion !== 1) add('research_workflow_schema_invalid', 'schemaVersion', 'schemaVersion must be 1.');
	for (const key of ['id', 'teamId', 'projectId', 'objectiveRef', 'questionRef'] as const) if (!value[key]?.trim()) add('research_workflow_field_required', key, `${key} is required.`);
	if (!Number.isInteger(value.stateVersion) || value.stateVersion < 1) add('research_workflow_state_version_invalid', 'stateVersion', 'stateVersion must be a positive integer.');
	if (!Number.isInteger(value.minimumIndependentSources) || value.minimumIndependentSources < 2) add('research_workflow_source_minimum_invalid', 'minimumIndependentSources', 'At least two independent sources are required.');
	if (!Number.isInteger(value.maxRevisionCycles) || value.maxRevisionCycles < 1 || value.maxRevisionCycles > 10) add('research_workflow_revision_limit_invalid', 'maxRevisionCycles', 'maxRevisionCycles must be an integer from 1 through 10.');
	if (value.nodes.length !== RESEARCH_WORKFLOW_STAGES.length || value.nodes.some((node, index) => node.stage !== RESEARCH_WORKFLOW_STAGES[index])) add('research_workflow_stage_order_invalid', 'nodes', 'The canonical eleven research stages must occur exactly once in order.');
	const ids = new Set<string>();
	for (const [index, node] of value.nodes.entries()) {
		if (!node.id || ids.has(node.id)) add('research_workflow_node_id_invalid', `nodes[${index}].id`, 'Node ids must be non-empty and unique.');
		ids.add(node.id);
		if (index === 0 ? node.dependsOn.length !== 0 : node.dependsOn.length !== 1 || node.dependsOn[0] !== value.nodes[index - 1]?.id) add('research_workflow_dependency_invalid', `nodes[${index}].dependsOn`, 'Each stage must depend only on its immediate predecessor.');
	}
	for (const diagnostic of validateResearchCitations(value.citations).diagnostics) add(diagnostic.code, `citations.${diagnostic.path}`, diagnostic.message);
	const claimIds = new Set<string>();
	for (const [index, claim] of value.claims.entries()) {
		if (!claim.id || claimIds.has(claim.id)) add('research_claim_id_invalid', `claims[${index}].id`, 'Claim ids must be non-empty and unique.');
		claimIds.add(claim.id);
		if (!claim.text?.trim()) add('research_claim_text_required', `claims[${index}].text`, 'Claim text is required.');
		if (claim.status !== 'unsupported' && claim.citationIds.length === 0) add('research_claim_citation_required', `claims[${index}].citationIds`, 'Supported and contradicted claims require citations.');
	}
	if (value.status === 'completed' && (!value.reviewerApprovedRevision || !value.publicationRef || !value.reportRef || value.claims.some((claim) => claim.material && claim.status === 'unsupported'))) add('research_workflow_completion_invalid', 'status', 'Completed research requires independent Reviewer approval, publication, report, and no unsupported material claim.');
	return { ok: diagnostics.length === 0, diagnostics };
}
