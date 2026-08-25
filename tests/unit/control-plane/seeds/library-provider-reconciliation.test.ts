import { describe,expect,it } from 'vitest';
import { reconcileLibraryProvider } from '../../../../src/control-plane/seeds/apply-support/projects/projects-core/library-provider-reconciliation.ts';

describe('seed library provider reconciliation',()=>{
	it('adopts a private library and issues only an opaque TreeDX credential delivery',async()=>{
		const requests:Array<{path:string;authorization:string|null}>=[]; const writes:string[]=[];
		const fetchImpl=async(input:string|URL|Request,init?:RequestInit)=>{
			const url=new URL(input instanceof Request?input.url:String(input)); const authorization=new Headers(init?.headers).get('authorization');
			requests.push({path:url.pathname,authorization});
			if(url.pathname==='/repos/treeseed-ai/market-api-library') return Response.json({id:42,name:'market-api-library',private:true,owner:{login:'treeseed-ai'}});
			if(url.pathname.endsWith('/git/ref/heads/main')) return Response.json({object:{sha:'1'.repeat(40)}});
			if(url.pathname.endsWith('/git/ref/heads/staging')) return Response.json({object:{sha:'2'.repeat(40)}});
			return new Response(null,{status:404});
		};
		const store={
			async run(query:string){writes.push(query);return{};}, async all(){return[];},
			async first(query:string){
				if(query.includes('FROM remote_git_operation_grants')) return {id:'grant-1',expires_at:new Date(Date.now()+60_000).toISOString()};
				if(query.includes('FROM remote_credential_deliveries')) return {id:'delivery-1',expires_at:new Date(Date.now()+60_000).toISOString()};
				return null;
			},
		};
		await expect(reconcileLibraryProvider({store,teamId:'team',projectId:'project',projectSlug:'market-api',owner:'treeseed-ai',name:'market-api-library',visibility:'private',lifecycle:'create-or-adopt',env:{TREESEED_GITHUB_TOKEN:'provider-secret'},fetchImpl})).resolves.toEqual({heads:{main:'1'.repeat(40),staging:'2'.repeat(40)},credentialId:'delivery-1'});
		expect(requests.every((request)=>request.authorization==='Bearer provider-secret')).toBe(true);
		expect(writes.join('\n')).not.toContain('provider-secret');
		expect(writes.some((query)=>query.includes('project_remote_repository_bindings'))).toBe(true);
	});

	it('fails closed when a missing library cannot be created without control-plane credentials',async()=>{
		await expect(reconcileLibraryProvider({store:{},teamId:'team',projectId:'project',projectSlug:'sdk',owner:'treeseed-ai',name:'missing-library',visibility:'public',lifecycle:'create-or-adopt',env:{},fetchImpl:async()=>new Response(null,{status:404})})).rejects.toThrow('TREESEED_GITHUB_TOKEN');
	});
});
