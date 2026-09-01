import { createHash } from 'node:crypto';
import { ControlPlaneStore,isoNow,parseJson } from '../../../../persistence/store.ts';

export const MANAGED_TEAM_PROJECT_SLUG='team';
export const MANAGED_TEAM_PROJECT_KIND='system-team-library';
export const managedTeamLibraryRepositoryName=(teamId:string)=>`team-library-${createHash('sha256').update(teamId).digest('hex').slice(0,12)}`;
export const isManagedTeamLibraryRepositoryName=(teamId:string,name:string)=>name==='team-library'||name===managedTeamLibraryRepositoryName(teamId);

export async function ensureManagedTeamLibraryProjectMethod(this:ControlPlaneStore,teamId:string){
	await this.ensureInitialized();
	const existing=await this.getProjectByTeamAndSlug(teamId,MANAGED_TEAM_PROJECT_SLUG);
	if(existing){
		if(existing.metadata?.kind!==MANAGED_TEAM_PROJECT_KIND||existing.metadata?.systemManaged!==true)throw new Error('The reserved team project slug is occupied by a user-managed project.');
		return existing;
	}
	const repositoryName=managedTeamLibraryRepositoryName(teamId);
	const details=await this.createProject(teamId,{slug:MANAGED_TEAM_PROJECT_SLUG,name:'Team Library',description:'System-managed shared knowledge for this team.',metadata:{kind:MANAGED_TEAM_PROJECT_KIND,systemManaged:true,
		libraryOnly:true,library:{repositoryName,defaultBranch:'main',integrationBranch:'staging',status:'provisioning'},
		inventory:{status:'active'},provisioning:{state:'pending',requiredFiles:['README.md','objectives/core']}}});
	const project=details?.project??details,teamRow=await this.first('SELECT metadata_json FROM teams WHERE id = ? LIMIT 1',[teamId]);
	const metadata=parseJson(teamRow?.metadata_json,{});metadata.teamLibrary={projectId:project.id,projectSlug:MANAGED_TEAM_PROJECT_SLUG,state:'provisioning'};
	await this.run('UPDATE teams SET metadata_json = ?, updated_at = ? WHERE id = ?',[JSON.stringify(metadata),isoNow(),teamId]);
	return project;
}

export async function backfillManagedTeamLibraryProjectsMethod(this:ControlPlaneStore){
	await this.ensureInitialized();
	const teams=await this.all('SELECT id FROM teams ORDER BY created_at ASC');
	const results=[];for(const team of teams)results.push(await this.ensureManagedTeamLibraryProject(String(team.id)));
	return results;
}
