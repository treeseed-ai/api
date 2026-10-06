import { describe, expect, it } from 'vitest';
import { createKnowledgePublicationExecutor } from '../../../../../../src/operations-runner/knowledge/publication-executor.ts';

// Explicit input-only unit stores. Native owning integration is in the separate
// file; these early-denial assertions are not runtime or authentication proof.
function authority(publication: unknown, workspace: unknown, review: unknown) {
	let resolutions = 0;
	const store = { first: async () => publication, getKnowledgeWorkspace: async () => workspace, getKnowledgeReview: async () => review };
	const executor = createKnowledgePublicationExecutor({ controlPlaneStore: store, environment: 'local',
		resolveKnowledgeGatewayConnection: async () => { resolutions++; throw new Error('Authority must deny before native access'); } });
	return { executor, resolutions: () => resolutions };
}
const publication = { id: 'publication', workspace_id: 'workspace', review_id: 'review', status: 'queued', commit_sha: 'a'.repeat(40), published_ref: 'refs/heads/staging' };
const workspace = { id: 'workspace', status: 'approved' }, review = { id: 'review', status: 'approved', commitSha: publication.commit_sha };

describe('relation publication owning executor authority', () => {
	it('denies missing unknown cancelled and failed publication custody before any native connection', async () => {
		for (const row of [null, { ...publication, status: 'unknown' }, { ...publication, status: 'cancelled' }, { ...publication, status: 'failed' }]) {
			const f = authority(row, workspace, review); await expect(f.executor.run({ publicationId: publication.id }, {})).rejects.toThrow('Recoverable knowledge publication');
			expect(f.resolutions()).toBe(0);
		}
	});
	it('denies absent unapproved and moved exact review commit without converting admission into an independent Actor review', async () => {
		for (const [w, r] of [[null, review], [workspace, null], [{ ...workspace, status: 'draft' }, review],
			[workspace, { ...review, status: 'changes-requested' }], [workspace, { ...review, commitSha: 'b'.repeat(40) }]]) {
			const f = authority(publication, w, r), before = structuredClone({ w, r });
			await expect(f.executor.run({ publicationId: publication.id }, {})).rejects.toThrow('approval state');
			expect(f.resolutions()).toBe(0); expect({ w, r }).toEqual(before);
		}
	});
	it('denies both explicit production and every declared main ref before publication or indexing even with otherwise approved inputs', async () => {
		for (const [published_ref, targetEnvironment] of [['refs/heads/staging', 'production'], ['main', 'staging'], ['refs/heads/main', 'staging']]) {
			const f = authority({ ...publication, published_ref }, workspace, review);
			await expect(f.executor.run({ publicationId: publication.id, targetEnvironment }, {})).rejects.toThrow('protected main');
			expect(f.resolutions()).toBe(0);
		}
	});
});
