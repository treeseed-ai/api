import assert from 'node:assert/strict';
import {appliedWorkdaySchema,assignmentAttemptSchema,workdayPlanningEndsAt} from '@treeseed/sdk/agent-capacity';

/** Compare original issued authority with its independently read owning workday.
 * The initial percentage is a floor, never a replacement deadline for planning. */
export function verifyPlanningWindow(attemptInput:unknown,planInput:unknown,opportunityInput:unknown):void{
 const label='ACCEPTANCE_PLANNING_WINDOW: Acting and review must follow the original initial planning floor';
 const attempt=assignmentAttemptSchema.parse(attemptInput),plan=appliedWorkdaySchema.parse(planInput);
 assert.equal(attempt.workdayId,plan.id,label);assert.equal(attempt.teamId,plan.teamId,label);
 const issued=Date.parse(attempt.createdAt),floor=Date.parse(workdayPlanningEndsAt(plan));
 assert.ok(Number.isFinite(issued)&&Number.isFinite(floor),label);

 assert.ok(opportunityInput&&typeof opportunityInput==='object'&&!Array.isArray(opportunityInput),label);
 const opportunity=opportunityInput as Record<string,unknown>,activity=attempt.effectiveProfile.activity;
 assert.ok(Object.hasOwn(opportunity,'phase')&&['planning','acting'].includes(String(opportunity.phase)),label);
 if(['acting','reviewing'].includes(activity)){assert.ok(issued>=floor,label);assert.equal(opportunity.phase,'acting',label);}
 if(['planning','estimating'].includes(activity)||activity==='chat'&&issued<floor)assert.equal(opportunity.phase,'planning',label);
 if(activity==='reporting')assert.equal(opportunity.phase,'acting',label);

}
