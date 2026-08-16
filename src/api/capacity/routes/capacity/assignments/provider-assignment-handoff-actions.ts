import { createHash,randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { CapacityGovernanceError } from '../../../database.ts';
import { appendDiscussionEvent,loadDiscussions } from '../../../../discussions/content.ts';
import { readCapacityRequestObject } from '../../support/request-json.ts';
import { requireProviderPrincipal } from '../providers/provider-auth.ts';
import { assertProviderOwnsAssignment,assignmentRecord as record,providerAssignmentErrorResponse as errorResponse,type ProviderAssignmentStore } from './provider-assignment-route-support.ts';

function text(value: unknown) { return typeof value === 'string' ? value.trim() : ''; }
function digest(value:unknown){ return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function assertCurrentLease(assignment:Record<string,unknown>,body:Record<string,unknown>){
	if(assignment.status!=='leased'||assignment.leaseState!=='leased'||assignment.leaseToken!==body.leaseToken||Number(assignment.stateVersion)!==Number(body.expectedStateVersion)) throw new CapacityGovernanceError('assignment_discussion_state_stale','Communication mutation requires the current leased assignment state and lease token.',409,{ stateVersion:assignment.stateVersion });
}

export function installProviderAssignmentHandoffActionRoutes(app:Hono,store:ProviderAssignmentStore){
	app.post('/v1/provider/assignments/:assignmentId/client-actions',async(c)=>{
		try{
			const principal=requireProviderPrincipal(c,['provider:assignments:write']); const assignmentId=c.req.param('assignmentId');
			const assignment=assertProviderOwnsAssignment(await store.getProviderAssignment(principal.teamId,assignmentId),principal,'request a client action for');
			const body=await readCapacityRequestObject(c); assertCurrentLease(assignment,body);
			const idempotencyKey=text(body.idempotencyKey); const kind=text(body.kind); const allowed=new Set(['navigate','reveal-resource','set-view-filter','populate-draft','present-confirmation']);
			if(!idempotencyKey||!allowed.has(kind))throw new CapacityGovernanceError('client_action_invalid','Client action requires a supported semantic kind and idempotency key.',400);
			const invocation=assignment.invocationId?await store.first(`SELECT requested_by_id FROM agent_invocation_requests WHERE id=? AND team_id=?`,[assignment.invocationId,assignment.teamId]):null;
			const userId=text(invocation?.requested_by_id); if(!userId)throw new CapacityGovernanceError('client_action_user_unavailable','The invocation has no authenticated target user.',409);
			const payload=record(body.payload); const requestDigest=digest({kind,payload,userId}); const replay=await store.first(`SELECT * FROM agent_client_actions WHERE assignment_id=? AND idempotency_key=?`,[assignmentId,idempotencyKey]);
			if(replay){ if(replay.request_digest!==requestDigest)throw new CapacityGovernanceError('client_action_idempotency_conflict','The idempotency key is already bound to another client action.',409); return c.json({ok:true,payload:replay,replayed:true}); }
			const now=new Date(); const session=await store.first(`SELECT * FROM agent_client_sessions WHERE user_id=? AND team_id=? AND project_id=? AND status='active' AND expires_at>? AND capabilities_json LIKE ? ORDER BY heartbeat_at DESC LIMIT 1`,[userId,assignment.teamId,assignment.projectId,now.toISOString(),`%${kind}%`]);
			const status=session?'pending':'unavailable'; const id=randomUUID(); const expiresAt=new Date(now.getTime()+Math.max(1,Math.min(300,Number(body.ttlSeconds)||30))*1000).toISOString();
			await store.run(`INSERT INTO agent_client_actions (id,session_id,assignment_id,user_id,team_id,project_id,kind,payload_json,status,idempotency_key,request_digest,expires_at,completed_at,result_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)`,[id,session?.id??null,assignmentId,userId,assignment.teamId,assignment.projectId,kind,JSON.stringify(payload),status,idempotencyKey,requestDigest,expiresAt,JSON.stringify(session?{}:{code:'client_unavailable'}),now.toISOString(),now.toISOString()]);
			return c.json({ok:true,payload:await store.first(`SELECT * FROM agent_client_actions WHERE id=?`,[id]),replayed:false},session?201:200);
		}catch(error){return errorResponse(c,error);}
	});

	app.post('/v1/provider/assignments/:assignmentId/operation-handoffs',async(c)=>{
		try{
			const principal=requireProviderPrincipal(c,['provider:assignments:write']); const assignmentId=c.req.param('assignmentId');
			const assignment=assertProviderOwnsAssignment(await store.getProviderAssignment(principal.teamId,assignmentId),principal,'prepare an operation handoff for');
			const body=await readCapacityRequestObject(c); assertCurrentLease(assignment,body);
			const idempotencyKey=text(body.idempotencyKey); const discussionId=text(body.discussionId); const target=text(body.target); const expectedEffect=text(body.expectedEffect);
			const sourceMessageRefs=Array.isArray(body.sourceMessageRefs)?[...new Set(body.sourceMessageRefs.map(String).filter(Boolean))]:[]; const requiredAuthority=Array.isArray(body.requiredAuthority)?[...new Set(body.requiredAuthority.map(String).filter(Boolean))]:[];
			if(!idempotencyKey||!discussionId||!target||!expectedEffect||!sourceMessageRefs.length||!requiredAuthority.length)throw new CapacityGovernanceError('operation_handoff_invalid','Operation handoff requires exact Discussion evidence, target, expected effect, authority, and idempotency key.',400);
			const history=await loadDiscussions({store,projectId:String(assignment.projectId),discussionId}); const paths=new Set(history.messages.map((entry:Record<string,unknown>)=>text(entry.path)));
			if(sourceMessageRefs.some((reference)=>!paths.has(reference)))throw new CapacityGovernanceError('operation_handoff_source_stale','Operation handoff source-message evidence is missing or stale.',409);
			const inputs=record(body.inputs); const proposalId=text(body.proposalId); const decisionId=text(body.decisionId);
			if(!proposalId||(!text(inputs.workUnitId)&&!text(inputs.workGraphNodeId)))throw new CapacityGovernanceError('operation_handoff_governance_missing','Operation handoff requires an exact proposal and work-unit or graph-node reference.',400);
			const proposal=await store.first(`SELECT id FROM governance_proposals WHERE id=? AND team_id=? AND project_id=? LIMIT 1`,[proposalId,assignment.teamId,assignment.projectId]);
			if(!proposal)throw new CapacityGovernanceError('operation_handoff_proposal_stale','The operation handoff proposal is missing or belongs to another project.',409);
			if(decisionId&&!await store.first(`SELECT id FROM governance_decisions WHERE id=? AND proposal_id=? AND team_id=? AND project_id=? LIMIT 1`,[decisionId,proposalId,assignment.teamId,assignment.projectId]))throw new CapacityGovernanceError('operation_handoff_decision_stale','The operation handoff decision does not match its exact proposal.',409);
			const normalized={discussionId,target,expectedEffect,sourceMessageRefs,requiredAuthority,proposalId,decisionId:decisionId||null,inputs}; const requestDigest=digest(normalized);
			const replay=await store.first(`SELECT * FROM agent_operation_handoffs WHERE assignment_id=? AND idempotency_key=?`,[assignmentId,idempotencyKey]);
			if(replay){if(replay.request_digest!==requestDigest)throw new CapacityGovernanceError('operation_handoff_idempotency_conflict','The idempotency key is already bound to another operation handoff.',409);return c.json({ok:true,payload:replay,replayed:true});}
			const id=randomUUID(); const approvalId=randomUUID(); const now=new Date().toISOString();
			await (store as ProviderAssignmentStore&{createApprovalRequest(input:Record<string,unknown>):Promise<unknown>}).createApprovalRequest({id:approvalId,teamId:assignment.teamId,projectId:assignment.projectId,workDayId:assignment.workDayId??null,taskId:assignmentId,kind:'agent-operation-handoff',severity:'medium',requestedByType:'agent',requestedById:assignment.agentId,title:`Approve operation handoff: ${target}`,summary:expectedEffect,options:[{id:'approve',label:'Approve'},{id:'reject',label:'Reject'}],policySnapshot:{sourceAssignmentId:assignmentId,requiredAuthority},metadata:{operationHandoffId:id,discussionId,sourceMessageRefs}});
			await store.run(`INSERT INTO agent_operation_handoffs (id,assignment_id,invocation_id,discussion_id,team_id,project_id,status,target,expected_effect,inputs_json,source_message_refs_json,required_authority_json,proposal_id,decision_id,approval_request_id,resulting_assignment_id,idempotency_key,request_digest,created_at,updated_at) VALUES (?,?,?,?,?,?,'awaiting-approval',?,?,?,?,?,?,?,?,NULL,?,?,?,?)`,[id,assignmentId,assignment.invocationId??null,discussionId,assignment.teamId,assignment.projectId,target,expectedEffect,JSON.stringify(normalized.inputs),JSON.stringify(sourceMessageRefs),JSON.stringify(requiredAuthority),normalized.proposalId,normalized.decisionId,approvalId,idempotencyKey,requestDigest,now,now]);
			await appendDiscussionEvent({store,projectId:String(assignment.projectId),teamId:String(assignment.teamId),discussionId,event:{id:`operation-handoff:${id}`,eventType:'operation-handoff.approval-required',assignmentId,context:{approvalRequestId:approvalId},refs:{sourceMessageRefs,operationHandoffId:id},metadata:{target,expectedEffect},message:'Operation handoff awaits durable approval.'}});
			return c.json({ok:true,payload:await store.first(`SELECT * FROM agent_operation_handoffs WHERE id=?`,[id]),replayed:false},201);
		}catch(error){return errorResponse(c,error);}
	});
}
