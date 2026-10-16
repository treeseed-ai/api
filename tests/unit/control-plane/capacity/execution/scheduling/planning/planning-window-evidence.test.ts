import {describe,expect,it} from 'vitest';
import {compileWorkday,DEFAULT_WORKDAY_POLICY} from '@treeseed/sdk/agent-capacity';
import {assignment} from '../../fixtures/assignment.ts';
import {verifyPlanningWindow} from '../../../../../../acceptance/execution-planning-window.ts';

const plan=()=>compileWorkday({id:'workday',teamId:'team',policyId:'default',policyRevision:1,executionMode:'simulation',startsAt:'2026-09-13T12:00:00.000Z',agentIds:[],policy:{...DEFAULT_WORKDAY_POLICY,durationSeconds:3600,planningPercent:100/3}});
const attempt=(activity='acting',createdAt='2026-09-13T12:20:00.000Z')=>({...structuredClone(assignment),createdAt,effectiveProfile:{...assignment.effectiveProfile,activity}});
describe('original initial planning authority',()=>{
 it('accepts acting and independent review only at or after the exact original planning floor without changing authority',()=>{
  for(const activity of ['acting','reviewing'])for(const createdAt of ['2026-09-13T12:20:00.000Z','2026-09-13T12:59:59.999Z']){
   const value=attempt(activity,createdAt),workday=plan(),held=structuredClone({value,workday});expect(()=>verifyPlanningWindow(value,workday)).not.toThrow();expect({value,workday}).toEqual(held);
  }
 });
 it('denies early acting and review missing or foreign workday authority and malformed original clocks without repairing failed evidence',()=>{
  const value=attempt(),workday=plan();
  for(const changed of [attempt('acting','2026-09-13T12:19:59.999Z'),attempt('reviewing','2026-09-13T12:00:00.000Z'),{...value,workdayId:'foreign'},{...value,teamId:'foreign'}, {...value,createdAt:'invalid'}]){
   const held=structuredClone({changed,workday});expect(()=>verifyPlanningWindow(changed,workday)).toThrow();expect({changed,workday}).toEqual(held);
  }
  expect(()=>verifyPlanningWindow(value,undefined)).toThrow();expect(()=>verifyPlanningWindow(undefined,workday)).toThrow();
  expect(()=>verifyPlanningWindow(attempt('acting','2026-09-13T12:19:59.999Z'),workday)).toThrow('ACCEPTANCE_PLANNING_WINDOW');
 });
 it('retains ordinary planning estimating chat and deterministic reporting without treating the initial percentage as a second activity deadline',()=>{
  for(const activity of ['planning','estimating','chat','reporting'])for(const createdAt of ['2026-09-13T12:00:00.000Z','2026-09-13T12:20:00.000Z','2026-09-13T13:00:01.000Z']){
   const value=attempt(activity,createdAt),workday=plan(),held=structuredClone({value,workday});expect(()=>verifyPlanningWindow(value,workday)).not.toThrow();expect({value,workday}).toEqual(held);
  }
 });
});
