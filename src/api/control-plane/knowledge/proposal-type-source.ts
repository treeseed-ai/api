import { parse } from 'yaml';
import { validateProposalTypeContract } from '@treeseed/sdk/agent-capacity';
import { KnowledgeOperationError } from './knowledge-operation-error.ts';

export function validateProposalTypeSource(path: string, source: unknown): string {
	if (typeof source !== 'string' || !source.trim()) throw new KnowledgeOperationError(422, 'proposal_type_content_required', 'Proposal type content is required.');
	let parsed: unknown;
	try { parsed = parse(source); }
	catch { throw new KnowledgeOperationError(422, 'proposal_type_contract_invalid', 'Proposal type content must be valid YAML or JSON.'); }
	const validation = validateProposalTypeContract(parsed);
	if (!validation.ok || !validation.value) throw new KnowledgeOperationError(422, 'proposal_type_contract_invalid',
		`Invalid proposal type: ${validation.diagnostics.map((entry) => entry.message).join(' ')}`);
	if (path !== `.treeseed/governance/proposal-types/${validation.value.id}.yaml`) throw new KnowledgeOperationError(422,
		'proposal_type_path_invalid', 'The proposal type must use its exact .treeseed/governance/proposal-types/<id>.yaml path.');
	return source;
}
