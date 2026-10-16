import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {canonicalStandardsJson} from '@treeseed/sdk/standards';
import {appliedWorkdaySchema} from '@treeseed/sdk/agent-capacity';
import {capacityTransaction} from '../../../transaction.ts';
import {CapacityGovernanceError} from '../../../database.ts';
import {CapacityWorkdayEventRepository,type CapacityWorkdayEventWrite} from './workday-event.ts';
import type { CapacityWorkdayRunRecord,CapacityWorkdayRunStatus } from '@treeseed/sdk/agent-capacity';
import type { CapacityGovernanceDatabase } from '../../../database.ts';
import { CapacityWorkdayRunRepository } from './workday-run.ts';

type Row = Record<string, unknown>;

export class CapacityWorkdayRunWriteRepository {
	private readonly reads: CapacityWorkdayRunRepository;
	constructor(private readonly database: CapacityGovernanceDatabase) { this.reads = new CapacityWorkdayRunRepository(database); }
	private insertOperation(value: CapacityWorkdayRunRecord) {
		return { query: `INSERT INTO capacity_workday_runs (id, team_id, capacity_provider_id, scenario_id, status, environment, execution_mode, execution_kind, trigger_kind, hidden, requested_by_id,
			parameters_json, summary_json, metrics_json, expected_json, actual_json, report_refs_json, error_json, started_at, completed_at, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, params: [value.id, value.teamId, value.capacityProviderId, value.scenarioId, value.status,
			value.environment, value.executionMode, value.executionKind ?? 'workday', value.triggerKind ?? 'scheduled', value.hidden ? 1 : 0, value.requestedById, JSON.stringify(value.parameters), JSON.stringify(value.summary), JSON.stringify(value.metrics), JSON.stringify(value.expected),
			JSON.stringify(value.actual), JSON.stringify(value.reportRefs), JSON.stringify(value.error), value.startedAt, value.completedAt, value.createdAt, value.updatedAt] };
	}

	async create(value: CapacityWorkdayRunRecord): Promise<CapacityWorkdayRunRecord> {
		await this.database.ensureInitialized();
		const operation = this.insertOperation(value);
		await this.database.run(operation.query, operation.params);
		return (await this.reads.get(value.teamId, value.id))!;
	}

	async update(value: CapacityWorkdayRunRecord, expectedStatus: CapacityWorkdayRunStatus): Promise<CapacityWorkdayRunRecord | null> {
		await this.database.ensureInitialized();
  return capacityTransaction(this.database,async database=>{
   await database.run('SELECT id FROM capacity_workday_runs WHERE id=? AND team_id=? FOR UPDATE',[value.id,value.teamId]);
   const reads=new CapacityWorkdayRunRepository(database),before=await reads.get(value.teamId,value.id);
   if(!before||before.status!==expectedStatus)return null;
   const previous=before.parameters.appliedPlan===undefined?null:appliedWorkdaySchema.parse(before.parameters.appliedPlan);
   const proposed=value.parameters.appliedPlan===undefined?null:appliedWorkdaySchema.parse(value.parameters.appliedPlan);
   if(previous){
    const states=['planned','active','closing','ended'];
    if(!proposed||states.indexOf(proposed.state)<states.indexOf(previous.state)
     ||['id','teamId','executionMode','startsAt','endsAt','policyId','policyRevision','policySnapshot'].some(field=>!isDeepStrictEqual(Reflect.get(previous,field),Reflect.get(proposed,field)))
     ||['activatedAt','closingAt','endedAt','reportRef'].some(field=>Reflect.get(previous,field)!==undefined&&!isDeepStrictEqual(Reflect.get(previous,field),Reflect.get(proposed,field))))throw new CapacityGovernanceError('workday_transition_stale','Workday transition cannot replace original authority or regress its lifecycle.',409);
   }
   const results=await database.batch([{ query: `UPDATE capacity_workday_runs SET capacity_provider_id = ?, scenario_id = ?, status = ?, environment = ?, execution_mode = ?, execution_kind = ?, trigger_kind = ?, hidden = ?,
			parameters_json = ?, summary_json = ?, metrics_json = ?, expected_json = ?, actual_json = ?, report_refs_json = ?, error_json = ?, started_at = ?, completed_at = ?, updated_at = ?
			WHERE id = ? AND team_id = ? AND status = ? RETURNING id`, params: [value.capacityProviderId, value.scenarioId, value.status, value.environment, value.executionMode, value.executionKind ?? 'workday', value.triggerKind ?? 'scheduled', value.hidden ? 1 : 0,
			JSON.stringify(value.parameters), JSON.stringify(value.summary), JSON.stringify(value.metrics), JSON.stringify(value.expected), JSON.stringify(value.actual),
			JSON.stringify(value.reportRefs), JSON.stringify(value.error), value.startedAt, value.completedAt, value.updatedAt, value.id, value.teamId, expectedStatus] }]);
   if(!(results as Array<{results?:Row[]}>)[0]?.results?.[0])return null;
   const after=await reads.get(value.teamId,value.id);if(!after)throw new Error('workday_transition_readback_missing');
   const next=after.parameters.appliedPlan===undefined?null:appliedWorkdaySchema.parse(after.parameters.appliedPlan);
   if(before.status!==after.status||!isDeepStrictEqual(previous,next)){
    const context={previousStatus:before.status,status:after.status,previousPlan:previous,plan:next};
    const receipt:CapacityWorkdayEventWrite={id:'workday-lifecycle:'+value.id+':'+createHash('sha256').update(canonicalStandardsJson(context)).digest('hex'),
     projectId:null,workdayId:value.id,assignmentId:null,eventType:'workday.lifecycle.changed',status:'recorded',title:null,message:null,parameters:{},context,refs:{},metadata:{},createdAt:after.updatedAt};
    const observed=await new CapacityWorkdayEventRepository(database).create(value.teamId,value.id,receipt);
    if(!observed)throw new Error('workday_transition_observation_missing');
    if(!Number.isSafeInteger(observed.eventIndex)||observed.eventIndex<0||!isDeepStrictEqual(observed,{...receipt,teamId:value.teamId,runId:value.id,eventIndex:observed.eventIndex}))throw new Error('workday_transition_observation_conflict');
   }
   return after;
  });
	}

}
