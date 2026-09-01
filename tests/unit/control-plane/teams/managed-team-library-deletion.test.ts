import { describe, expect, it, vi } from 'vitest';
import { deleteManagedTeamLibraryResources } from '../../../../src/api/teams/managed-team-library-service.ts';
import { isManagedTeamLibraryRepositoryName,managedTeamLibraryRepositoryName } from '../../../../src/api/store/teams/contracts/managed-library/ensure-managed-team-library-project.ts';

describe('managed Team Library deletion', () => {
	it('deletes the exact GitHub repository and both team-scoped R2 prefixes', async () => {
		const repositoryName=managedTeamLibraryRepositoryName('team-1');
		const requests:string[]=[];
		const fetchImpl=vi.fn(async (input:string|URL|Request,init?:RequestInit) => {
			const url=String(input);requests.push(`${init?.method??'GET'} ${url}`);
			if(url.startsWith('https://api.github.com/'))return new Response(null,{status:204});
			if((init?.method??'GET')==='GET')return new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>',{status:200});
			return new Response(null,{status:204});
		});
		const result=await deleteManagedTeamLibraryResources({teamId:'team-1',project:{id:'project-team',metadata:{kind:'system-team-library',systemManaged:true,library:{owner:'treeseed-ai',repositoryName}}},
			env:{TREESEED_GITHUB_TOKEN:'github-token',TREESEED_CLOUDFLARE_ACCOUNT_ID:'account',TREESEED_CONTENT_BUCKET_NAME:'treeseed-dev-library',TREESEED_R2_ACCESS_KEY_ID:'access',TREESEED_R2_SECRET_ACCESS_KEY:'secret'},fetchImpl:fetchImpl as typeof fetch});
		expect(result).toEqual(expect.objectContaining({teamId:'team-1',github:{repository:`treeseed-ai/${repositoryName}`,deleted:true,alreadyAbsent:false},r2:expect.objectContaining({deletedObjects:0})}));
		expect(requests.some((request)=>request.startsWith(`DELETE https://api.github.com/repos/treeseed-ai/${repositoryName}`))).toBe(true);
		expect(requests.filter((request)=>request.startsWith('GET https://account.r2.cloudflarestorage.com/treeseed-dev-library/')).length).toBe(2);
	});

	it('derives stable collision-free identities and retains only the recorded legacy exception', async () => {
		const first=managedTeamLibraryRepositoryName('team-1'),second=managedTeamLibraryRepositoryName('team-2');
		expect(first).toMatch(/^team-library-[a-f0-9]{12}$/u);
		expect(first).not.toBe(second);
		expect(isManagedTeamLibraryRepositoryName('team-1',first)).toBe(true);
		expect(isManagedTeamLibraryRepositoryName('team-1','team-library')).toBe(true);
		expect(isManagedTeamLibraryRepositoryName('team-1',second)).toBe(false);
		await expect(deleteManagedTeamLibraryResources({teamId:'team-1',project:{id:'project-team',metadata:{kind:'system-team-library',systemManaged:true,library:{owner:'treeseed-ai',repositoryName:second}}},
			env:{TREESEED_GITHUB_TOKEN:'github-token'}})).rejects.toThrow('GitHub deletion authority is unavailable');
	});

	it('refuses to delete a normal project', async () => {
		await expect(deleteManagedTeamLibraryResources({teamId:'team-1',project:{id:'project-1',metadata:{}},env:{}}))
			.rejects.toThrow('protected system project');
	});
});
