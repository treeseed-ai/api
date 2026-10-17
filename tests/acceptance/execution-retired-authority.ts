import assert from 'node:assert/strict';
import type {AssignmentAttempt} from '@treeseed/sdk/agent-capacity';
type Row=Record<string,unknown>;
const retiredModels=new Set(['assignment_plan','assignment_status','assignment_summary','signal_graph','capacity_plan','demand','execution_input','source_candidate']);

/** Inspect canonical authority, not arbitrary prose or API-owned capacity provenance. */
export function verifyNoRetiredExecutionReferences(attempt:AssignmentAttempt):void {
 const references=[attempt.sourceRef,...attempt.authorityRefs,attempt.effectiveProfile.profileRef,...attempt.contextRefs,...attempt.grant.contentRead,...attempt.grant.contentWrite];
 for(const reference of references)assert.ok(!retiredModels.has(reference.model),'ACCEPTANCE_RETIRED_PARTICIPATION: Retired content authority participates');
 for(const model of [...attempt.effectiveProfile.permissionCeiling.content.read,...attempt.effectiveProfile.permissionCeiling.content.write])
  assert.ok(!retiredModels.has(model),'ACCEPTANCE_RETIRED_PARTICIPATION: Retired content permission participates');
}

/** Original native catalog/to_regclass proof, shared by managed and native cases. */
export async function verifyRetiredExecutionTables(catalog:readonly Row[],resolve:(table:string)=>Promise<unknown>):Promise<void> {
 const label='ACCEPTANCE_SCHEMA_RETIRED_TABLE: Retired scheduling authority remains';
 assert.ok(Array.isArray(catalog)&&catalog.length>0,label);const identities=new Set<string>();
 for(const value of catalog){assert.ok(value&&typeof value==='object'&&typeof value.table_name==='string'&&value.table_name&&typeof value.column_name==='string'&&value.column_name,label);const key=JSON.stringify([value.table_name,value.column_name]);assert.ok(!identities.has(key),label);identities.add(key);}
 for(const table of ['agent_capacity_plans','capacity_workday_demands','capacity_workday_participation_cycles','capacity_workday_participation_entries','agent_mode_runs','workday_capacity_envelopes','decision_assignment_graphs','capacity_allocation_sets','provider_source_candidates']){
  assert.ok(!catalog.some(value=>value.table_name===table),label);assert.deepEqual(await resolve(table),[{name:null}],label);
 }
}
