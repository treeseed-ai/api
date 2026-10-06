import { describe, expect, it } from 'vitest';
import { serializeProposalDocument } from '../../../../src/api/governance/proposal-document.ts';
import { parseFrontmatterDocument } from '../../../../src/api/content/frontmatter.ts';
import { validateContentRecord } from '../../../../src/api/content/content-validation.ts';

describe('proposal document contract', () => {
	it('serializes a minimal draft request for planning without inventing a summary or plan', () => {
		const source = serializeProposalDocument({ id: 'proposal-1', projectId: 'project-1', title: 'Repair assignment admission',
			request: 'The real assignment path does not currently admit the requested work.', status: 'draft' });
		expect(validateContentRecord('proposal', source).ok).toBe(true);
		const { frontmatter } = parseFrontmatterDocument(source);
		expect(frontmatter).toMatchObject({ schemaVersion: 'treeseed.proposal/v1', id: 'proposal-1', projectId: 'project-1', status: 'draft' });
		expect(frontmatter).not.toHaveProperty('summary');
		expect(frontmatter).not.toHaveProperty('executionPlan');
	});

	it('serializes API fields to canonical SDK content fields and preserves relations', () => {
		const source = serializeProposalDocument({ id: 'proposal-1', projectId: 'project-1', title: 'Document source isolation',
			request: 'Read exact source and independently review the work candidate.', summary: 'Verify durable candidate transfer.', status: 'discussing',
			objectiveRefs: [{ store: 'treedx', model: 'objective', id: 'objectives/core', revision: 1, digest: `sha256:${'a'.repeat(64)}` }],
			evidenceRefs: [{ store: 'url', model: 'issue', id: 'sdk-293', url: 'https://github.com/treeseed-ai/sdk/issues/293' }] });
		expect(validateContentRecord('proposal', source).ok).toBe(true);
		const { frontmatter } = parseFrontmatterDocument(source);
		expect(frontmatter).toMatchObject({ projectId: 'project-1', status: 'discussing', objectiveRefs: [{ id: 'objectives/core' }],
			evidenceRefs: [{ id: 'sdk-293' }] });
		for (const retired of ['proposal_type', 'primary_contributor', 'related_objectives', 'evidence_refs', 'plan']) expect(frontmatter).not.toHaveProperty(retired);
	});
});
