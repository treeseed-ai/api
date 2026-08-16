import { describe,expect,it } from 'vitest';
import { serializeFrontmatterDocument } from '@treeseed/sdk/frontmatter';
import { assertGovernanceContent } from '../../../src/api/governance/content-validation.ts';

describe('governance content validation', () => {
	it('accepts canonical proposal source and preserves project-defined proposal types', () => {
		const source = serializeFrontmatterDocument({
			title:'Validated proposal',description:'Validated before TreeDX.',date:'2026-08-12',status:'in progress',
			summary:'API-authored proposal content uses the portable contract.',proposalType:'customer-defined-review',
			proposalTypes:['customer-defined-review'],motivation:'Prevent invalid governance content.',primaryContributor:'team-owner',
		},'Proposal body.');
		expect(assertGovernanceContent('proposal',source)).toMatchObject({ ok:true });
	});

	it('returns field-addressable diagnostics before governance content mutation', () => {
		const source = serializeFrontmatterDocument({ title:'Invalid proposal',proposalTypes:['implementation'] },'Invalid body.');
		expect(() => assertGovernanceContent('proposal',source)).toThrow(expect.objectContaining({
			code:'governance_content_model_invalid',status:422,model:'proposal',
			details:expect.arrayContaining([expect.objectContaining({ field:'proposal_type',code:'content_zod_invalid_type' })]),
		}));
	});
});
