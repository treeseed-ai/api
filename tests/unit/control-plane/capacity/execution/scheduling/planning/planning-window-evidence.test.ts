import {planningWorkdayInputs,planningNodeInput} from './planning-window-fixture.ts';
import {describe,expect,it} from 'vitest';
import {compileWorkday,DEFAULT_WORKDAY_POLICY} from '@treeseed/sdk/agent-capacity';
import {assignment} from '../../fixtures/assignment.ts';
import {verifyPlanningWindow} from '../../../../../../acceptance/execution-planning-window.ts';

const plan=()=>compileWorkday({id:'workday',teamId:'team',policyId:'default',policyRevision:1,executionMode:'simulation',startsAt:'2026-09-13T12:00:00.000Z',agentIds:[],policy:{...DEFAULT_WORKDAY_POLICY,durationSeconds:3600,planningPercent:100/3}});
const attempt=(activity='acting',createdAt='2026-09-13T12:20:00.000Z')=>({...structuredClone(assignment),createdAt,effectiveProfile:{...assignment.effectiveProfile,activity}});
const phase=(value:{effectiveProfile:{activity:string}})=>({phase:['acting','reviewing','reporting'].includes(value.effectiveProfile.activity)?'acting':'planning'});
describe('original initial planning authority',()=>{
 it('constructs every canonical native planning Actor and Reviewer graph row before database preparation',()=>{for(const kind of ['planning','acting','reviewing']as const)for(const status of ['ready','assigned','running','blocked','completed','failed','cancelled','exhausted'])expect(planningNodeInput('node',kind,status)).toMatchObject({id:'node',kind,status,workdayId:'native-fluid-workday'});});
 it('constructs the exact bounded native workday from its original policy before any database or resource operation',()=>{
  const {startsAt,plan,originalRun}=planningWorkdayInputs();expect(originalRun).toMatchObject({id:plan.id,teamId:plan.teamId,status:'running',executionMode:plan.executionMode,startedAt:startsAt,parameters:{durationSeconds:plan.policySnapshot.durationSeconds,deadlineAt:plan.endsAt,appliedPlan:plan}});
  expect(originalRun.parameters.appliedPlan).toEqual(plan);expect(plan.policySnapshot.durationSeconds).toBe(3600);
 });

 it('denies missing malformed or contradictory original allocator phase rather than borrowing another activity pool',()=>{
  for(const activity of ['acting','reviewing','planning','estimating','chat','reporting']){
   const value=attempt(activity,activity==='chat'?'2026-09-13T12:19:00.000Z':'2026-09-13T12:20:00.000Z'),workday=plan();
   for(const opportunity of [undefined,null,{},[],{phase:'ended'},{phase:activity==='acting'||activity==='reviewing'||activity==='reporting'?'planning':'acting'}]){
    const held=structuredClone({value,workday,opportunity});expect(()=>verifyPlanningWindow(value,workday,opportunity)).toThrow('ACCEPTANCE_PLANNING_WINDOW');expect({value,workday,opportunity}).toEqual(held);
   }
  }
 });

 it('accepts acting and independent review only at or after the exact original planning floor without changing authority',()=>{
  for(const activity of ['acting','reviewing'])for(const createdAt of ['2026-09-13T12:20:00.000Z','2026-09-13T12:59:59.999Z']){
   const value=attempt(activity,createdAt),workday=plan(),held=structuredClone({value,workday});expect(()=>verifyPlanningWindow(value,workday,phase(value))).not.toThrow();expect({value,workday}).toEqual(held);
  }
 });
 it('denies early acting and review missing or foreign workday authority and malformed original clocks without repairing failed evidence',()=>{
  const value=attempt(),workday=plan();
  for(const changed of [attempt('acting','2026-09-13T12:19:59.999Z'),attempt('reviewing','2026-09-13T12:00:00.000Z'),{...value,workdayId:'foreign'},{...value,teamId:'foreign'}, {...value,createdAt:'invalid'}]){
   const held=structuredClone({changed,workday});expect(()=>verifyPlanningWindow(changed,workday,phase(changed))).toThrow();expect({changed,workday}).toEqual(held);
  }
  expect(()=>verifyPlanningWindow(value,undefined,phase(value))).toThrow();expect(()=>verifyPlanningWindow(undefined,workday,{phase:"acting"})).toThrow();
  expect(()=>verifyPlanningWindow(attempt('acting','2026-09-13T12:19:59.999Z'),workday,{phase:'acting'})).toThrow('ACCEPTANCE_PLANNING_WINDOW');
 });
 it('retains ordinary planning estimating chat and deterministic reporting without treating the initial percentage as a second activity deadline',()=>{
  for(const activity of ['planning','estimating','chat','reporting'])for(const createdAt of ['2026-09-13T12:00:00.000Z','2026-09-13T12:20:00.000Z','2026-09-13T13:00:01.000Z']){
   const value=attempt(activity,createdAt),workday=plan(),held=structuredClone({value,workday});expect(()=>verifyPlanningWindow(value,workday,phase(value))).not.toThrow();expect({value,workday}).toEqual(held);
  }
 });
});
