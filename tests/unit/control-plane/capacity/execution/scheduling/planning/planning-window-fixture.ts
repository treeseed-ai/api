import {compileWorkday,DEFAULT_WORKDAY_POLICY} from '@treeseed/sdk/agent-capacity';
import {compileCapacityWorkdayRunRecord} from '../../../../../../../src/api/capacity/services/capacity/workdays/scheduling/workday-run-service.ts';

/** Controlled original authority shared by cheap constructor and native SQL proof. */
export function planningWorkdayInputs(){
  const startsAt='2026-10-03T12:00:00.000Z',floor='2026-10-03T12:20:00.000Z',after='2026-10-03T12:20:01.000Z';
  const plan={...compileWorkday({id:'native-fluid-workday',teamId:'team',policyId:'default',policyRevision:1,executionMode:'simulation',startsAt,agentIds:['project/configured:planning'],policy:{...DEFAULT_WORKDAY_POLICY,durationSeconds:3600,planningPercent:100/3,maximumConcurrency:5,communicationConcurrency:5}}),state:'active' as const,activatedAt:startsAt};
  const originalRun=compileCapacityWorkdayRunRecord('team',{id:plan.id,status:'running',executionMode:'simulation',startedAt:startsAt,parameters:{appliedPlan:plan,scheduledProjectIds:['project']}},{now:startsAt});
 return {startsAt,floor,after,plan,originalRun};
}
