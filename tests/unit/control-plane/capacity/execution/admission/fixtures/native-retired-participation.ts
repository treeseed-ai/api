import {expect} from 'vitest';
import {assignmentAttemptSchema} from '@treeseed/sdk/agent-capacity';
import type {createControlPlanePostgresDatabase} from '../../../../../../../src/api/support/control-plane-postgres.ts';
import type {ControlPlaneStore} from '../../../../../../../src/api/persistence/store.ts';
import {ProviderAssignmentRepository} from '../../../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';
import {verifyNativeAssignmentReadback} from '../../../../../../acceptance/execution-inventory.ts';
import {verifyRetiredExecutionTables} from '../../../../../../acceptance/execution-retired-authority.ts';
type Row=Record<string,unknown>;

/** Reuse the original native admission, independent peer and public serializer.
 * Deliberately corrupt only this disposable owning database; never a managed run. */
export async function proveNativeRetiredParticipation(database:ReturnType<typeof createControlPlanePostgresDatabase>,peer:ReturnType<typeof createControlPlanePostgresDatabase>,accounting:ControlPlaneStore,original:Row,reservations:Row[]){
 const attempt=assignmentAttemptSchema.parse(JSON.parse(String(original.assignment_attempt_json))),run={id:attempt.workdayId,teamId:attempt.teamId},failures:unknown[]=[];
 const read=async()=>{const raw=(await peer.pool.query('SELECT * FROM capacity_provider_assignments WHERE id=$1',[attempt.id])).rows[0];const visible=await new ProviderAssignmentRepository(accounting).get(attempt.teamId,attempt.id);if(!raw||!visible)throw new Error('Original native/public assignment required');return{raw,visible};};
 const before=await read();verifyNativeAssignmentReadback(before.raw,{...before.visible},run,reservations,[before.raw]);
 for(const model of ['assignment_plan','assignment_status','assignment_summary','signal_graph','capacity_plan','demand','execution_input','source_candidate'])for(const location of ['source','authority','context','read','write','profile','permission-read','permission-write']){
  const current=structuredClone(attempt),reference={store:'treedx' as const,model,id:'retired-authority',revision:1,digest:'sha256:'+'a'.repeat(64),repository:'native-library',commit:'d'.repeat(40),path:'knowledge/retired.md'};
  if(location==='write'){current.grant.sourceWrite=[];current.workspace={mode:'treedx',repository:reference.repository,baseCommit:reference.commit,workspaceId:'native-content-workspace',writablePaths:['knowledge/retired.md']};}
  if(location==='source')current.sourceRef=reference;if(location==='authority')current.authorityRefs=[reference];if(location==='context')current.contextRefs.push(reference);if(location==='read')current.grant.contentRead.push(reference);if(location==='write')current.grant.contentWrite.push(reference);if(location==='profile')current.effectiveProfile.profileRef=reference;if(location==='permission-read')Reflect.set(current.effectiveProfile.permissionCeiling.content,'read',[...current.effectiveProfile.permissionCeiling.content.read,model]);if(location==='permission-write')Reflect.set(current.effectiveProfile.permissionCeiling.content,'write',[...current.effectiveProfile.permissionCeiling.content.write,model]);
  expect(assignmentAttemptSchema.safeParse(current).success,model+'/'+location).toBe(!location.startsWith('permission-'));
  try{
   await database.pool.query('UPDATE capacity_provider_assignments SET assignment_attempt_json=$1 WHERE id=$2',[JSON.stringify(current),attempt.id]);
   if(location.startsWith('permission-')){await expect(read()).rejects.toMatchObject({code:'provider_assignment_contract_invalid'});const denied=(await peer.pool.query('SELECT * FROM capacity_provider_assignments WHERE id=$1',[attempt.id])).rows[0];expect(JSON.parse(String(denied.assignment_attempt_json))).toEqual(current);failures.push(structuredClone(denied));expect((await peer.pool.query('SELECT * FROM capacity_provider_assignments WHERE id=$1',[attempt.id])).rows[0]).toEqual(denied);}
   else{const denied=await read(),held=structuredClone(denied);expect(denied.visible.assignmentAttempt).toEqual(current);
   expect(()=>verifyNativeAssignmentReadback(denied.raw,{...denied.visible},run,reservations,[denied.raw]),model+'/'+location).toThrow('ACCEPTANCE_RETIRED_PARTICIPATION');failures.push(held);expect(await read()).toEqual(held);}
  }finally{await database.pool.query('UPDATE capacity_provider_assignments SET assignment_attempt_json=$1 WHERE id=$2',[original.assignment_attempt_json,attempt.id]);}
  expect(await read()).toEqual(before);
 }
 expect(failures).toHaveLength(64);const held=structuredClone(failures);const catalog=async()=>(await peer.pool.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,column_name")).rows;
 const resolve=async(table:string)=>(await peer.pool.query('SELECT to_regclass($1) AS name',['public.'+table])).rows;
 await verifyRetiredExecutionTables(await catalog(),resolve);
 await database.pool.query('CREATE TABLE public.provider_source_candidates(id text PRIMARY KEY)');
 try{await expect(verifyRetiredExecutionTables(await catalog(),resolve)).rejects.toThrow('ACCEPTANCE_SCHEMA_RETIRED_TABLE');}
 finally{await database.pool.query('DROP TABLE public.provider_source_candidates');}
 await verifyRetiredExecutionTables(await catalog(),resolve);expect(failures).toEqual(held);expect(await Promise.all([read(),read()])).toEqual([before,before]);
}
