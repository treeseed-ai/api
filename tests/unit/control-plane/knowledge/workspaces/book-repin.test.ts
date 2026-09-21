import { describe,expect,it,vi } from 'vitest';
import { createKnowledgeWorkspaceService } from '../../../../../src/api/control-plane/knowledge/knowledge-workspace-service.ts';
import { managedTeamLibrarySeedFiles } from '../../../../../src/api/teams/managed-team-library-service.ts';
import { resolveKnowledgeGatewayConnection } from '../../../../../src/api/knowledge/gateway-treedx-connection.ts';

vi.mock('../../../../../src/api/knowledge/gateway-treedx-connection.ts',async(original)=>({
	...await original<typeof import('../../../../../src/api/knowledge/gateway-treedx-connection.ts')>(),
	resolveKnowledgeGatewayConnection:vi.fn(),
}));

describe('Book revision custody',()=>{
	it('repins every existing page in the same governed changeset as its Book update',async()=>{
		const seed=managedTeamLibrarySeedFiles('project');
		const bookPath='books/team-operations.md';
		const pagePath='knowledge/team-operations/communication-standards.md';
		const workspace={id:'draft-1',projectId:'project',actorUserId:'author',status:'draft',version:1,
			treeDxWorkspaceId:'remote',baseCommitSha:'a'.repeat(40),baseRef:'staging',
			branchName:'refs/heads/knowledge/draft-1',allowedPaths:['books/**','knowledge/**']};
		const client={
			readFile:vi.fn(async({path}:{path:string})=>({sha:'existing-sha',content:seed[path]})),
			listRepositoryPaths:vi.fn(async()=>({resolvedRef:'a'.repeat(40),entries:[{path:bookPath},{path:pagePath}],page:{hasMore:false}})),
			status:vi.fn(async()=>({changes:[]})),
			applyChangeset:vi.fn(async(_input:{patch:string})=>({applied:true})),
		};
		vi.mocked(resolveKnowledgeGatewayConnection).mockResolvedValue({client,contentPath:'.',repositoryId:'repo-1'} as never);
		const store={
			getKnowledgeWorkspace:vi.fn(async()=>workspace),
			getProjectDetails:vi.fn(async()=>({project:{id:'project',teamId:'team'}})),
			principalCanAccessTeam:vi.fn(async()=>true),
			getTeamAccessSummary:vi.fn(async()=>({permissions:['knowledge:author']})),
			updateKnowledgeWorkspace:vi.fn(async()=>({ok:true,workspace:{...workspace,version:2}})),
			recordAuditEvent:vi.fn(async()=>undefined),
		};
		const service=createKnowledgeWorkspaceService(store,{projectCatalog:vi.fn(async()=>({books:[],pages:[]}))});
		await service.updateContent({id:'author'},workspace.id,{kind:'book',version:1,sourcePath:bookPath,
			id:'team-operations',slug:'team-operations',title:'Team Operations',summary:'Updated team standards.',
			visibility:'team',order:0});
		const patch=client.applyChangeset.mock.calls[0]?.[0]?.patch ?? '';
		expect(patch).toContain(bookPath);
		expect(patch).toContain(pagePath);
		expect(patch).toContain('revision: 2');
	});
});
