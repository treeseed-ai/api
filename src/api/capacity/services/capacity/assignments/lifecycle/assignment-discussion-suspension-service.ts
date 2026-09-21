import { CapacityGovernanceError,type CapacityGovernanceDatabase } from '../../../../database.ts';
import type { DurableProviderAssignment } from '../../../../repositories/capacity/assignments/assignment.ts';
import { terminalAssignmentAuthority } from './assignment-terminal-authority.ts';

type Row=Record<string,unknown>;
type Store=CapacityGovernanceDatabase&{getProviderAssignment(teamId:string,assignmentId:string):Promise<Row|null>};

function record(value:unknown):Row { return value&&typeof value==='object'&&!Array.isArray(value)?value as Row:{}; }

export async function suspendAssignmentForDiscussionResponse(store:Store,input:{
	assignmentId:string;teamId:string;leaseToken:string;discussionId:string;messageId:string;
	message:string;messagePath:string;checkpoint:Row;
}) {
	const current=await store.getProviderAssignment(input.teamId,input.assignmentId);
	if(!current) throw new CapacityGovernanceError('provider_assignment_not_found','Unknown assignment.',404);
	const metadata=record(current.metadata);
	const alreadySuspended=current.status==='returned'&&current.leaseState==='released'
		&&metadata.operationalState==='suspended'&&metadata.waitingMessageId===input.messageId;
	const now=new Date().toISOString();
	const authority=terminalAssignmentAuthority(current as unknown as DurableProviderAssignment,now);
	const suspendedMetadata=JSON.stringify({...metadata,operationalState:'suspended',waitingDiscussionId:input.discussionId,waitingMessageId:input.messageId,checkpoint:input.checkpoint});
	const suspendedAssignmentExists=`EXISTS (SELECT 1 FROM capacity_provider_assignments assignment
		WHERE assignment.id=? AND assignment.team_id=? AND assignment.status='returned'
		AND assignment.lease_state='released' AND assignment.lifecycle_code='discussion_response_required'
		AND assignment.metadata_json::jsonb->>'waitingMessageId'=?)`;
	if(!alreadySuspended){
		if(current.status!=='leased'||current.leaseState!=='leased'||current.leaseToken!==input.leaseToken) {
			throw new CapacityGovernanceError('assignment_discussion_state_stale','Required-response suspension no longer owns the active assignment lease.',409,{stateVersion:current.stateVersion,status:current.status,leaseState:current.leaseState});
		}
	}
	await store.batch([
		...(!alreadySuspended?[{query:`UPDATE capacity_provider_assignments SET status='returned',lease_state='released',lease_token=NULL,lease_expires_at=NULL,lease_renewed_at=NULL,returned_at=COALESCE(returned_at,?),lifecycle_code='discussion_response_required',lifecycle_reason=?,metadata_json=?,treedx_proxy_handle_json=?,workspace_context_json=?,state_version=state_version+1,updated_at=? WHERE id=? AND team_id=? AND status='leased' AND lease_state='leased' AND lease_token=?`,params:[now,input.message,suspendedMetadata,JSON.stringify(authority.proxyHandle),JSON.stringify(authority.workspaceContext),now,input.assignmentId,input.teamId,input.leaseToken]}]:[]),
		{query:`UPDATE treedx_proxy_handles SET status='revoked',revoked_at=COALESCE(revoked_at,?),updated_at=? WHERE assignment_id=? AND team_id=? AND ${suspendedAssignmentExists}`,params:[now,now,input.assignmentId,input.teamId,input.assignmentId,input.teamId,input.messageId]},
		...(current.invocationId?[{query:`UPDATE agent_invocation_requests SET status='suspended',assignment_id=?,final_message_ref=?,completed_at=COALESCE(completed_at,?),updated_at=? WHERE id=? AND team_id=? AND status IN ('admitted','running','suspended') AND ${suspendedAssignmentExists}`,params:[input.assignmentId,input.messagePath,now,now,current.invocationId,input.teamId,input.assignmentId,input.teamId,input.messageId]}]:[]),
	]);
	const suspended=await store.getProviderAssignment(input.teamId,input.assignmentId);
	if(suspended?.status!=='returned'||suspended.leaseState!=='released'||record(suspended.metadata).waitingMessageId!==input.messageId) {
		throw new CapacityGovernanceError('assignment_discussion_suspension_failed','The discussion message committed, but assignment suspension did not reach its authoritative postcondition.',409,{assignment:suspended});
	}
	return suspended;
}

export async function closeSuspendedConversationExecution(store:Store,assignment:DurableProviderAssignment,now=new Date().toISOString()) {
	if(!assignment.invocationId) throw new CapacityGovernanceError('communication_invocation_provenance_missing','Suspended conversation assignment lacks its exact invocation.',409,{assignmentId:assignment.id});
	if(!assignment.workDayId) throw new CapacityGovernanceError('communication_workday_provenance_missing','Suspended conversation assignment lacks its exact workday.',409,{assignmentId:assignment.id});
	const ready=await store.first(`SELECT invocation.final_message_ref FROM agent_invocation_requests invocation
		JOIN capacity_reservations reservation ON reservation.assignment_id=? AND reservation.team_id=?
		JOIN capacity_ledger_entries settlement ON settlement.reservation_id=reservation.id AND settlement.phase='task_completed_actual_settlement'
		WHERE invocation.id=? AND invocation.team_id=? AND invocation.assignment_id=? AND invocation.status='suspended'
		  AND invocation.final_message_ref IS NOT NULL LIMIT 1`,[assignment.id,assignment.teamId,assignment.invocationId,assignment.teamId,assignment.id]);
	if(!ready) throw new CapacityGovernanceError('communication_suspension_settlement_incomplete','Suspended conversation cannot close before its final message and exact settlement are durable.',409,{assignmentId:assignment.id,invocationId:assignment.invocationId});
	const summary=JSON.stringify({invocationId:assignment.invocationId,assignmentId:assignment.id,outcome:'required_response_suspended',finalMessageRef:ready.final_message_ref});
	await store.batch([
		{query:`UPDATE capacity_workday_runs SET status='degraded',summary_json=?,completed_at=COALESCE(completed_at,?),updated_at=?
			WHERE team_id=? AND execution_kind='conversation' AND status='running' AND id=?`,params:[summary,now,now,assignment.teamId,assignment.workDayId]},
	]);
	return store.first(`SELECT status,completed_at FROM capacity_workday_runs WHERE team_id=? AND execution_kind='conversation'
		AND id=?`,[assignment.teamId,assignment.workDayId]);
}
