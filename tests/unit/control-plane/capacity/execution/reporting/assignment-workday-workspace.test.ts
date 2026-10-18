import {describe,expect,it} from 'vitest';
import {buildAssignmentAttempt} from '../../../../../../src/api/capacity/services/capacity/assignments/planning/execution/assignment-attempt-builder.ts';
import {canonicalOfferBuildInput} from '../fixtures/assignment-attempt-fixtures.ts';
describe('frozen Workday workspace authority',()=>{
 it('keeps a lifecycle workspace on its held workday project context when the governed library advances before issuance',()=>{
  const input=canonicalOfferBuildInput(),exact=structuredClone(input.candidate),held={store:'treedx' as const,model:'knowledge',id:exact.node.projectId+':project-context',repository:exact.projectContentRepositoryId,commit:'d'.repeat(40),path:'README.md',revision:1,digest:'sha256:'+'4'.repeat(64)};
  exact.node.kind='reporting';exact.node.pairRole=null;exact.node.workspace='treedx';exact.node.sourceRef={store:'postgresql',model:'workday',id:input.run.id,revision:1,digest:'sha256:'+'1'.repeat(64)};
  exact.node.requestedPermissions={content:{read:['knowledge'],write:['note']},tools:[]};exact.effectiveProfile.activity='reporting';exact.effectiveProfile.permissionCeiling=exact.node.requestedPermissions;
  exact.contextRefs=[{...held,id:'current-project-objective',commit:'e'.repeat(40),model:'objective',path:'objectives/core'},held];
  const run={...input.run,parameters:{...input.run.parameters,workdayContextByProjectId:{[exact.node.projectId]:held},appliedPlan:{...input.run.parameters.appliedPlan as object,state:'closing'}}};
  const before=structuredClone({exact,run}),build=()=>buildAssignmentAttempt({...input,candidate:exact,run});
  const result=build().assignment;expect(result.workspace).toMatchObject({mode:'treedx',baseCommit:held.commit});expect(result.grant.contentWrite[0]!.commit).toBe(held.commit);
  exact.contextRefs[0]!.commit='f'.repeat(40);expect(build().assignment.workspace).toEqual(result.workspace);
  expect(run).toEqual(before.run);
  for(const mode of ['missing','foreign','moved-context']){
   const denied=structuredClone(run);
   if(mode==='missing')Reflect.deleteProperty(denied.parameters,'workdayContextByProjectId');
   if(mode==='foreign')denied.parameters.workdayContextByProjectId[exact.node.projectId]!.repository='foreign';
   if(mode==='moved-context')denied.parameters.workdayContextByProjectId[exact.node.projectId]!.commit='a'.repeat(40);
   const unchanged=structuredClone(denied);expect(()=>buildAssignmentAttempt({...input,candidate:exact,run:denied})).toThrow('original exact workday project context');expect(denied).toEqual(unchanged);
  }
 });
});
