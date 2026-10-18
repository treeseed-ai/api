import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { relationAuthoringDatabase, object } from '../../../knowledge/workspaces/architecture/relation-authoring-fixture.ts';
import { commitProposalVersionContent } from '../../../../../../src/api/control-plane/governance/proposal-version-content.ts';
import { requireTreeDxOperation } from '../../../../../../src/api/control-plane/treedx/upstream-operation.ts';

// Real signed TreeDX and the original store on disposable native PostgreSQL.
// The selected library ref, type bytes and local retained file are controlled
// inputs; this does not claim governed approval, operator HTTP auth or dispatch.
describe('governed proposal contract authority with divergent native authoring', () => {
	it('creates from the selected governed schema without replacing local products and denies unpublished local-only types', async () => {
		const f = await relationAuthoringDatabase(true), owned = new Set<string>();
		const projectId = f.sources[0]!.projectId, repoId = f.sources[0]!.repository;
		const typePath = '.treeseed/governance/proposal-types/implementation.yaml';
		const retainedPath = 'discussion-messages/retained-native-proof.mdx', retained = 'Controlled retained local product\n';
		const contract = { schemaVersion:'treeseed.proposal-type/v1',id:'implementation',label:'Implementation',description:'Bounded native fixture work.' };
		const author = {name:'Native fixture',email:'native@example.invalid'};
		const readOperation = requireTreeDxOperation('readRepositoryFile');
		const read = async (ref:string,path:string) => object(await f.client.operation(readOperation.method,readOperation.path,
			{pathParams:{repo_id:repoId},body:{ref,path,encoding:'utf8',parseFrontmatter:false,allowProtected:true}}));
		const refs = async () => object(await f.client.repositories.refs(repoId)).refs as Array<{name:string;target:string}>;
		const head = async () => (await refs()).find(ref=>ref.name==='refs/heads/staging')!.target;
		const workspace = async (baseRef:string,branchName:string,allowedPaths:string[]) => {
			const result=object(await f.client.workspaces.create(repoId,{baseRef,branchName,mode:'writable',allowedPaths}));
			assert.equal(typeof result.workspaceId,'string');owned.add(String(result.workspaceId));return String(result.workspaceId);
		};
		try {
			const local = await workspace('refs/heads/staging','refs/heads/staging',[retainedPath]);
			await f.client.files.write(local,{path:retainedPath,content:retained});
			await f.client.files.commit(local,{message:'Retain original local input',author});
			await f.client.workspaces.close(local);owned.delete(local);
			const localBefore = await head();
			const governedRef='refs/heads/knowledge/native-contract-'+randomUUID();
			const governed = await workspace('refs/heads/main',governedRef,['.treeseed/governance/proposal-types/**']);
			await f.client.files.write(governed,{path:typePath,content:JSON.stringify(contract),allowProtected:true});
			const published=object(await f.client.files.commit(governed,{message:'Controlled governed contract input',author}));
			assert.match(String(published.commitSha),/^[a-f0-9]{40}$/u);
			await f.client.workspaces.close(governed);owned.delete(governed);
			await f.store.upsertProjectTreeDxLibrary(projectId,{contentRepositoryRef:governedRef});
			expect(await head()).toBe(localBefore);
			await expect(read('refs/heads/staging',typePath)).rejects.toMatchObject({status:404});
			const input={store:f.store,principal:{id:'operator-fixture'},initial:true,proposal:{id:'native-schema-proposal',teamId:'team',projectId,
				title:'Native schema custody',body:'Create this request without replacing retained local work.',proposalTypes:['implementation']},update:{}};
			const created=await commitProposalVersionContent(input);
			expect(created.receipt.changedPaths).toEqual(['proposals/governance/native-schema-custody.mdx']);
			expect(created.receipt.branchName).toBe('refs/heads/staging');
			expect(created.update.body).toBe(input.proposal.body);
			const proposalWorkspace=String(created.receipt.changeset.workspaceId??'');assert.ok(proposalWorkspace);
			owned.add(proposalWorkspace);await f.client.workspaces.close(proposalWorkspace);owned.delete(proposalWorkspace);
			const exact=await read(created.receipt.commitSha,retainedPath);
			expect(object(exact.file).content).toBe(retained);
			const product=await read(created.receipt.commitSha,created.receipt.path);
			expect(object(product.file).content).toContain(input.proposal.body);
			await expect(read(created.receipt.commitSha,typePath)).rejects.toMatchObject({status:404});
			const committed=await head();expect(committed).toBe(created.receipt.commitSha);
			await expect(commitProposalVersionContent(input)).rejects.toMatchObject({code:'proposal_source_path_occupied',status:409});
			expect(await head()).toBe(committed);
			const unreviewedPath='.treeseed/governance/proposal-types/unreviewed.yaml';
			const unreviewed=await workspace('refs/heads/staging','refs/heads/staging',[unreviewedPath]);
			await f.client.files.write(unreviewed,{path:unreviewedPath,content:JSON.stringify({...contract,id:'unreviewed'}),allowProtected:true});
			await f.client.files.commit(unreviewed,{message:'Controlled local-only schema input',author});
			await f.client.workspaces.close(unreviewed);owned.delete(unreviewed);
			const beforeDenied=await head();
			await expect(commitProposalVersionContent({...input,proposal:{...input.proposal,id:'denied',title:'Denied local schema',proposalTypes:['unreviewed']}}))
				.rejects.toMatchObject({code:'proposal_type_contract_missing',status:422,commitSha:published.commitSha});
			expect(await head()).toBe(beforeDenied);
			expect((await read(beforeDenied,retainedPath)).file).toMatchObject({content:retained});
			expect((await f.query('SELECT count(*)::int AS count FROM capacity_provider_assignments')).rows).toEqual([{count:0}]);
		} finally {
			try { for(const id of owned) {await f.client.workspaces.close(id);expect(object(await f.client.workspaces.get(id)).status).toBe('closed');} }
			finally { await f.close(); }
		}
	});
});
