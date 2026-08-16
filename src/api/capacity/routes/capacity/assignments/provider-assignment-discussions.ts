import { createHash } from 'node:crypto';
import type { Hono } from 'hono';
import { CapacityGovernanceError } from '../../../database.ts';
import { appendDiscussionEvent,commitDiscussionMessage,loadDiscussions } from '../../../../discussions/content.ts';
import { admitDiscussionInvocations } from '../../../services/capacity/invocations/discussion-invocation-service.ts';
import { discussionHandoffPolicyViolation } from '../../../services/capacity/invocations/discussion-handoff-policy.ts';
import { suspendAssignmentForDiscussionResponse } from '../../../services/capacity/assignments/lifecycle/assignment-discussion-suspension-service.ts';
import { listUnpublishedTreeDxAuthoringState } from '../../../services/treedx/repositories/treedx-authoring-journal.ts';
import { readCapacityRequestObject } from '../../support/request-json.ts';
import { requireProviderPrincipal } from '../providers/provider-auth.ts';
import { assertProviderOwnsAssignment,assignmentRecord as record,providerAssignmentErrorResponse as errorResponse,type ProviderAssignmentStore } from './provider-assignment-route-support.ts';
import { installProviderAssignmentHandoffActionRoutes } from './provider-assignment-handoff-actions.ts';

function text(value: unknown) { return typeof value === 'string' ? value.trim() : ''; }
function decoded(value: unknown) { if (typeof value !== 'string') return record(value); try { return record(JSON.parse(value)); } catch { return {}; } }
function messageId(assignmentId: string,idempotencyKey: string) { return createHash('sha256').update(`${assignmentId}:${idempotencyKey}`).digest('hex').slice(0,32); }
function requestDigest(value:unknown){ return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

export function installProviderAssignmentDiscussionRoutes(app: Hono,store: ProviderAssignmentStore) {
	installProviderAssignmentHandoffActionRoutes(app,store);
	app.get('/v1/provider/assignments/:assignmentId/discussions',async(c)=>{
		try {
			const principal=requireProviderPrincipal(c,['provider:assignments:read']);
			const assignment=assertProviderOwnsAssignment(await store.getProviderAssignment(principal.teamId,c.req.param('assignmentId')),principal,'read discussions for');
			const history=await loadDiscussions({ store,projectId:String(assignment.projectId),discussionId:c.req.query('discussionId'),query:c.req.query('query') });
			const after=text(c.req.query('after')); const limit=Math.max(1,Math.min(100,Number(c.req.query('limit'))||50));
			const messages=history.messages.filter((entry:Record<string,unknown>)=>!after||text(record(entry.frontmatter).createdAt)>after).slice(0,limit);
			return c.json({ ok:true,payload:{ ref:history.ref,discussions:history.discussions,messages,events:history.events,cursor:text(record(messages.at(-1)?.frontmatter).createdAt)||after } },200,{ 'Cache-Control':'private, no-store' });
		} catch(error){ return errorResponse(c,error); }
	});

	app.post('/v1/provider/assignments/:assignmentId/discussions/responses',async(c)=>{
		try {
			const principal=requireProviderPrincipal(c,['provider:assignments:write']); const assignmentId=c.req.param('assignmentId');
			const assignment=assertProviderOwnsAssignment(await store.getProviderAssignment(principal.teamId,assignmentId),principal,'write discussions for');
			const body=await readCapacityRequestObject(c); const idempotencyKey=text(body.idempotencyKey); const message=text(body.message);
			if(!idempotencyKey||!message) throw new CapacityGovernanceError('assignment_discussion_input_invalid','Assignment discussion response requires message and idempotencyKey.',400);
			const discussionId=text(body.discussionId)||`assignment-${assignmentId}`; const stableMessageId=messageId(assignmentId,idempotencyKey); const requiredResponse=body.requiredResponse===true;
			if(requiredResponse&&!text(record(body.checkpoint).commitSha)) throw new CapacityGovernanceError('assignment_discussion_checkpoint_required','A required response must checkpoint assignment work before suspension.',409);
			const history=await loadDiscussions({ store,projectId:String(assignment.projectId),discussionId }).catch(()=>({ discussions:[],messages:[] } as Record<string,unknown[]>));
			const replayHistory=await loadDiscussions({ store,projectId:String(assignment.projectId),discussionId,query:stableMessageId,collection:'messages' }).catch(()=>({ messages:[] } as Record<string,unknown[]>));
			const replay=Array.isArray(replayHistory.messages)?replayHistory.messages.find((entry)=>record(entry).id===stableMessageId):null;
			if(replay){
				if(text(record(replay).body)!==message) throw new CapacityGovernanceError('assignment_discussion_idempotency_conflict','The idempotency key is already bound to a different discussion message.',409);
				const replayAssignment=requiredResponse?await suspendAssignmentForDiscussionResponse(store,{assignmentId,teamId:String(assignment.teamId),leaseToken:text(body.leaseToken),discussionId,messageId:stableMessageId,message,messagePath:text(record(replay).path),checkpoint:record(body.checkpoint)}):assignment;
				return c.json({ ok:true,payload:{ discussionId,message:replay,assignment:replayAssignment,replayed:true,suspended:requiredResponse } });
			}
			if(assignment.invocationId){
				const invocation=await store.first(`SELECT final_message_ref FROM agent_invocation_requests WHERE id=? AND team_id=?`,[assignment.invocationId,assignment.teamId]);
				if(text(invocation?.final_message_ref))throw new CapacityGovernanceError('assignment_discussion_final_response_exists','A communication assignment may publish only one authoritative final response.',409,{finalMessageRef:invocation?.final_message_ref});
			}
			if(assignment.status!=='leased'||assignment.leaseState!=='leased'||assignment.leaseToken!==body.leaseToken||Number(assignment.stateVersion)!==Number(body.expectedStateVersion)) throw new CapacityGovernanceError('assignment_discussion_state_stale','Discussion mutation requires the current leased assignment state and lease token.',409,{ stateVersion:assignment.stateVersion });
			const sourceMessageRefs=Array.isArray(body.sourceMessageRefs)?body.sourceMessageRefs.map(String).filter(Boolean):[];
			if(!sourceMessageRefs.length) throw new CapacityGovernanceError('assignment_discussion_source_required','Assignment response requires exact source-message references.',400);
			const assignmentRef=text(record(assignment.treedxProxyHandle).branchName)||text(record(record(assignment.workspaceContext).treedxProxyHandle).branchName);
			const assignmentCheckpoints=await listUnpublishedTreeDxAuthoringState(store,String(assignment.projectId),assignmentId);
			if(!assignmentCheckpoints.some((entry)=>text(entry.ref)===assignmentRef)) throw new CapacityGovernanceError('assignment_discussion_checkpoint_required','Commit the assignment operational plan, terminal status, and summary before publishing the final Discussion response.',409,{assignmentId,assignmentRef});
			const authored=await commitDiscussionMessage({ store,projectId:String(assignment.projectId),teamId:String(assignment.teamId),principal:{ id:assignment.agentId,displayName:assignment.agentId },authorType:'agent',authorAgentId:text(assignment.agentId),assignmentId,authoringRef:assignmentRef,messageId:stableMessageId,body:message,intent:'discuss',discussionId,createDiscussion:!Array.isArray(history.discussions)||history.discussions.length===0,topic:text(body.topic)||`Assignment ${assignmentId}`,replyTo:text(body.replyTo)||null,sourceMessageRefs,recipients:Array.isArray(body.recipients)?body.recipients.map(String).filter(Boolean):[],parentWorkdayId:text(assignment.workDayId)||null });
			const observed=await loadDiscussions({ store,projectId:String(assignment.projectId),discussionId,query:stableMessageId,collection:'messages' });
			if(!observed.messages.some((entry)=>record(entry).path===authored.message.path&&record(entry).body===message)) throw new CapacityGovernanceError('assignment_discussion_readback_failed','TreeDX did not authoritatively return the assignment response.',503,{ messageId:stableMessageId });
			if(assignment.invocationId) await store.run(`UPDATE agent_invocation_requests SET status='running',assignment_id=?,final_message_ref=? WHERE id=? AND team_id=? AND status IN ('admitted','running')`,[assignmentId,authored.message.path,assignment.invocationId,assignment.teamId]);
			const postcondition=requiredResponse?await suspendAssignmentForDiscussionResponse(store,{assignmentId,teamId:String(assignment.teamId),leaseToken:text(body.leaseToken),discussionId,messageId:stableMessageId,message,messagePath:authored.message.path,checkpoint:record(body.checkpoint)}):await store.getProviderAssignment(principal.teamId,assignmentId);
			return c.json({ ok:true,payload:{ ...authored,assignment:postcondition,replayed:false,suspended:requiredResponse } },201);
		} catch(error){ return errorResponse(c,error); }
	});

	app.post('/v1/provider/assignments/:assignmentId/discussions/handoffs',async(c)=>{
		try {
			const principal=requireProviderPrincipal(c,['provider:assignments:write']); const assignmentId=c.req.param('assignmentId');
			const assignment=assertProviderOwnsAssignment(await store.getProviderAssignment(principal.teamId,assignmentId),principal,'request a discussion handoff for');
			const body=await readCapacityRequestObject(c); const idempotencyKey=text(body.idempotencyKey); const discussionId=text(body.discussionId); const subject=text(body.subject);
			const recipients=Array.isArray(body.recipientAgentIds)?[...new Set(body.recipientAgentIds.map(String).filter(Boolean))]:[];
			const sourceMessageRefs=Array.isArray(body.sourceMessageRefs)?[...new Set(body.sourceMessageRefs.map(String).filter(Boolean))]:[];
			if(!idempotencyKey||!discussionId||!subject||!sourceMessageRefs.length||!recipients.length||recipients.length>2) throw new CapacityGovernanceError('assignment_discussion_handoff_invalid','Discussion handoff requires exact source messages, a subject, idempotency key, and one or two recipients.',400);
			if(assignment.status!=='leased'||assignment.leaseState!=='leased'||assignment.leaseToken!==body.leaseToken||Number(assignment.stateVersion)!==Number(body.expectedStateVersion)) throw new CapacityGovernanceError('assignment_discussion_state_stale','Discussion handoff requires the current leased assignment state and lease token.',409,{ stateVersion:assignment.stateVersion });
			const team=await store.first(`SELECT metadata_json FROM teams WHERE id=? LIMIT 1`,[assignment.teamId]); const coordination=record(decoded(team?.metadata_json).discussionCoordination);
			if(coordination.enabled!==true) throw new CapacityGovernanceError('assignment_discussion_handoff_disabled','Agent-to-agent Discussion coordination is disabled for this team.',409);
			const depth=Number(assignment.handoffDepth??0)+1; const maxDepth=Math.max(0,Number(coordination.maxDepth??2));
			const rootId=String(assignment.handoffRootId??assignment.invocationId??assignment.id); const count=await store.first(`SELECT COUNT(*) AS count FROM agent_invocation_requests WHERE team_id=? AND handoff_root_id=? AND trigger_kind='agent-handoff'`,[assignment.teamId,rootId]);
			const ancestry=await store.all(`SELECT agent_id FROM agent_invocation_requests WHERE team_id=? AND (id=? OR handoff_root_id=?)`,[assignment.teamId,rootId,rootId]);const priorAgents=new Set(ancestry.map((entry)=>text(entry.agent_id)).filter(Boolean));
			const activeDuplicateAgentIds:string[]=[];
			for(const recipient of recipients){const subjectDigest=requestDigest({discussionId,agentSlug:recipient,subject});const duplicate=await store.first(`SELECT id FROM agent_invocation_requests WHERE team_id=? AND project_id=? AND agent_id=? AND subject_digest=? AND status IN ('queued','blocked','admitted','running') LIMIT 1`,[assignment.teamId,assignment.projectId,recipient,subjectDigest]);if(duplicate)activeDuplicateAgentIds.push(recipient);}
			const violation=discussionHandoffPolicyViolation({currentAgentId:String(assignment.agentId),recipientAgentIds:recipients,depth,maxDepth,existingHandoffs:Number(count?.count??0),maxHandoffsPerRoot:Math.max(1,Number(coordination.maxHandoffsPerRoot??4)),priorAgentIds:[...priorAgents],activeDuplicateAgentIds});
			if(violation)throw new CapacityGovernanceError(violation.code,violation.message,409,{rootId,recipients,...violation.details});
			const history=await loadDiscussions({store,projectId:String(assignment.projectId),discussionId}); const paths=new Set(history.messages.map((entry:Record<string,unknown>)=>text(entry.path)));
			if(sourceMessageRefs.some((reference)=>!paths.has(reference))) throw new CapacityGovernanceError('assignment_discussion_handoff_source_stale','Discussion handoff source-message evidence is missing or stale.',409);
			const event=await appendDiscussionEvent({ store,projectId:String(assignment.projectId),teamId:String(assignment.teamId),discussionId,event:{ id:`handoff:${assignmentId}:${idempotencyKey}`,eventType:'handoff.requested',assignmentId,context:{agentId:assignment.agentId},refs:{sourceMessageRefs},metadata:{recipients,subject},message:subject } });
			const project=await store.first(`SELECT id,slug FROM projects WHERE id=? AND team_id=? LIMIT 1`,[assignment.projectId,assignment.teamId]);
			const invocations=await admitDiscussionInvocations(store,{ teamId:String(assignment.teamId),projectId:String(assignment.projectId),projectSlug:text(project?.slug)||String(project?.id),discussionId,messageId:text(sourceMessageRefs.at(-1)),messagePath:event.path,messageCommit:event.commitSha,contextRefs:sourceMessageRefs,agentSlugs:recipients,idempotencyKey,continuationOfAssignmentId:assignmentId,handoffRootId:rootId,handoffParentId:text(assignment.invocationId)||assignmentId,handoffDepth:depth,triggerKind:'agent-handoff',subject,durationSeconds:Math.max(60,Math.min(3600,Number(body.durationSeconds??900))) });
			return c.json({ok:true,payload:{handoffRootId:rootId,parentAssignmentId:assignmentId,depth,invocations}},201);
		} catch(error){ return errorResponse(c,error); }
	});

}
