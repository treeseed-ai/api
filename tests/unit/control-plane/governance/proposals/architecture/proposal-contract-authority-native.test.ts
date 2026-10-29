import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { compileWorkday, DEFAULT_WORKDAY_POLICY } from '@treeseed/sdk/agent-capacity';
import { describe, expect, it } from 'vitest';
import { relationAuthoringDatabase, object } from '../../../knowledge/workspaces/architecture/relation-authoring-fixture.ts';
import { commitProposalVersionContent } from '../../../../../../src/api/control-plane/governance/proposal-version-content.ts';
import { requireTreeDxOperation } from '../../../../../../src/api/control-plane/treedx/upstream-operation.ts';
import { parseFrontmatterDocument, serializeFrontmatterDocument } from '../../../../../../src/api/content/frontmatter.ts';
import { readyContributionProposal } from './ready-proposal-fixture.ts';

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
				title:'Native schema custody',body:'Create this request without replacing retained local work.',proposalTypes:['implementation']},
				update:{groupIds:['provider-runtime'],executionPlan:readyContributionProposal().executionPlan}};
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
			// A simulated estimate revises private proposal bytes, but its schema
			// remains the exact existing governed context frozen at activation.
			const workdayId='workday-'+randomUUID(),now=new Date().toISOString();
			const held={store:'treedx',model:'knowledge',id:projectId+':project-context',repository:repoId,commit:published.commitSha,path:'README.md'};
			const plan=compileWorkday({id:workdayId,teamId:'team',policyId:'default',policyRevision:1,executionMode:'simulation',startsAt:now,agentIds:[],policy:{...DEFAULT_WORKDAY_POLICY,durationSeconds:3600,maximumConcurrency:1}});
			const parameters={groupIds:input.update.groupIds,appliedPlan:{...plan,state:'active',activatedAt:now},scheduledProjectIds:[projectId],proposalIds:[input.proposal.id],workdayContextByProjectId:{[projectId]:held}};
			await f.query('INSERT INTO capacity_workday_runs (id,team_id,execution_kind,execution_mode,status,parameters_json,started_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',[workdayId,'team','workday','simulation','running',JSON.stringify(parameters),now,now,now]);
			// Moving current library authority cannot replace the original freeze.
			await f.store.upsertProjectTreeDxLibrary(projectId,{contentRepositoryRef:'refs/heads/main'});
			const revision={...input,initial:false,proposal:{...input.proposal,activeVersion:1,activeContentHash:created.receipt.digest,metadata:{contentProvenance:{repositoryId:repoId,contentPath:created.receipt.path,commitSha:created.receipt.commitSha,digest:created.receipt.digest}}},update:{workdayId,request:'Genuine estimate revision on exact prior private source.'}};
			const revised=await commitProposalVersionContent(revision);
			expect(revised.update.body).toBe(revision.update.request);
			const revisedSource=object((await read(revised.receipt.commitSha,revised.receipt.path)).file).content;
			const revisedDefinition=parseFrontmatterDocument(String(revisedSource)).frontmatter;
			expect(revisedDefinition.executionPlan).toEqual(input.update.executionPlan);
			expect(revisedDefinition.groupIds).toEqual(input.update.groupIds);
			// Retained TreeDX commit exists but SQL still indexes the old source:
			// replay the real authoring boundary, not a hand-coded base=head retry.
			const {store:authorityStore,...revisionData}=revision;
			const heldRevision=structuredClone(revisionData),beforeReplay=await f.query('SELECT * FROM capacity_provider_assignments');
			const recovered=await commitProposalVersionContent(revision);
			expect(recovered.receipt.commitSha).toBe(revised.receipt.commitSha);
			expect(recovered.receipt.changedPaths).toEqual([]);
			expect(revision).toEqual({store:authorityStore,...heldRevision});
			expect(await f.query('SELECT * FROM capacity_provider_assignments')).toEqual(beforeReplay);
			const recoveredRead=await read(recovered.receipt.commitSha,recovered.receipt.path);
			expect(createHash('sha256').update(String(object(recoveredRead.file).content)).digest('hex')).toBe(recovered.receipt.digest);
			const replayWorkspace=String(recovered.receipt.changeset.workspaceId??'');
			expect(replayWorkspace).not.toBe('');
			expect(object(await f.client.workspaces.get(replayWorkspace)).status).toBe('closed');
			expect((await read(revised.receipt.commitSha,retainedPath)).file).toMatchObject({content:retained});
			await expect(read(revised.receipt.commitSha,typePath)).rejects.toMatchObject({status:404});
			expect(await head()).toBe(created.receipt.commitSha);
			const frozenSource=await read(String(published.commitSha),typePath);expect(object(frozenSource.file).content).toBe(JSON.stringify(contract));
			const beforeDeny=await f.query('SELECT * FROM capacity_provider_assignments');
			for(const invalid of [undefined,{...held,repository:'foreign-repository'},{...held,commit:'staging'},{...held,store:'git'},{...held,model:'proposal'}]){
				await f.query('UPDATE capacity_workday_runs SET parameters_json=? WHERE id=?',[JSON.stringify({...parameters,workdayContextByProjectId:invalid?{[projectId]:invalid}:{}}),workdayId]);
				await expect(commitProposalVersionContent(revision)).rejects.toMatchObject({code:'proposal_simulation_contract_authority_required',status:409});
				expect(await f.query('SELECT * FROM capacity_provider_assignments')).toEqual(beforeDeny);expect(await head()).toBe(created.receipt.commitSha);
			}
			await f.store.upsertProjectTreeDxLibrary(projectId,{contentRepositoryRef:governedRef});
			const committed=await head();expect(committed).toBe(created.receipt.commitSha);
			await expect(commitProposalVersionContent({...input,proposal:{...input.proposal,body:'Different content cannot replace the original initial proposal.'}})).rejects.toMatchObject({code:'proposal_source_path_occupied',status:409});
			expect(await head()).toBe(committed);
			// Agent planning publishes a private document that need never exist on
			// staging. A normal human partial revision must preserve that exact plan.
			const privatePath='proposals/native-private-planning.mdx',privateBranch='refs/heads/native-private-'+randomUUID();
			const privateDefinition={...readyContributionProposal(),id:'native-private-planning',projectId};
			const privateSource=serializeFrontmatterDocument(privateDefinition,'Retained agent planning source.');
			const privateWorkspace=await workspace(committed,privateBranch,[privatePath]);
			await f.client.files.write(privateWorkspace,{path:privatePath,content:privateSource});
			const privateCommit=object(await f.client.files.commit(privateWorkspace,{message:'Controlled private planning input',author}));
			await f.client.workspaces.close(privateWorkspace);owned.delete(privateWorkspace);
			await expect(read('refs/heads/staging',privatePath)).rejects.toMatchObject({status:404});
			const privateDigest=createHash('sha256').update(privateSource).digest('hex');
			const privateProposal={...input.proposal,id:privateDefinition.id,title:privateDefinition.title,body:privateDefinition.request,
				summary:privateDefinition.summary,activeVersion:1,activeContentHash:privateDigest,metadata:{contentProvenance:{
					repositoryId:repoId,contentPath:privatePath,commitSha:privateCommit.commitSha,digest:privateDigest}}};
			const custody=privateProposal.metadata.contentProvenance;
			for(const [invalid,code] of [
				[{...privateProposal,id:'foreign-proposal'},'proposal_identity_mismatch'],
				[{...privateProposal,activeContentHash:'0'.repeat(64)},'proposal_digest_mismatch'],
				[{...privateProposal,metadata:{contentProvenance:{...custody,commitSha:'staging'}}},'proposal_exact_source_missing'],
			] as const){
				await expect(commitProposalVersionContent({store:f.store,principal:{id:'operator-fixture'},proposal:invalid,
					update:{body:'Denied partial edit.'}})).rejects.toMatchObject({status:409,code});
				expect(await head()).toBe(committed);
			}
			const partial=await commitProposalVersionContent({store:f.store,principal:{id:'operator-fixture'},proposal:privateProposal,
				update:{body:'Operator feedback; preserve every existing contribution and estimate.'}});
			const partialSource=String(object((await read(partial.receipt.commitSha,privatePath)).file).content);
			const partialDefinition=parseFrontmatterDocument(partialSource).frontmatter;
			expect(partialDefinition.executionPlan).toEqual(privateDefinition.executionPlan);
			expect(partialDefinition.groupIds).toEqual(privateDefinition.groupIds);
			expect(partialDefinition.request).toBe(partial.update.body);
			expect(partial.receipt.changedPaths).toEqual([privatePath]);
			expect(createHash('sha256').update(partialSource).digest('hex')).toBe(partial.receipt.digest);
			expect(object((await read(String(privateCommit.commitSha),privatePath)).file).content).toBe(privateSource);
			expect((await read(partial.receipt.commitSha,retainedPath)).file).toMatchObject({content:retained});
			const partialWorkspace=String(partial.receipt.changeset.workspaceId??'');assert.ok(partialWorkspace);
			owned.add(partialWorkspace);await f.client.workspaces.close(partialWorkspace);owned.delete(partialWorkspace);
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
