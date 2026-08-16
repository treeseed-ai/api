import { beforeEach,describe,expect,it,vi } from 'vitest';
import { abandonAssignmentContent } from '../../../../../src/api/capacity/services/capacity/assignments/observability/assignment-content-abandonment-service.ts';
import { resolveKnowledgeGatewayConnection } from '../../../../../src/api/knowledge/gateway-treedx-connection.ts';

vi.mock('../../../../../src/api/knowledge/gateway-treedx-connection.ts',()=>({resolveKnowledgeGatewayConnection:vi.fn()}));

const first='a'.repeat(40);const second='b'.repeat(40);const assignmentId='assignment-failed';
function assignment(status='failed'){return{id:assignmentId,teamId:'team-a',projectId:'project-a',workDayId:'workday-a',status,leaseState:'released',treedxProxyHandle:{branchName:`refs/heads/${assignmentId}`}};}
function store(rows:Record<string,unknown>[]){return{
	getProviderAssignment:vi.fn().mockResolvedValue(assignment()),getProject:vi.fn().mockResolvedValue({teamId:'team-a'}),upsertProjectTreeDxLibrary:vi.fn(),first:vi.fn().mockResolvedValue(null),
	all:vi.fn().mockImplementation(async()=>rows),run:vi.fn().mockImplementation(async(_query:string,params:unknown[])=>{rows.push({assignment_id:assignmentId,result_status:params[7],metadata_json:params[8],created_at:params[9]});}),recordAuditEvent:vi.fn(),
};}
function request(candidate:ReturnType<typeof store>,overrides:Record<string,unknown>={}){return abandonAssignmentContent({store:candidate as never,teamId:'team-a',assignmentId,actorId:'operator-a',idempotencyKey:'abandon-a',expectedCommitShas:[first,second],reason:'Failed diagnostic content is obsolete.',workdayId:'workday-a',simulateHuman:true,...overrides});}

describe('assignment content abandonment',()=>{
	beforeEach(()=>vi.mocked(resolveKnowledgeGatewayConnection).mockReset());
	it('rejects nonterminal assignments, integrated results, and inexact journal evidence',async()=>{
		const candidate=store([]);candidate.getProviderAssignment.mockResolvedValue(assignment('leased'));
		await expect(request(candidate)).rejects.toMatchObject({code:'assignment_content_abandonment_status_invalid'});
		candidate.getProviderAssignment.mockResolvedValue(assignment('completed'));candidate.first.mockResolvedValue({id:'integration-a'});
		await expect(request(candidate)).rejects.toMatchObject({code:'assignment_content_abandonment_integrated'});
		candidate.first.mockResolvedValue(null);
		candidate.getProviderAssignment.mockResolvedValue(assignment());
		await expect(request(candidate,{expectedCommitShas:[first]})).rejects.toMatchObject({code:'assignment_content_abandonment_refs_mismatch'});
	});
	it('never treats a protected authoring ref as disposable assignment state',async()=>{
		const candidate=store([]);candidate.getProviderAssignment.mockResolvedValue({...assignment(),treedxProxyHandle:{branchName:'refs/heads/staging'}});
		await expect(request(candidate)).rejects.toMatchObject({code:'assignment_content_abandonment_ref_not_isolated'});
	});
	it('discards the exact isolated ref, journals every commit, and proves no unpublished residue',async()=>{
		const rows=[
			{assignment_id:assignmentId,result_status:'authoring_unpublished',metadata_json:JSON.stringify({repositoryId:'repo-a',commitSha:first,ref:`refs/heads/${assignmentId}`,changedPaths:['src/content/one.mdx']}),created_at:'2026-08-15T00:00:00Z'},
			{assignment_id:assignmentId,result_status:'authoring_unpublished',metadata_json:JSON.stringify({repositoryId:'repo-a',commitSha:second,ref:`refs/heads/${assignmentId}`,changedPaths:['src/content/two.mdx']}),created_at:'2026-08-15T00:00:01Z'},
		];const candidate=store(rows);candidate.getProviderAssignment.mockResolvedValue(assignment('completed'));const discardOrphanRef=vi.fn().mockResolvedValue({status:'discarded'});let reads=0;
		vi.mocked(resolveKnowledgeGatewayConnection).mockResolvedValue({repositoryId:'repo-a',client:{discardOrphanRef,listRepositoryRefs:vi.fn().mockImplementation(async()=>reads++===0?[{name:`refs/heads/${assignmentId}`,target:second}]:[])}} as never);
		const result=await request(candidate);
		expect(discardOrphanRef).toHaveBeenCalledWith({repoId:'repo-a',ref:`refs/heads/${assignmentId}`,expectedHead:second,reason:'Failed diagnostic content is obsolete.'});
		expect(result).toMatchObject({expectedCommitShas:[first,second],abandonedCommitShas:[first,second],readBackVerified:true,replayed:false});
		expect(candidate.recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({eventType:'assignment.content.abandoned'}));
	});
});
