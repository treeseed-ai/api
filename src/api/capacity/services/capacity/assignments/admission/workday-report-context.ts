import {isDeepStrictEqual} from 'node:util';
import {serializeCapacityWorkdayEventRow} from '../../../../repositories/capacity/workdays/workday-event.ts';
import {executionNodeWorkdayScope} from '../../../build/execution-node-scope.ts';
import { createHash } from 'node:crypto';
import { canonicalStandardsJson } from '@treeseed/sdk/standards';
import { appliedWorkdaySchema, authorizedContextItemSchema, type AssignmentAttempt } from '@treeseed/sdk/agent-capacity';
import type { CapacityGovernanceDatabase } from '../../../../database.ts';
import { CapacityGovernanceError } from '../../../../database.ts';
import { redactSensitiveValue } from '../../../../../../security/redact-sensitive-value.ts';
import { serializeCapacityLedgerEntryRow } from '../../../../repositories/capacity/accounting/ledger.ts';

/** Snapshot existing execution authority for the native Reporter; never copy credential custody. */
export async function workdayReportContext(store: CapacityGovernanceDatabase, assignment: AssignmentAttempt) {
	if (assignment.effectiveProfile.activity !== 'reporting') return [];
	if (assignment.sourceRef.store !== 'postgresql' || assignment.sourceRef.model !== 'workday'
		|| assignment.sourceRef.id !== assignment.workdayId) throw new CapacityGovernanceError(
			'reporter_workday_authority_required', 'Reporter must reference its own workday.', 409);
	const run=await store.first('SELECT id,team_id,status,execution_mode,execution_kind,parameters_json FROM capacity_workday_runs WHERE team_id=? AND id=? LIMIT 1',[assignment.teamId,assignment.workdayId]);
	if(!run||run.execution_kind!=='workday')throw new CapacityGovernanceError('reporter_workday_authority_required','Reporter requires its original Workday.',409);
	let decoded:unknown;try{decoded=typeof run.parameters_json==='string'?JSON.parse(run.parameters_json):run.parameters_json;}catch{decoded=null;}
	if(!decoded||typeof decoded!=='object'||Array.isArray(decoded))throw new CapacityGovernanceError('reporter_workday_authority_required','Reporter Workday selection is malformed.',409);
	const parameters=decoded as Record<string,unknown>,ids=parameters.proposalIds;
	if(Object.hasOwn(parameters,'proposalIds')&&(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'||!id.trim()||id!==id.trim())||new Set(ids).size!==ids.length))
		throw new CapacityGovernanceError('reporter_workday_authority_required','Reporter proposal selection is malformed.',409);
	const parsed=appliedWorkdaySchema.safeParse(parameters.appliedPlan);
	if(!parsed.success||!isDeepStrictEqual(parsed.data,parameters.appliedPlan)||parsed.data.state!=='closing'||parsed.data.id!==assignment.workdayId||parsed.data.teamId!==assignment.teamId||parsed.data.executionMode!==run.execution_mode||run.status!=='running'||parsed.data.planningRounds.some(round=>round.state!=='complete'))
		throw new CapacityGovernanceError('reporter_workday_authority_required','Reporter requires its original closing Workday and ended planning rounds.',409);
	const appliedPlan=parsed.data;
	const graph=executionNodeWorkdayScope({id:assignment.workdayId,executionKind:run.execution_kind as 'workday'|'conversation',parameters:parameters as Record<string,unknown>});
	const scope = [assignment.teamId, assignment.workdayId],graphParameters=[assignment.teamId,...graph.parameters];
	const [nodes, edges, attempts, reservations, usage, ledger] = await Promise.all([
		store.all(`SELECT id,kind,pair_role,status,node_revision,source_ref_json,authority_refs_json
			FROM execution_nodes node WHERE node.team_id=? AND ${graph.sql} ORDER BY node.id`, graphParameters),
		store.all(`SELECT edge.id,edge.from_node_id,edge.to_node_id,edge.provenance
			FROM execution_edges edge JOIN execution_nodes node ON node.team_id=edge.team_id AND node.id=edge.to_node_id
			WHERE node.team_id=? AND ${graph.sql} AND edge.graph_revision_removed IS NULL ORDER BY edge.id`, graphParameters),
		store.all(`SELECT id,execution_node_id,execution_node_revision,status,reservation_id,execution_provider_id,
			assignment_result_json,lifecycle_code,created_at,completed_at,failed_at,
			lifecycle_output_json::jsonb #>> '{activityCompletion,reviewDisposition}' AS review_disposition,
			lifecycle_output_json::jsonb #> '{teardown}' AS teardown_result,
			lifecycle_output_json::jsonb #>> '{teardown,status}' AS teardown_status
			FROM capacity_provider_assignments WHERE team_id=? AND work_day_id=? ORDER BY created_at,id`, scope),
		store.all(`SELECT id,assignment_id,state,requested_seconds,reserved_seconds,active_seconds,elapsed_seconds,
			released_seconds,overrun_seconds FROM capacity_reservations WHERE team_id=? AND work_day_id=? ORDER BY id`, scope),
		store.all(`SELECT usage.id,usage.assignment_id,usage.assignment_attempt,usage.usage_dimension,
			usage.active_seconds,usage.elapsed_seconds,usage.input_tokens,usage.cached_input_tokens,usage.output_tokens,
			usage.reasoning_tokens FROM capacity_usage_actuals usage JOIN capacity_provider_assignments assignment
			ON assignment.id=usage.assignment_id WHERE assignment.team_id=? AND assignment.work_day_id=? ORDER BY usage.id`, scope),
		store.all(`SELECT id,settlement_key,membership_id,capacity_provider_id,reservation_id,assignment_id,mode,
			team_id,project_id,work_day_id,task_id,phase,active_seconds,elapsed_seconds,provider_units,usd,source,metadata_json,created_at
			FROM capacity_ledger_entries WHERE team_id=? AND work_day_id=?
			AND phase='task_completed_actual_settlement' ORDER BY created_at,id`, scope),
	]);
	if (attempts.some(row => ['pending', 'leased', 'running'].includes(String(row.status)))
		|| reservations.some(row => !['consumed', 'released', 'expired', 'failed'].includes(String(row.state)))) {
		throw new CapacityGovernanceError('reporter_unsettled_workday', 'Reporter requires settled predecessor attempts.', 409);
	}
	const publicAttempts = attempts.map(row => Object.hasOwn(row, 'teardown_result')
		? { ...row, teardown_result: redactSensitiveValue(row.teardown_result) } : row);
	const settlements = ledger.map(row => serializeCapacityLedgerEntryRow(row)!.usageSettlement);
	if (reservations.some(reservation => reservation.state === 'consumed' && !settlements.some(settlement =>
		settlement !== undefined && settlement.reservationId === reservation.id && settlement.assignmentId === reservation.assignment_id))) {
		throw new CapacityGovernanceError('reporter_unsettled_workday', 'Consumed reservations require their original canonical settlements.', 409);
	}
	const closingRows=await store.all(`SELECT id,run_id,team_id,project_id,workday_id,assignment_id,event_index,event_type,status,title,message,parameters_json,context_json,refs_json,metadata_json,created_at
		FROM capacity_workday_events WHERE team_id=? AND run_id=? AND event_type='workday.lifecycle.changed'
		AND context_json::jsonb #>> '{plan,state}'='closing' ORDER BY event_index`,scope);
	const events=closingRows.map(serializeCapacityWorkdayEventRow),closingEvent=events[0];
	const authority=(plan:typeof appliedPlan)=>{const{admittedSecondsByProject:_projects,admittedSecondsByAgentClass:_agents,...original}=plan;return original;};
	let previous:typeof appliedPlan|undefined;
	const terminal=new Set(['completed','failed','cancelled','stale']);
	const states=new Map(nodes.map(node=>[String(node.id),String(node.status)]));
	for(const [index,event] of events.entries()){
		const parsedEvent=appliedWorkdaySchema.safeParse(event?.context.plan),prior=appliedWorkdaySchema.safeParse(event?.context.previousPlan);
		let valid=event!==null&&parsedEvent.success&&prior.success;
		if(valid&&event&&parsedEvent.success&&prior.success){
			const plan=parsedEvent.data,before=prior.data;
			valid=event.teamId===assignment.teamId&&event.runId===assignment.workdayId&&event.workdayId===assignment.workdayId
				&&event.status==='recorded'&&event.assignmentId===null&&event.projectId===null&&event.context.status==='running'
				&&isDeepStrictEqual(plan,event.context.plan)&&isDeepStrictEqual(before,event.context.previousPlan)
				&&Number.isFinite(Date.parse(event.createdAt))
				&&event.id==='workday-lifecycle:'+assignment.workdayId+':'+createHash('sha256').update(canonicalStandardsJson(event.context)).digest('hex')
				&&(index===0?before.state!=='closing':before.state==='closing'&&isDeepStrictEqual(authority(before),authority(previous!)));
			const {planningRounds:oldRounds,...oldAuthority}=authority(index===0?plan:previous!);
			const {planningRounds:newRounds,...newAuthority}=authority(plan);
			valid=valid&&isDeepStrictEqual(oldAuthority,newAuthority)&&oldRounds.length===newRounds.length;
			for(const [roundIndex,old]of oldRounds.entries()){
				const next=newRounds[roundIndex];
				valid=valid&&Boolean(next)&&old.round===next?.round&&isDeepStrictEqual(old.assignmentIds,next?.assignmentIds)
					&&['pending','active','complete'].indexOf(next!.state)>=['pending','active','complete'].indexOf(old.state)
					&&['startedAt','completedAt'].every(field=>Reflect.get(old,field)===undefined||Reflect.get(old,field)===Reflect.get(next!,field));
				if(valid&&old.state!=='complete'&&next!.state==='complete')valid=old.assignmentIds.every(id=>terminal.has(states.get(id)??''))
					&&Number.isFinite(Date.parse(next!.completedAt!))&&Date.parse(next!.completedAt!)<=Date.parse(event.createdAt);
			}
			previous=plan;
		}
		if(!valid)throw new CapacityGovernanceError('reporter_workday_authority_required','Reporter requires its exact original public closing history and terminal planning observations.',409);
	}
	if(!closingEvent||!previous||!isDeepStrictEqual(authority(previous),authority(appliedPlan)))
		throw new CapacityGovernanceError('reporter_workday_authority_required','Reporter requires the exact original public closing observation.',409);
	const value = { teamId: assignment.teamId, workdayId: assignment.workdayId,closingEvent,nodes, edges,
		attempts: publicAttempts, reservations, usage, settlements };
	return [authorizedContextItemSchema.parse({ ref: assignment.sourceRef, mediaType: 'application/json',
		digest: `sha256:${createHash('sha256').update(canonicalStandardsJson(value)).digest('hex')}`, value })];
}
