import { describe, expect, it } from 'vitest';
import { validateProposalTypeSource } from '../../../../src/api/control-plane/knowledge/proposal-type-source.ts';

const contract = { schemaVersion: 'treeseed.proposal-type/v1', id: 'implementation', label: 'Implementation', description: 'A bounded project change.' };
const path = '.treeseed/governance/proposal-types/implementation.yaml';

describe('governed proposal type source', () => {
	it('accepts a valid SDK contract at its canonical path without rewriting content', () => {
		const source = JSON.stringify(contract);
		expect(validateProposalTypeSource(path, source)).toBe(source);
	});
	it.each(['../implementation.yaml', '.treeseed/governance/proposal-types/other.yaml', 'knowledge/implementation.yaml', '.treeseed/governance/proposal-types/implementation.json'])('rejects a noncanonical path: %s', (candidate) => {
		expect(() => validateProposalTypeSource(candidate, JSON.stringify(contract))).toThrow(expect.objectContaining({ code: 'proposal_type_path_invalid' }));
	});
	it.each([{}, { ...contract, schemaVersion: 'old' }, { ...contract, id: '../escape' }, { ...contract, requiredReviewerClasses: [null] }])('rejects invalid contract %j', (candidate) => {
		expect(() => validateProposalTypeSource(path, JSON.stringify(candidate))).toThrow(expect.objectContaining({ code: 'proposal_type_contract_invalid' }));
	});
	it('rejects malformed YAML and absent content', () => {
		expect(() => validateProposalTypeSource(path, 'schemaVersion: [')).toThrow(expect.objectContaining({ code: 'proposal_type_contract_invalid' }));
		expect(() => validateProposalTypeSource(path, ' ')).toThrow(expect.objectContaining({ code: 'proposal_type_content_required' }));
	});
});
