import { describe,expect,it,vi } from 'vitest';
import { openDiscussionWorkspace } from '../../../src/api/discussions/discussion-workspace.ts';

function journalStore(rows:Array<Record<string,unknown>>=[]){
	return {
		getProject:vi.fn().mockResolvedValue({teamId:'team-a'}),
		upsertProjectTreeDxLibrary:vi.fn(),
		all:vi.fn().mockResolvedValue(rows),
		run:vi.fn().mockResolvedValue({}),
	};
}

describe('Discussion TreeDX workspace recovery',()=>{
	it('journals the workspace identity before opening it and closes the journal after TreeDX cleanup',async()=>{
		const order:string[]=[]; const store=journalStore();
		store.run.mockImplementation(async(_sql:string,params:unknown[])=>{order.push(String(params[6]));});
		const client={
			createWorkspace:vi.fn(async(input:Record<string,unknown>)=>{order.push('create');return {workspaceId:input.workspaceId};}),
			closeWorkspace:vi.fn(async()=>{order.push('close');}),
		};
		const session=await openDiscussionWorkspace({store,connection:{repositoryId:'repo-a',allowedPaths:['src/content/discussions/**'],client},projectId:'project-a',branchName:'refs/heads/staging',operationKey:'message:key-a'});
		await session.close();
		expect(order).toEqual(['authoring_workspace_open','create','close','authoring_workspace_closed']);
	});

	it('retires a stale journaled attempt before creating a replacement',async()=>{
		const metadata={repositoryId:'repo-a',workspaceId:'ws_stale',operationKey:'event:key-a',ref:'refs/heads/staging'};
		const store=journalStore([{result_status:'authoring_workspace_open',metadata_json:JSON.stringify(metadata),created_at:'2020-01-01T00:00:00.000Z'}]);
		const client={createWorkspace:vi.fn(async(input:Record<string,unknown>)=>({workspaceId:input.workspaceId})),closeWorkspace:vi.fn().mockResolvedValue(undefined)};
		await openDiscussionWorkspace({store,connection:{repositoryId:'repo-a',allowedPaths:['src/content/discussion-events/**'],client},projectId:'project-a',branchName:'refs/heads/staging',operationKey:'event:key-a'});
		expect(client.closeWorkspace).toHaveBeenCalledWith('ws_stale');
		expect(client.createWorkspace).toHaveBeenCalledOnce();
	});

	it('does not steal a concurrent authoring attempt during its recovery grace window',async()=>{
		const metadata={repositoryId:'repo-a',workspaceId:'ws_active',operationKey:'message:key-a',ref:'refs/heads/staging'};
		const store=journalStore([{result_status:'authoring_workspace_open',metadata_json:JSON.stringify(metadata),created_at:new Date().toISOString()}]);
		const client={createWorkspace:vi.fn(),closeWorkspace:vi.fn()};
		await expect(openDiscussionWorkspace({store,connection:{repositoryId:'repo-a',allowedPaths:['**'],client},projectId:'project-a',branchName:'refs/heads/staging',operationKey:'message:key-a'})).rejects.toMatchObject({code:'discussion_authoring_active'});
		expect(client.closeWorkspace).not.toHaveBeenCalled();
	});
});
