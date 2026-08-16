import { describe,expect,it,vi } from 'vitest';
import { preflightProviderAssignmentCompletion } from '../../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-completion-preflight-service.ts';

const assignment={id:'assignment-a',teamId:'team-a',projectId:'project-a',capacityProviderId:'provider-a',membershipId:'membership-a',status:'leased',leaseState:'leased',leaseToken:'lease-a',workDayId:'workday-a',metadata:{workdayRunId:'run-a'},decisionInput:{input:{repositoryId:'repo-a',semanticArtifactExpectations:[]}}};
const manifest={schemaVersion:1,assignmentId:'assignment-a',modeRunId:'mode-a',teamId:'team-a',projectId:'project-a',providerId:'provider-a',mode:'planning',agentClassId:'writer',agentId:'writer',handlerId:'execution-content',activityType:'planning',status:'completed',summary:'Exact output.',toolEvents:[],contentReferences:[],verification:[{status:'passed',summary:'Exact completion checks passed.'}],citations:[],signals:[],usage:[],diagnostics:[],createdAt:'2026-08-16T00:00:00.000Z'};

describe('assignment semantic completion preflight',()=>{
	it('persists a durable pre-settlement receipt for the exact active lease',async()=>{
		const createCapacityWorkdayEvent=vi.fn(async(_team:string,_run:string,input:Record<string,unknown>)=>input);
		const result=await preflightProviderAssignmentCompletion({ensureInitialized:vi.fn(),getProviderAssignment:vi.fn(async()=>assignment),createCapacityWorkdayEvent,config:{}} as never,{teamId:'team-a',membershipId:'membership-a',capacityProviderId:'provider-a'},'assignment-a',{leaseToken:'lease-a',idempotencyKey:'assignment:assignment-a:semantic-completion-preflight',artifactManifest:manifest});
		expect(result).toMatchObject({assignmentId:'assignment-a',required:false,assertions:[]});
		expect(createCapacityWorkdayEvent).toHaveBeenCalledWith('team-a','run-a',expect.objectContaining({eventType:'assignment.semantic_completion_preflight_passed',assignmentId:'assignment-a'}));
	});

	it('rejects a stale or foreign lease before accepting artifact evidence',async()=>{
		await expect(preflightProviderAssignmentCompletion({ensureInitialized:vi.fn(),getProviderAssignment:vi.fn(async()=>assignment),config:{}} as never,{teamId:'team-a',membershipId:'membership-a',capacityProviderId:'provider-a'},'assignment-a',{leaseToken:'wrong',idempotencyKey:'assignment:assignment-a:semantic-completion-preflight',artifactManifest:manifest})).rejects.toMatchObject({code:'assignment_completion_preflight_lease_invalid'});
	});

	it('rejects a schema-valid artifact whose exact repository body misses required claims',async()=>{
		const expectedAssignment={...assignment,decisionInput:{input:{repositoryId:'repo-a',semanticArtifactExpectations:[{id:'guide-note',agentId:'writer',activityType:'planning',model:'note',pathPrefix:'src/content/notes/editorial/',subjectRefs:['objective:core'],relationFields:['relatedObjectives'],requiredClaims:['Reader Journey']}]}}};
		const ref='a'.repeat(40);const withArtifact={...manifest,contentReferences:[{model:'note',contentPath:'src/content/notes/editorial/draft.mdx',commitSha:ref,subjectId:'objective:core',subjectField:'relatedObjectives',artifactKind:'planning_note'}]};
		const fetchImpl=vi.fn(async()=>new Response(JSON.stringify({files:[{path:'src/content/notes/editorial/draft.mdx',frontmatter:{relatedObjectives:['objective:core']},content:'A generic draft without the required section.'}]}),{status:200,headers:{'content-type':'application/json'}}));
		await expect(preflightProviderAssignmentCompletion({ensureInitialized:vi.fn(),getProviderAssignment:vi.fn(async()=>expectedAssignment),getProjectTreeDxLibrary:vi.fn(async()=>({repositoryId:'repo-a',topology:{contentRepository:{treeDx:{baseUrl:'https://treedx.test'}}}})),createCapacityWorkdayEvent:vi.fn(),config:{fetchImpl,TREESEED_TREEDX_JWT_HS256_SECRET:'x'.repeat(32)}} as never,{teamId:'team-a',membershipId:'membership-a',capacityProviderId:'provider-a'},'assignment-a',{leaseToken:'lease-a',idempotencyKey:'assignment:assignment-a:semantic-completion-preflight',artifactManifest:withArtifact})).rejects.toMatchObject({code:'assignment_semantic_artifact_preflight_failed'});
	});
});
