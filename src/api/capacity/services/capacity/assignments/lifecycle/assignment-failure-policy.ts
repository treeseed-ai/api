import type { DurableProviderAssignment } from '../../../../repositories/capacity/assignments/assignment.ts';
import type { CapacityGovernanceDatabase } from '../../../../database.ts';
import { CapacityWorkdayRunRepository } from '../../../../repositories/capacity/workdays/workday-run.ts';
import { appliedWorkdaySchema, workdayPlanningEndsAt } from '@treeseed/sdk/agent-capacity';
import { runtimeWorkdayPhase } from '../../../build/ready-execution-node.ts';

type FailureInput={code?:unknown;reason?:unknown;message?:unknown};
function record(value:unknown):Record<string,unknown>{return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}

export function assignmentFailureDisposition(input:FailureInput){
	const value=`${String(input.code??'')} ${String(input.reason??input.message??'')}`.toLowerCase();
	if(/deadline|timeout/u.test(value))return 'deadline_exhausted';
	if(/budget|quota|token|cost|capacity/u.test(value))return 'budget_exhausted';
	if(/cancel|abort/u.test(value))return 'cancelled';
	if(/block|authority|credential|dependency|evidence/u.test(value))return 'blocked';
	return 'failed';
}

export function archivedConversationCancellation(assignment:DurableProviderAssignment,input:FailureInput){
	const metadata=record(assignment.metadata);
	return assignment.executionKind==='conversation'&&metadata.cancellationRequested===true
		&&String(metadata.cancellationReason??'')==='discussion_archived'&&String(input.code??'')==='discussion_archived';
}

/** Phase termination is cancellation, even when the provider beats periodic tick. */
export async function planningBoundaryCancellation(database: CapacityGovernanceDatabase,
	assignment: DurableProviderAssignment, input: FailureInput, now: string): Promise<boolean> {
	const activity = assignment.assignmentAttempt?.effectiveProfile.activity;
	if (!assignment.workDayId || !['planning', 'estimating'].includes(activity ?? '')
		|| !(input.code === 'assignment_timeout' || input.code === 'operator_cancelled' || (input.code === 'assignment_cancelled'
			&& record(assignment.metadata).cancellationRequested === true))) return false;
	const time = record(record(assignment.capacityEnvelope).budget).time;
	const authority = Date.parse(String(record(time).authorityDeadlineAt ?? ''));
	const productive = Date.parse(String(record(time).executionDeadlineAt ?? record(time).preparationDeadlineAt ?? ''));
	if (!Number.isFinite(authority) || !Number.isFinite(Date.parse(now)) || productive !== authority || Date.parse(now) < authority) return false;
	const run = await new CapacityWorkdayRunRepository(database).get(assignment.teamId, assignment.workDayId);
	if (!run || run.status !== 'running' || run.capacityProviderId !== assignment.capacityProviderId) return false;
	const plan = appliedWorkdaySchema.parse(run.parameters.appliedPlan);
	if (authority !== Date.parse(workdayPlanningEndsAt(plan))) return false;
	return await runtimeWorkdayPhase(database, run, now) !== 'planning';
}
