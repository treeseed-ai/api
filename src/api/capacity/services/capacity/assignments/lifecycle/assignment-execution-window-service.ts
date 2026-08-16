import type { CapacityProviderAccessPrincipal } from '../../../../routes/capacity/providers/provider-auth.ts';
import type { CapacityGovernanceDatabase } from '../../../../database.ts';
import { CapacityGovernanceError } from '../../../../database.ts';
import { ProviderAssignmentRepository,type DurableProviderAssignment } from '../../../../repositories/capacity/assignments/assignment.ts';
import { evaluateMinimumAssignmentDuration } from '@treeseed/sdk/capacity-provider';

type JsonRecord = Record<string,unknown>;
function record(value:unknown):JsonRecord { return value&&typeof value==='object'&&!Array.isArray(value)?value as JsonRecord:{}; }
function text(value:unknown){ return typeof value==='string'?value.trim():''; }
function positive(value:unknown){ const parsed=Number(value); return Number.isInteger(parsed)&&parsed>0?parsed:null; }

export function compileAssignmentExecutionWindow(assignment:Pick<DurableProviderAssignment,'capacityEnvelope'|'metadata'>,now:string,planRef:JsonRecord){
	const envelope=record(assignment.capacityEnvelope); const budget=record(envelope.budget); const time=record(budget.time);
	const executionSeconds=positive(time.executionSeconds??time.requestedSeconds??envelope.requestedSeconds);
	const closeoutSeconds=positive(time.closeoutSeconds??time.closeoutWarningSeconds);
	if(!executionSeconds||!closeoutSeconds) throw new CapacityGovernanceError('assignment_execution_window_invalid','Assignment execution and closeout durations must be positive.',500);
	const startedMs=Date.parse(now); const preparationDeadline=Date.parse(text(time.preparationDeadlineAt));
	if(!Number.isFinite(startedMs)) throw new CapacityGovernanceError('assignment_execution_start_time_invalid','Execution start time must be an ISO timestamp.',500);
	if(Number.isFinite(preparationDeadline)&&startedMs>preparationDeadline) throw new CapacityGovernanceError('assignment_preparation_deadline_exhausted','Initial context and assignment plan did not finish inside the bounded preparation window.',409,{ preparationDeadlineAt:time.preparationDeadlineAt });
	const executionDeadlineAt=new Date(startedMs+executionSeconds*1_000).toISOString();
	const closeoutDeadlineAt=new Date(startedMs+(executionSeconds+closeoutSeconds)*1_000).toISOString();
	const nextTime={ ...time,executionSeconds,closeoutSeconds,executionStartedAt:now,executionDeadlineAt,closeoutStartedAt:executionDeadlineAt,closeoutDeadlineAt,hardDeadlineAt:closeoutDeadlineAt,remainingSeconds:executionSeconds };
	const minimum=record(record(assignment.metadata).minimumAssignmentDuration); const requirement=record(minimum.requirement);
	const productiveMinimum=text(requirement.unit)&&positive(requirement.amount)
		? evaluateMinimumAssignmentDuration(requirement as never,now)
		: minimum;
	return { capacityEnvelope:{ ...envelope,budget:{ ...budget,time:nextTime,deadline:closeoutDeadlineAt } },
		metadata:{ ...assignment.metadata,minimumAssignmentDuration:productiveMinimum,operationalState:'executing',executionWindow:{ startedAt:now,executionDeadlineAt,closeoutDeadlineAt,planRef } } };
}

export async function startAssignmentExecutionWindow(database:CapacityGovernanceDatabase,principal:CapacityProviderAccessPrincipal,assignmentId:string,input:JsonRecord,now=new Date().toISOString()){
	const repository=new ProviderAssignmentRepository(database); const assignment=await repository.get(principal.teamId,assignmentId);
	if(!assignment) throw new CapacityGovernanceError('provider_assignment_not_found','Unknown assignment.',404);
	if(assignment.capacityProviderId!==principal.capacityProviderId||assignment.membershipId!==principal.membershipId) throw new CapacityGovernanceError('provider_assignment_forbidden','Provider cannot start execution for this assignment.',403);
	const key=text(input.idempotencyKey); const planRef=record(input.planRef); const expected=Number(input.expectedStateVersion);
	if(!key||!text(planRef.id)||!text(planRef.path)) throw new CapacityGovernanceError('assignment_execution_start_evidence_required','Execution start requires an idempotency key and exact assignment-plan id/path.',400);
	const existing=record(record(assignment.metadata).executionWindow);
	if(text(existing.idempotencyKey)===key) return assignment;
	if(text(existing.startedAt)) throw new CapacityGovernanceError('assignment_execution_already_started','Productive execution already started from a different transition.',409,{ executionWindow:existing });
	if(assignment.status!=='leased'||assignment.leaseState!=='leased'||assignment.leaseToken!==input.leaseToken) throw new CapacityGovernanceError('assignment_execution_lease_invalid','Execution start requires the current active lease.',409);
	if(!Number.isInteger(expected)||expected!==assignment.stateVersion) throw new CapacityGovernanceError('assignment_execution_state_stale','Execution start requires the exact assignment state version.',409,{ expectedStateVersion:expected,stateVersion:assignment.stateVersion });
	const compiled=compileAssignmentExecutionWindow(assignment,now,planRef); const metadata={ ...compiled.metadata,executionWindow:{ ...record(compiled.metadata.executionWindow),idempotencyKey:key } };
	await database.run(`UPDATE capacity_provider_assignments SET capacity_envelope_json=?,metadata_json=?,state_version=state_version+1,updated_at=? WHERE id=? AND team_id=? AND state_version=? AND status='leased' AND lease_state='leased' AND lease_token=?`,[
		JSON.stringify(compiled.capacityEnvelope),JSON.stringify(metadata),now,assignmentId,principal.teamId,expected,input.leaseToken,
	]);
	const updated=await repository.get(principal.teamId,assignmentId);
	if(!updated||text(record(record(updated.metadata).executionWindow).idempotencyKey)!==key) throw new CapacityGovernanceError('assignment_execution_start_conflict','Execution start lost a concurrent state transition.',409);
	return updated;
}

export function compileAssignmentCloseoutWindow(assignment:Pick<DurableProviderAssignment,'capacityEnvelope'|'metadata'>,now:string){
	const envelope=record(assignment.capacityEnvelope); const budget=record(envelope.budget); const time=record(budget.time);
	const closeoutSeconds=positive(time.closeoutSeconds??time.closeoutWarningSeconds);
	const executionStartedAt=text(time.executionStartedAt); const executionDeadlineMs=Date.parse(text(time.executionDeadlineAt)); const nowMs=Date.parse(now);
	if(!executionStartedAt||!closeoutSeconds||!Number.isFinite(nowMs)) throw new CapacityGovernanceError('assignment_closeout_window_invalid','Closeout requires a started execution window and a positive closeout duration.',409);
	const closeoutStartedMs=Number.isFinite(executionDeadlineMs)?Math.min(nowMs,executionDeadlineMs):nowMs;
	const closeoutStartedAt=new Date(closeoutStartedMs).toISOString();
	const closeoutDeadlineAt=new Date(closeoutStartedMs+closeoutSeconds*1_000).toISOString();
	const executionSeconds=positive(time.executionSeconds??time.requestedSeconds??envelope.requestedSeconds)??0;
	const consumedExecutionSeconds=Math.max(0,Math.min(executionSeconds,Math.ceil((closeoutStartedMs-Date.parse(executionStartedAt))/1_000)));
	const releasedExecutionSeconds=Math.max(0,executionSeconds-consumedExecutionSeconds);
	const nextTime={ ...time,executionDeadlineAt:closeoutStartedAt,closeoutStartedAt,closeoutDeadlineAt,hardDeadlineAt:closeoutDeadlineAt,
		remainingSeconds:closeoutSeconds,releasedSeconds:Math.max(Number(time.releasedSeconds??0),releasedExecutionSeconds) };
	return { capacityEnvelope:{ ...envelope,budget:{ ...budget,time:nextTime,deadline:closeoutDeadlineAt } },
		metadata:{ ...assignment.metadata,operationalState:'closeout',closeoutWindow:{ startedAt:closeoutStartedAt,closeoutDeadlineAt,releasedExecutionSeconds } } };
}

export async function startAssignmentCloseoutWindow(database:CapacityGovernanceDatabase,principal:CapacityProviderAccessPrincipal,assignmentId:string,input:JsonRecord,now=new Date().toISOString()){
	const repository=new ProviderAssignmentRepository(database); const assignment=await repository.get(principal.teamId,assignmentId);
	if(!assignment) throw new CapacityGovernanceError('provider_assignment_not_found','Unknown assignment.',404);
	if(assignment.capacityProviderId!==principal.capacityProviderId||assignment.membershipId!==principal.membershipId) throw new CapacityGovernanceError('provider_assignment_forbidden','Provider cannot start closeout for this assignment.',403);
	const key=text(input.idempotencyKey); const expected=Number(input.expectedStateVersion); const existing=record(record(assignment.metadata).closeoutWindow);
	if(!key) throw new CapacityGovernanceError('assignment_closeout_start_evidence_required','Closeout start requires an idempotency key.',400);
	if(text(existing.idempotencyKey)===key) return assignment;
	if(text(existing.startedAt)) throw new CapacityGovernanceError('assignment_closeout_already_started','Closeout already started from a different transition.',409,{ closeoutWindow:existing });
	if(assignment.status!=='leased'||assignment.leaseState!=='leased'||assignment.leaseToken!==input.leaseToken) throw new CapacityGovernanceError('assignment_closeout_lease_invalid','Closeout start requires the current active lease.',409);
	if(!Number.isInteger(expected)||expected!==assignment.stateVersion) throw new CapacityGovernanceError('assignment_closeout_state_stale','Closeout start requires the exact assignment state version.',409,{ expectedStateVersion:expected,stateVersion:assignment.stateVersion });
	const compiled=compileAssignmentCloseoutWindow(assignment,now); const metadata={ ...compiled.metadata,closeoutWindow:{ ...record(compiled.metadata.closeoutWindow),idempotencyKey:key } };
	await database.run(`UPDATE capacity_provider_assignments SET capacity_envelope_json=?,metadata_json=?,state_version=state_version+1,updated_at=? WHERE id=? AND team_id=? AND state_version=? AND status='leased' AND lease_state='leased' AND lease_token=?`,[
		JSON.stringify(compiled.capacityEnvelope),JSON.stringify(metadata),now,assignmentId,principal.teamId,expected,input.leaseToken,
	]);
	const updated=await repository.get(principal.teamId,assignmentId);
	if(!updated||text(record(record(updated.metadata).closeoutWindow).idempotencyKey)!==key) throw new CapacityGovernanceError('assignment_closeout_start_conflict','Closeout start lost a concurrent state transition.',409);
	return updated;
}
