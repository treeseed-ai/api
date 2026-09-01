import { ensureProjectKnowledgeBinding } from '../../control-plane/seeds/apply-support/projects/projects-core/project-knowledge-binding.ts';
import { reconcileLibraryProvider } from '../../control-plane/seeds/apply-support/projects/projects-core/library-provider-reconciliation.ts';
import { createR2PublicationClient } from '../providers/cloudflare/r2-publication-client.ts';
import { enqueueTreeDxCommitReplication } from '../capacity/services/treedx/repositories/treedx-commit-replication.ts';
import { isManagedTeamLibraryRepositoryName,managedTeamLibraryRepositoryName } from '../store/teams/contracts/managed-library/ensure-managed-team-library-project.ts';

const text=(...values:unknown[])=>values.find((value)=>typeof value==='string'&&value.trim())?.toString().trim()??'';
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};

const seedFiles:Record<string,string>={
	'README.md':'# Team Library\n\nSystem-managed, team-wide knowledge for communication, governance, research, management delegation, and cross-project coordination.\n',
	'objectives/core.mdx':'---\nid: team-core\ntitle: Team Core Objective\nstatus: active\ngroup_ids: []\n---\n\nBuild a coherent engineering team whose projects share trustworthy knowledge, coordinate explicitly, and preserve project-scoped authority.\n',
	'knowledge/communication-standards.mdx':'---\nid: team-communication-standards\ntitle: Team Communication Standards\nstatus: active\n---\n\nCommunicate decisions, uncertainty, evidence, owners, and next actions clearly. Use cross-project discussions for coordination without weakening project-scoped writes.\n',
	'knowledge/governance.mdx':'---\nid: team-governance\ntitle: Team Governance\nstatus: active\n---\n\nQuestions request clarification. Proposals request governed change. Agents must not represent a proposal as approved without the corresponding governance action.\n',
	'knowledge/research-and-citation.mdx':'---\nid: team-research-citation\ntitle: Research and Citation\nstatus: active\n---\n\nDistinguish evidence from inference, cite authoritative sources, report uncertainty, and preserve enough provenance for another contributor to verify the conclusion.\n',
	'knowledge/management-delegation.mdx':'---\nid: team-management-delegation\ntitle: Management Delegation\nstatus: active\n---\n\nTranslate direction into explicit outcomes, constraints, owners, dependencies, verification, and escalation conditions. Never broaden authority implicitly.\n',
	'knowledge/cross-project-coordination.mdx':'---\nid: team-cross-project-coordination\ntitle: Cross-project Coordination\nstatus: active\n---\n\nRead across authorized team projects to understand consequences. Keep every write and commit bound to the assignment owning project.\n',
	'agent-context-queries/team-shared-foundations.mdx':'---\nid: team-shared-foundations\ntitle: Team Shared Foundations\ndescription: Retrieve team communication, governance, research, delegation, and cross-project coordination guidance.\nrevision: 1\nmaturity: validated\npurpose: research\nquery: communication governance research citation management delegation cross-project coordination\ntarget:\n  kind: content\n  paths: [knowledge/**]\nrelations: [related, references]\ndepth: 1\nresultLimit: 20\ncontextBudget:\n  maxItems: 20\n  maxCharacters: 24000\ntokenBudget: 6000\nformat: summary\nsources:\n  - scope: current-project\nrequirement: preferred\npriority: 80\nsummarization: deterministic\nfilters: {}\n---\n\nTeam-wide foundations used by project agent context queries.\n',
	'agent-tests/team-shared-foundations.mdx':'---\nid: team-shared-foundations-test\nagent: system-team-library\nkind: context-query\nqueryRef:\n  id: team-shared-foundations\n  revision: 1\ntestRef: team-shared-foundations-test-v1\nexpectedIdentities: []\nexpectedRelations: []\nexpectedPaths: []\nexpectedSchemaVersions: []\nresultBounds:\n  min: 0\n  max: 20\nbudget:\n  maxContextItems: 20\n  maxTokens: 6000\nmaxLatencyMs: 10000\n---\n\nVerifies that the managed Team Library query compiles and executes within its declared bounds.\n',
};

export async function reconcileManagedTeamLibrary(store:any,teamId:string,env:NodeJS.ProcessEnv=process.env) {
	const team=await store.getTeam(teamId),project=await store.ensureManagedTeamLibraryProject(teamId);
	if(!team||!project)throw new Error('Managed Team Library identity is unavailable.');
	const metadata=record(team.metadata),configuredOwner=text(env.TREESEED_GITHUB_LIBRARY_OWNER,env.TREESEED_GITHUB_OWNER,metadata.githubOwner,metadata.repositoryOwner);
	let owner=configuredOwner;
	if(!owner) {
		const binding=await store.first(`SELECT binding.owner FROM project_remote_repository_bindings binding
			JOIN projects project ON project.id = binding.project_id
			WHERE project.team_id = ? AND binding.owner IS NOT NULL AND binding.owner <> ''
			ORDER BY binding.updated_at DESC LIMIT 1`,[teamId]);
		owner=text(binding?.owner);
	}
	if(!owner) {
		const projects=await store.listTeamProjects(teamId);
		for(const candidate of projects)for(const repository of await store.listHubRepositories(String(candidate.id)))if(repository.owner){owner=String(repository.owner);break;}
	}
	if(!owner)throw new Error('A GitHub library owner must be configured before the managed Team Library can be provisioned.');
	const projectLibrary=record(record(project.metadata).library),repositoryName=text(projectLibrary.repositoryName,managedTeamLibraryRepositoryName(teamId));
	if(!isManagedTeamLibraryRepositoryName(teamId,repositoryName))throw new Error('Managed Team Library repository identity does not match its owning team.');
	const provider=await reconcileLibraryProvider({store,teamId,projectId:String(project.id),projectSlug:'team',owner,name:repositoryName,visibility:'private',lifecycle:'create-or-adopt',env,fetchImpl:store.config?.fetchImpl,seedFiles});
	const binding=await ensureProjectKnowledgeBinding({store,projectId:String(project.id),teamId,projectSlug:'team',libraryRoot:'.',libraryRef:'refs/remotes/origin/staging',libraryRepositoryUrl:`https://github.com/${owner}/${repositoryName}.git`,libraryDefaultBranch:'main',libraryCredentialId:provider.credentialId,expectedUpstreamHeads:provider.heads,env});
	const now=new Date().toISOString();
	await enqueueTreeDxCommitReplication(store,{teamId,projectId:String(project.id),commitSha:binding.resolvedRef,sourceRef:binding.sourceRef,createdAt:now});
	const replication=await store.first(`SELECT status,r2_status,r2_receipt_json FROM treedx_commit_replications
		WHERE project_id=? AND commit_sha=? LIMIT 1`,[project.id,binding.resolvedRef]);
	const r2Receipt=record(typeof replication?.r2_receipt_json==='string'?JSON.parse(replication.r2_receipt_json):replication?.r2_receipt_json);
	const mirrorReady=replication?.status==='complete'&&replication?.r2_status==='verified'
		&&r2Receipt.schemaVersion==='treeseed.treedx-r2-file-mirror/v2'&&r2Receipt.commitSha===binding.resolvedRef;
	const provisioning=mirrorReady?{state:'known-good',completedAt:now,requiredFiles:['README.md','objectives/core']}
		:{state:'replicating',updatedAt:now,requiredFiles:['README.md','objectives/core']};
	const projectMetadata={...record(project.metadata),library:{...projectLibrary,status:mirrorReady?'known-good':'replicating',owner,repositoryName,heads:provider.heads},provisioning};
	await store.run('UPDATE projects SET metadata_json = ?, updated_at = ? WHERE id = ?',[JSON.stringify(projectMetadata),now,project.id]);
	const teamMetadata={...metadata,teamLibrary:{projectId:project.id,projectSlug:'team',state:mirrorReady?'known-good':'replicating',repository:`${owner}/${repositoryName}`,repositoryName,repositoryId:binding.repositoryId}};
	await store.run('UPDATE teams SET metadata_json = ?, updated_at = ? WHERE id = ?',[JSON.stringify(teamMetadata),now,teamId]);
	return {teamId,projectId:project.id,repository:`${owner}/${repositoryName}`,state:mirrorReady?'known-good':'replicating',...binding};
}

export async function markManagedTeamLibraryMirrorKnownGood(store:any,input:{teamId:string;projectId:string;commitSha:string;r2Receipt:unknown}) {
	const project=await store.getProject(input.projectId);if(record(project?.metadata).kind!=='system-team-library')return false;
	const library=await store.getProjectTreeDxLibrary(input.projectId),metadata=record(library?.metadata),receipt=record(input.r2Receipt);
	if(text(metadata.resolvedRef)!==input.commitSha||receipt.schemaVersion!=='treeseed.treedx-r2-file-mirror/v2'||receipt.commitSha!==input.commitSha)return false;
	const now=new Date().toISOString(),projectMetadata={...record(project.metadata),library:{...record(record(project.metadata).library),status:'known-good'},
		provisioning:{state:'known-good',completedAt:now,requiredFiles:['README.md','objectives/core']}};
	await store.run('UPDATE projects SET metadata_json=?,updated_at=? WHERE id=?',[JSON.stringify(projectMetadata),now,input.projectId]);
	const team=await store.getTeam(input.teamId),teamMetadata={...record(team?.metadata),teamLibrary:{...record(record(team?.metadata).teamLibrary),state:'known-good'}};
	await store.run('UPDATE teams SET metadata_json=?,updated_at=? WHERE id=?',[JSON.stringify(teamMetadata),now,input.teamId]);return true;
}

export async function reconcileManagedTeamLibraries(store:any,env:NodeJS.ProcessEnv=process.env) {
	const projects=await store.backfillManagedTeamLibraryProjects(),results=[];
	for(const project of projects) {
		const teamId=String(project.teamId??project.team_id);
		try { results.push(await reconcileManagedTeamLibrary(store,teamId,env)); }
		catch(error) {
			const message=error instanceof Error?error.message:String(error);
			await store.run(`UPDATE projects SET metadata_json = jsonb_set(COALESCE(metadata_json::jsonb,'{}'::jsonb),
				'{provisioning}', jsonb_build_object('state','blocked','message',?::text,'updatedAt',?::text), true)::text,
				updated_at = ? WHERE id = ?`,[message,new Date().toISOString(),new Date().toISOString(),project.id]).catch(()=>undefined);
			results.push({teamId,projectId:project.id,state:'blocked',error:message});
		}
	}
	return results;
}

async function deleteR2Prefix(client:ReturnType<typeof createR2PublicationClient>,prefix:string) {
	const keys=await client.list(prefix);
	for(let offset=0;offset<keys.length;offset+=16)await Promise.all(keys.slice(offset,offset+16).map((key)=>client.delete(key)));
	return keys.length;
}

/** Permanently removes the externally owned resources of the system Team Library. */
export async function deleteManagedTeamLibraryResources(input:{teamId:string;project:Record<string,any>;env?:NodeJS.ProcessEnv;fetchImpl?:typeof fetch}) {
	if(input.project.metadata?.kind!=='system-team-library'||input.project.metadata?.systemManaged!==true)
		throw new Error('Managed Team Library cleanup requires the protected system project.');
	const env=input.env??process.env,fetchImpl=input.fetchImpl??fetch,library=record(input.project.metadata?.library);
	const owner=text(library.owner),name=text(library.repositoryName),token=text(env.TREESEED_GITHUB_TOKEN);
	if(!owner||!isManagedTeamLibraryRepositoryName(input.teamId,name)||!token)throw new Error('Managed Team Library GitHub deletion authority is unavailable.');
	const response=await fetchImpl(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,{
		method:'DELETE',headers:{accept:'application/vnd.github+json',authorization:`Bearer ${token}`,'user-agent':'treeseed-team-library-deleter','x-github-api-version':'2022-11-28'},
	});
	if(!response.ok&&response.status!==404)throw new Error(`GitHub Team Library deletion failed (HTTP ${response.status}).`);
	const common={accountId:text(env.TREESEED_CLOUDFLARE_ACCOUNT_ID),bucket:text(env.TREESEED_CONTENT_BUCKET_NAME)};
	const apiToken=text(env.TREESEED_CLOUDFLARE_API_TOKEN);
	const r2=apiToken?createR2PublicationClient({...common,authMode:'api-token',apiToken},fetchImpl)
		:createR2PublicationClient({...common,authMode:'s3',accessKeyId:text(env.TREESEED_R2_ACCESS_KEY_ID),secretAccessKey:text(env.TREESEED_R2_SECRET_ACCESS_KEY)},fetchImpl);
	if(!common.accountId||!common.bucket||(!apiToken&&(!text(env.TREESEED_R2_ACCESS_KEY_ID)||!text(env.TREESEED_R2_SECRET_ACCESS_KEY))))
		throw new Error('Managed Team Library R2 deletion authority is unavailable.');
	const teamSegment=encodeURIComponent(input.teamId);
	const [contentObjects,manifestObjects]=await Promise.all([
		deleteR2Prefix(r2,`teams/${teamSegment}/`),deleteR2Prefix(r2,`_treeseed/mirrors/teams/${teamSegment}/`),
	]);
	return {schemaVersion:'treeseed.team-library-deletion-receipt/v1',teamId:input.teamId,projectId:String(input.project.id),
		github:{repository:`${owner}/${name}`,deleted:true,alreadyAbsent:response.status===404},
		r2:{bucket:common.bucket,prefixes:[`teams/${teamSegment}/`,`_treeseed/mirrors/teams/${teamSegment}/`],deletedObjects:contentObjects+manifestObjects},
		completedAt:new Date().toISOString()};
}
