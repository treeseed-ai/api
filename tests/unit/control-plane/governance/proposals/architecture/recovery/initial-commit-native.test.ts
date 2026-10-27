import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { relationAuthoringDatabase, object } from '../../../../knowledge/workspaces/architecture/relation-authoring-fixture.ts';
import { createGovernanceService } from '../../../../../../../src/api/control-plane/governance/governance-service.ts';
import { commitProposalVersionContent } from '../../../../../../../src/api/control-plane/governance/proposal-version-content.ts';
import { resolveKnowledgeGatewayConnection } from '../../../../../../../src/api/knowledge/gateway-treedx-connection.ts';
import { parseFrontmatterDocument } from '../../../../../../../src/api/content/frontmatter.ts';

// Actual original API store, independent native PostgreSQL pools and signed
// disposable TreeDX. A selective post-commit SQL fault is controlled input;
// this does not claim authenticated operator HTTP or portfolio execution.
describe('native initial proposal commit recovery', () => {
	it('retains discoverable source custody after post-commit persistence failure and recovers an unchanged orphan without overwriting other content', async () => {
		const f = await relationAuthoringDatabase(true), owned = new Set<string>();
		const projectId = f.sources[0]!.projectId, repository = f.sources[0]!.repository;
		const service = createGovernanceService(f.store, { create: async () => { throw new Error('No discussion mutation expected'); } });
		let fault: ReturnType<typeof vi.spyOn> | undefined;
		try {
			const connection = await resolveKnowledgeGatewayConnection(f.store, { projectId, write: true }); assert.ok(connection);
			const typePath = '.treeseed/governance/proposal-types/implementation.yaml';
			const workspace = object(await f.client.workspaces.create(repository, { baseRef: 'refs/heads/staging', branchName: 'refs/heads/staging',
				mode: 'writable', allowedPaths: [typePath] }));
			const workspaceId = String(workspace.workspaceId); owned.add(workspaceId);
			await f.client.files.write(workspaceId, { path: typePath, allowProtected: true, content: JSON.stringify({
				schemaVersion: 'treeseed.proposal-type/v1', id: 'implementation', label: 'Implementation', description: 'Bounded native project change.' }) });
			const contract = object(await f.client.files.commit(workspaceId, { message: 'Controlled governed type for native recovery',
				author: { name: 'Native recovery fixture', email: 'native@example.invalid' } }));
			await f.client.workspaces.close(workspaceId); owned.delete(workspaceId);
			await f.store.upsertProjectTreeDxLibrary(projectId, { contentRepositoryRef: String(contract.commitSha) });
			const declaration = { id: 'proposal-' + randomUUID(), title: 'Retain the project Compose proposal', summary: 'Real source custody across a projection failure.',
				body: 'Make the project Compose workload usable without replacing retained products.', status: 'draft', groupIds: ['project-agent'], proposalTypes: ['implementation'] };
			const original = f.store.run.bind(f.store), outage = new Error('Controlled post-commit authoring journal outage');
			fault = vi.spyOn(f.store, 'run').mockImplementation(async (sql, params) => {
				if (sql.includes('INSERT INTO treedx_project_proxy_audit') && params?.includes('authoring_unpublished')) throw outage;
				return original(sql, params);
			});
			await expect(service.createProposal(f.principal, projectId, declaration)).rejects.toMatchObject({
				code: 'proposal_initial_projection_pending', status: 409, message: expect.stringContaining(declaration.id) });
			fault.mockRestore(); fault = undefined;
			const retained = await f.store.getGovernanceProposal(declaration.id); assert.ok(retained);
			const provenance = object(retained.metadata.contentProvenance);
			expect(provenance.repositoryId).toBe(repository); expect(String(provenance.commitSha)).toMatch(/^[a-f0-9]{40}$/u);
			const read = async (ref: string, path: string) => {
				const exact = await resolveKnowledgeGatewayConnection(f.store, { projectId, write: false, workspacePaths: [path], readRefs: [ref] }); assert.ok(exact);
				return object((await exact.client.readRepositoryFile({ repoId: repository, ref, path,
					encoding: 'utf8', parseFrontmatter: false, allowProtected: true })).file);
			};
			const exact = await read(String(provenance.commitSha), String(provenance.contentPath));
			expect(createHash('sha256').update(String(exact.content)).digest('hex')).toBe(provenance.digest);
			expect(parseFrontmatterDocument(String(exact.content)).frontmatter).toMatchObject({ id: declaration.id, groupIds: declaration.groupIds, request: declaration.body });
			expect((await f.query('SELECT content_hash FROM governance_proposal_versions WHERE proposal_id=?', [declaration.id])).rows)
				.toEqual([{ content_hash: provenance.digest }]);
			// Historical failure shape: native authored source exists without a SQL
			// proposal. Create it through the original writer, not seeded Git bytes.
			const orphan = { ...declaration, id: 'proposal-' + randomUUID(), title: 'Recover the unchanged Compose draft' };
			const authored = await commitProposalVersionContent({ store: f.store, principal: f.principal, initial: true,
				proposal: { ...orphan, teamId: 'team', projectId }, update: { groupIds: orphan.groupIds } });
			const open = String(authored.receipt.changeset.workspaceId); assert.ok(open); owned.add(open);
			await f.client.workspaces.close(open); owned.delete(open);
			expect(await f.store.getGovernanceProposal(orphan.id)).toBeNull();
			const recovered = await service.createProposal(f.principal, projectId, orphan);
			expect(recovered.authoringReceipt).toMatchObject({ commitSha: authored.receipt.commitSha, digest: authored.receipt.digest, changedPaths: [] });
			expect((await f.store.getGovernanceProposal(orphan.id))?.metadata.contentProvenance).toMatchObject({ commitSha: authored.receipt.commitSha, digest: authored.receipt.digest });
			const before = await f.query('SELECT id,active_content_hash,metadata_json FROM governance_proposals ORDER BY id');
			await expect(service.createProposal(f.principal, projectId, { ...orphan, id: 'foreign-' + randomUUID() })).rejects.toMatchObject({
				code: 'proposal_source_path_occupied', status: 409, message: expect.stringContaining(orphan.id) });
			expect(await f.query('SELECT id,active_content_hash,metadata_json FROM governance_proposals ORDER BY id')).toEqual(before);
			expect((await read(authored.receipt.commitSha, authored.receipt.path)).content).toBe((await read(recovered.authoringReceipt.commitSha, authored.receipt.path)).content);
		} finally {
			fault?.mockRestore();
			for (const workspace of owned) await f.client.workspaces.close(workspace);
			await f.close();
		}
	});
});
