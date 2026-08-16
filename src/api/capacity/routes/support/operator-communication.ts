import { normalizeCapacityPageLimit } from '@treeseed/sdk/capacity-pagination';
import type { Hono } from 'hono';
import { CapacityGovernanceError } from '../../database.ts';
import { readCapacityRequestObject } from './request-json.ts';
import type { WorkdayRouteDependencies } from './operator-workdays.ts';

type Row = Record<string, unknown>;
type ProviderSnapshot = Row & { maxConcurrentRunners?: number; lanes?: unknown[] };
type LaneSnapshot = Row & { purpose?: unknown };

function providerReadiness(session: Row) {
	let providers: ProviderSnapshot[] = []; let metadata: Row = {};
	try {
		providers = JSON.parse(String(session.execution_providers_json ?? '[]')) as ProviderSnapshot[];
		metadata = JSON.parse(String(session.metadata_json ?? '{}')) as Row;
	} catch {
		return { ...session, communicationReady: false, sourceClosureDigest: null, blockers: ['provider_snapshot_invalid'] };
	}
	const ready = providers.some((provider) => Number(provider.maxConcurrentRunners) >= 2 && Array.isArray(provider.lanes)
		&& provider.lanes.some((lane) => (lane as LaneSnapshot).purpose === 'communication')
		&& provider.lanes.some((lane) => (lane as LaneSnapshot).purpose === 'operation'));
	return { ...session, sourceClosureDigest: typeof metadata.sourceClosureDigest === 'string' ? metadata.sourceClosureDigest : null,
		communicationReady: ready, blockers: ready ? [] : ['provider_requires_two_global_slots_and_distinct_communication_operation_lanes'] };
}

async function cancelInvocation(c: Parameters<Parameters<Hono['post']>[1]>[0],dependencies: WorkdayRouteDependencies) {
	const { store,manage,notFound,operatorError } = dependencies;
	const access=await manage(c);if(access.response)return access.response;
	const body=await readCapacityRequestObject(c,{optional:true});
	const key=typeof body.idempotencyKey==='string'?body.idempotencyKey.trim():c.req.header('Idempotency-Key')?.trim();
	if(!key)return operatorError(new CapacityGovernanceError('capacity_idempotency_key_required','An idempotency key is required.',400));
	const row=await store.first(`SELECT * FROM agent_invocation_requests WHERE id=? AND team_id=?`,[c.req.param('invocationId'),c.req.param('teamId')]);
	if(!row)return notFound(c,'Unknown agent invocation.');
	if(row.status==='cancelled')return c.json({ok:true,payload:row,replayed:true});
	if(['admitted','running'].includes(String(row.status))){
		const assignment=await store.first(`SELECT id,status,lifecycle_code,lifecycle_reason FROM capacity_provider_assignments WHERE team_id=? AND invocation_id=? ORDER BY updated_at DESC LIMIT 1`,[row.team_id,row.id]);
		if(assignment&&['completed','failed','cancelled','returned','expired'].includes(String(assignment.status))){
			const integrated=assignment.status==='completed'?await store.first(`SELECT id FROM audit_events WHERE target_type='capacity_provider_assignment' AND target_id=? AND event_type='assignment.content.integrated' LIMIT 1`,[assignment.id]):null;
			const now=new Date().toISOString();const successful=assignment.status==='completed'&&Boolean(String(row.final_message_ref??'').trim())&&Boolean(integrated);
			if(assignment.status==='completed'&&!successful)return operatorError(new CapacityGovernanceError('conversation_content_integration_pending','The provider assignment finished, but the exact final response and operational content have not been integrated and read back.',409,{assignmentId:assignment.id}));
			await store.run(`UPDATE agent_invocation_requests SET status=?,assignment_id=?,completed_at=COALESCE(completed_at,?),blocking_state_json=?,updated_at=? WHERE id=? AND team_id=? AND status IN ('admitted','running')`,[successful?'completed':'failed',assignment.id,now,JSON.stringify({code:successful?'durable_final_response':'terminal_assignment_without_final_response',assignmentStatus:assignment.status,lifecycleCode:assignment.lifecycle_code??null,lifecycleReason:assignment.lifecycle_reason??null,reconciledBy:key}),now,row.id,row.team_id]);
			return c.json({ok:true,payload:await store.first(`SELECT * FROM agent_invocation_requests WHERE id=?`,[row.id]),reconciled:true});
		}
		if(!assignment&&row.execution_id){
			const execution=await store.first(`SELECT id,status,error_json FROM capacity_workday_runs WHERE id=? AND team_id=?`,[row.execution_id,row.team_id]);
			if(execution&&['completed','failed','degraded','cancelled'].includes(String(execution.status))){
				const now=new Date().toISOString();
				await store.run(`UPDATE agent_invocation_requests SET status='failed',completed_at=COALESCE(completed_at,?),blocking_state_json=?,updated_at=? WHERE id=? AND team_id=? AND status IN ('admitted','running')`,[now,JSON.stringify({code:'terminal_execution_without_assignment',executionId:execution.id,executionStatus:execution.status,executionError:execution.error_json??null,reconciledBy:key}),now,row.id,row.team_id]);
				return c.json({ok:true,payload:await store.first(`SELECT * FROM agent_invocation_requests WHERE id=?`,[row.id]),reconciled:true});
			}
		}
	}
	if(!['queued','blocked','coalesced'].includes(String(row.status)))return operatorError(new CapacityGovernanceError('agent_invocation_not_cancellable','Only an unadmitted invocation can be cancelled directly.',409,{status:row.status,assignmentId:row.assignment_id??null}));
	const now=new Date().toISOString();
	await store.run(`UPDATE agent_invocation_requests SET status='cancelled',completed_at=?,blocking_state_json=?,updated_at=? WHERE id=? AND team_id=? AND status IN ('queued','blocked','coalesced')`,[now,JSON.stringify({code:'operator_cancelled',idempotencyKey:key,reason:body.reason??null}),now,row.id,row.team_id]);
	return c.json({ok:true,payload:await store.first(`SELECT * FROM agent_invocation_requests WHERE id=?`,[row.id])});
}

async function listCommunicationRecords(c: Parameters<Parameters<Hono['get']>[1]>[0],dependencies:WorkdayRouteDependencies,table:'agent_operation_handoffs'|'agent_client_actions'){
	const {store,read,query}=dependencies;const access=await read(c);if(access.response)return access.response;
	const limit=normalizeCapacityPageLimit(query(c,'limit'));const status=query(c,'status');
	return c.json({ok:true,payload:{items:await store.all(`SELECT * FROM ${table} WHERE team_id=? ${status?'AND status=?':''} ORDER BY created_at DESC,id DESC LIMIT ?`,status?[c.req.param('teamId'),status,limit]:[c.req.param('teamId'),limit]),page:{limit,hasMore:false,nextCursor:null}}});
}

export function installOperatorCommunicationRoutes(app: Hono,dependencies: WorkdayRouteDependencies) {
	const { store,read,query,notFound }=dependencies;
	app.get('/v1/teams/:teamId/agent-invocations',async(c)=>{const access=await read(c);if(access.response)return access.response;const executionKind=query(c,'executionKind');const status=query(c,'status');const clauses=['team_id=?'];const values:unknown[]=[c.req.param('teamId')];if(executionKind){clauses.push('execution_kind=?');values.push(executionKind);}if(status){clauses.push('status=?');values.push(status);}const limit=normalizeCapacityPageLimit(query(c,'limit'));return c.json({ok:true,payload:{items:await store.all(`SELECT * FROM agent_invocation_requests WHERE ${clauses.join(' AND ')} ORDER BY requested_at DESC,id DESC LIMIT ?`,[...values,limit]),page:{limit,hasMore:false,nextCursor:null}}});});
	app.get('/v1/teams/:teamId/agent-invocations/:invocationId',async(c)=>{const access=await read(c);if(access.response)return access.response;const row=await store.first(`SELECT * FROM agent_invocation_requests WHERE id=? AND team_id=?`,[c.req.param('invocationId'),c.req.param('teamId')]);return row?c.json({ok:true,payload:row}):notFound(c,'Unknown agent invocation.');});
	app.get('/v1/teams/:teamId/communication-status',async(c)=>{const access=await read(c);if(access.response)return access.response;const teamId=c.req.param('teamId');const now=new Date().toISOString();const [sessions,queue,assignments]=await Promise.all([store.all(`SELECT id,capacity_provider_id,execution_providers_json,metadata_json,refreshed_at,expires_at FROM capacity_provider_availability_sessions WHERE team_id=? AND status='open' AND expires_at>? ORDER BY refreshed_at DESC`,[teamId,now]),store.all(`SELECT status,priority_class,COUNT(*) AS count FROM agent_invocation_requests WHERE team_id=? AND execution_kind='conversation' GROUP BY status,priority_class ORDER BY status,priority_class`,[teamId]),store.all(`SELECT lane_id,lane_purpose,communication_overflow,status,COUNT(*) AS count FROM capacity_provider_assignments WHERE team_id=? AND execution_kind='conversation' GROUP BY lane_id,lane_purpose,communication_overflow,status ORDER BY lane_id,status`,[teamId])]);const readiness=sessions.map(providerReadiness);return c.json({ok:true,payload:{communicationReady:readiness.some((session)=>session.communicationReady),providers:readiness,queue,assignments,observedAt:now}});});
	app.get('/v1/teams/:teamId/operation-handoffs',(c)=>listCommunicationRecords(c,dependencies,'agent_operation_handoffs'));
	app.get('/v1/teams/:teamId/client-actions',(c)=>listCommunicationRecords(c,dependencies,'agent_client_actions'));
	app.post('/v1/teams/:teamId/agent-invocations/:invocationId/cancel',(c)=>cancelInvocation(c,dependencies));
}
