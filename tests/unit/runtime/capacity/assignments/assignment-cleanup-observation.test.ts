import { describe,expect,it,vi } from 'vitest';
import { observeAssignmentCleanup } from '../../../../../src/api/capacity/services/capacity/assignments/observability/assignment-cleanup-observation-service.ts';

describe('assignment cleanup observation',()=>{
	it('proves a terminal content-only assignment has no durable residue',async()=>{
		const store={
			first:vi.fn().mockResolvedValue({count:0}),
			all:vi.fn().mockResolvedValue([
				{assignment_id:'assignment-a',result_status:'authoring_unpublished',metadata_json:JSON.stringify({commitSha:'a'.repeat(40)}),created_at:'2026-08-14T00:00:00Z'},
				{assignment_id:'assignment-a',result_status:'authoring_integrated',metadata_json:JSON.stringify({commitSha:'a'.repeat(40)}),created_at:'2026-08-14T00:00:01Z'},
			]),
		};
		const result=await observeAssignmentCleanup(store,{ id:'assignment-a',teamId:'team-a',projectId:'project-a',status:'completed',leaseState:'released',
			reservationId:'reservation-a',capabilityHandles:{ repository:[{status:'revoked'}],treeDx:[{status:'revoked'}] },lifecycleOutput:{artifactManifest:{}} });
		expect(result).toMatchObject({ verified:true,activeAssignments:0,activeLeases:0,activeReservations:0,activeDemands:0,
			activeWorkspaces:0,activeWorktrees:0,unpublishedBranches:0,staleAuthorities:0 });
	});

	it('treats a returned communication assignment as released custody',async()=>{
		const store={ first:vi.fn().mockResolvedValue({count:0}),all:vi.fn().mockResolvedValue([]) };
		const result=await observeAssignmentCleanup(store,{ id:'assignment-a',teamId:'team-a',projectId:'project-a',status:'returned',leaseState:'released',
			reservationId:'reservation-a',capabilityHandles:{ repository:[{status:'revoked'}],treeDx:[{status:'revoked'}] },lifecycleOutput:{artifactManifest:{}} });
		expect(result).toMatchObject({verified:true,activeAssignments:0,activeLeases:0,activeReservations:0,activeDemands:0,
			activeWorkspaces:0,activeWorktrees:0,unpublishedBranches:0,staleAuthorities:0});
	});

	it('fails closed for live authority, unpublished content, and source worktrees',async()=>{
		const store={ first:vi.fn().mockResolvedValue({count:1}),all:vi.fn().mockResolvedValue([
			{assignment_id:'assignment-a',result_status:'authoring_unpublished',metadata_json:JSON.stringify({commitSha:'b'.repeat(40)}),created_at:'2026-08-14T00:00:00Z'},
		]) };
		const result=await observeAssignmentCleanup(store,{ id:'assignment-a',teamId:'team-a',projectId:'project-a',status:'leased',leaseState:'leased',
			reservationId:'reservation-a',capabilityHandles:{ repository:[{status:'issued'}] },lifecycleOutput:{artifactManifest:{source:{worktreeRoot:'/tmp/worktree'}}} });
		expect(result).toMatchObject({ verified:false,activeAssignments:1,activeLeases:1,activeReservations:1,activeDemands:1,
			activeWorkspaces:1,activeWorktrees:1,unpublishedBranches:1 });
		expect(result.staleAuthorities).toBe(2);
	});
});
