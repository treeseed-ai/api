import { describe,expect,it } from 'vitest';
import { integrateAssignmentContent,readAssignmentContentIntegrations,resolveContentIntegrationRefs } from '../../../../../src/api/capacity/services/capacity/assignments/observability/assignment-content-integration-service.ts';

const base='1'.repeat(40); const commit='2'.repeat(40); const assignmentId='assignment_exact_content'; const teamId='team_exact';
function assignment(disposition='completed') { return { id:assignmentId,teamId,projectId:'project_exact',workDayId:'workday_exact',status:'completed',
	message:'',lifecycleOutput:{ completion:{ disposition },artifactManifest:{ mutationReceipts:[{ schemaVersion:'treeseed.artifact-mutation-receipt/v1',
		id:'receipt_provisional',kind:'treedx-content',phase:'provisional',assignmentId,modeRunId:'mode_exact',teamId,projectId:'project_exact',
		executionMode:'simulation',upstreamMutationPolicy:'denied',
		baseRef:base,effectiveRef:commit,changedPaths:['src/content/notes/exact.mdx'],before:{ref:base,artifactRefs:[]},
		after:{ref:commit,artifactRefs:['artifact_exact']},createdAt:'2026-08-14T00:00:00.000Z' }] } },
	treedxProxyHandle:{ branchName:`refs/heads/${assignmentId}` } }; }
function request(store:Record<string,unknown>,overrides:Record<string,unknown>={}) { return integrateAssignmentContent({ store:store as never,teamId,assignmentId,
	actorId:'reviewer_exact',idempotencyKey:'integration_exact',expectedBaseRef:base,expectedCommitSha:commit,reason:'Reviewed exact semantic artifact and relations.',
	workdayId:'workday_exact',simulateHuman:true,...overrides }); }

describe('assignment content integration',()=>{
	it('keeps simulation integration on its isolated assignment ref',()=>{
		expect(resolveContentIntegrationRefs({ executionMode:'simulation',sourceRef:'refs/heads/assignment-a',authoringBranch:'staging' })).toEqual({
			canonicalRef:'refs/heads/staging',targetRef:'refs/heads/assignment-a',simulation:true,
		});
		expect(resolveContentIntegrationRefs({ executionMode:'production',sourceRef:'refs/heads/assignment-a',authoringBranch:'staging' })).toEqual({
			canonicalRef:'refs/heads/staging',targetRef:'refs/heads/staging',simulation:false,
		});
	});
	it('rejects process completion whose declared outcome failed',async()=>{
		const store={ getProviderAssignment:async()=>assignment('failed') };
		await expect(request(store)).rejects.toMatchObject({ code:'assignment_content_not_completed' });
	});
	it('rejects a suspended conversation without its exact durable invocation response',async()=>{
		const suspended={...assignment(),status:'returned',leaseState:'released',executionKind:'conversation',lifecycleCode:'discussion_response_required',
			invocationId:'invocation-a',metadata:{operationalState:'suspended'}};
		const store={getProviderAssignment:async()=>suspended,first:async()=>null};
		await expect(request(store)).rejects.toMatchObject({code:'assignment_content_suspension_invalid'});
	});
	it('rejects review provenance from another workday',async()=>{
		const store={ getProviderAssignment:async()=>assignment() };
		await expect(request(store,{ workdayId:'workday_other' })).rejects.toMatchObject({ code:'assignment_content_workday_mismatch' });
	});
	it('replays the exact durable integrated receipt before making another TreeDX mutation',async()=>{
		const receipt={ ...assignment().lifecycleOutput.artifactManifest.mutationReceipts[0],phase:'integrated',id:'receipt_integrated' };
		const store={ getProviderAssignment:async()=>assignment(),first:async()=>({ data_json:JSON.stringify({ receipt }) }) };
		await expect(request(store)).resolves.toEqual({ receipt,relatedReceipts:[],journalReadBack:[],replayed:true });
	});
	it('reads back exact durable integration receipts for assignment proof',async()=>{
		const receipt={ ...assignment().lifecycleOutput.artifactManifest.mutationReceipts[0],phase:'integrated',id:'receipt_integrated',
			integration:{ actorId:'reviewer_exact',targetRef:`refs/heads/${assignmentId}`,observedRef:commit,
				observedPaths:['src/content/notes/exact.mdx'],canonicalRef:'refs/heads/staging',canonicalHeadBefore:base,canonicalHeadAfter:base },
			review:{ reviewerId:'reviewer_exact',disposition:'approved',evidenceReason:'Exact review passed.',workdayId:'workday_exact' } };
		const rows=[{ data_json:JSON.stringify({ receipt }),created_at:'2026-08-14T00:01:00.000Z' }];
		await expect(readAssignmentContentIntegrations({ all:async()=>rows } as never,teamId,assignmentId)).resolves.toEqual([
			{ receipt,readBackVerified:true,integratedAt:'2026-08-14T00:01:00.000Z' },
		]);
	});
	it('projects every exact related receipt from one reviewed integration',async()=>{
		const primary={ ...assignment().lifecycleOutput.artifactManifest.mutationReceipts[0],phase:'integrated',id:'receipt_integrated',
			integration:{actorId:'reviewer_exact',targetRef:`refs/heads/${assignmentId}`,observedRef:commit,observedPaths:['src/content/notes/exact.mdx'],canonicalRef:'refs/heads/staging',canonicalHeadBefore:base,canonicalHeadAfter:base},
			review:{reviewerId:'reviewer_exact',disposition:'approved',evidenceReason:'Exact review passed.',workdayId:'workday_exact'}};
		const related={...primary,id:'response_integrated',changedPaths:['src/content/discussion-messages/exact.mdx'],integration:{...primary.integration,observedPaths:['src/content/discussion-messages/exact.mdx']}};
		const rows=[{data_json:JSON.stringify({receipt:primary,relatedReceipts:[related]}),created_at:'2026-08-14T00:01:00.000Z'}];
		await expect(readAssignmentContentIntegrations({all:async()=>rows} as never,teamId,assignmentId)).resolves.toHaveLength(2);
	});
});
