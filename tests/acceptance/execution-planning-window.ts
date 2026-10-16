import assert from 'node:assert/strict';
import {appliedWorkdaySchema,assignmentAttemptSchema,workdayPlanningEndsAt} from '@treeseed/sdk/agent-capacity';

/** Compare original issued authority with its independently read owning workday.
 * The initial percentage is a floor, never a replacement deadline for planning. */
export function verifyPlanningWindow(attemptInput:unknown,planInput:unknown):void{
 const label='ACCEPTANCE_PLANNING_WINDOW: Acting and review must follow the original initial planning floor';
 const attempt=assignmentAttemptSchema.parse(attemptInput),plan=appliedWorkdaySchema.parse(planInput);
 assert.equal(attempt.workdayId,plan.id,label);assert.equal(attempt.teamId,plan.teamId,label);
 const issued=Date.parse(attempt.createdAt),floor=Date.parse(workdayPlanningEndsAt(plan));
 assert.ok(Number.isFinite(issued)&&Number.isFinite(floor),label);
 if(['acting','reviewing'].includes(attempt.effectiveProfile.activity))assert.ok(issued>=floor,label);
}
