import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { CapacityOperationError } from '../../repositories/capacity/capacity-operation-error.ts';
import { CapacityGovernanceError } from '../../../capacity/database.ts';
import { ControlPlaneOperationError, controlPlaneErrorStatus, type BoundOperation } from '../operation-registry.ts';
import type { createWorkdayService } from '../../repositories/capacity/workday-service.ts';

export interface WorkdayOperationDependencies { workdays: ReturnType<typeof createWorkdayService>; }

function result<T>(call: () => T | Promise<T>) { return Promise.resolve().then(call).catch((error) => {
	if (error instanceof CapacityOperationError || error instanceof CapacityGovernanceError) throw new ControlPlaneOperationError(controlPlaneErrorStatus(error.status), error.code, error.message);
	throw error;
}); }

export function createWorkdayOperations({ workdays }: WorkdayOperationDependencies): BoundOperation[] {
	return [
		{ binding: CONTROL_PLANE_OPERATIONS.workdays.profilesList, handler: (input, context) => result(() => workdays.profilesList(context.principal, input.path.teamId, input.query as Record<string, unknown>)) },
		{ binding: CONTROL_PLANE_OPERATIONS.workdays.profilesShow, handler: (input, context) => result(() => workdays.profilesShow(context.principal, input.path.teamId, input.path.profileId)) },
		{ binding: CONTROL_PLANE_OPERATIONS.workdays.profilesUpdate, handler: (input, context) => result(() => workdays.profilesUpdate(context.principal, input.path.teamId, input.path.profileId, input.body, context.ifMatch)) },
		{ binding: CONTROL_PLANE_OPERATIONS.workdays.list, handler: (input, context) => result(() => workdays.list(context.principal, input.path.teamId, input.query as Record<string, unknown>)) },
		{ binding: CONTROL_PLANE_OPERATIONS.workdays.preflight, handler: (input, context) => result(() => workdays.preflight(context.principal, input.path.teamId, input.body as Record<string, unknown>)) },
		{ binding: CONTROL_PLANE_OPERATIONS.workdays.start, handler: (input, context) => result(() => workdays.start(context.principal, input.path.teamId, input.body as Record<string, unknown>, context.idempotencyKey)) },
		{ binding: CONTROL_PLANE_OPERATIONS.workdays.show, handler: (input, context) => result(() => workdays.show(context.principal, input.path.teamId, input.path.runId)) },
		{ binding: CONTROL_PLANE_OPERATIONS.workdays.stop, handler: (input, context) => result(() => workdays.stop(context.principal, input.path.teamId, input.path.runId, input.body as Record<string, unknown>)) },
		{ binding: CONTROL_PLANE_OPERATIONS.workdays.events, handler: (input, context) => result(() => workdays.events(context.principal, input.path.teamId, input.path.runId, input.query as Record<string, unknown>)) },
		{ binding: CONTROL_PLANE_OPERATIONS.workdays.schedules, handler: (input, context) => result(() => workdays.schedules(context.principal, input.path.teamId)) },
		{ binding: CONTROL_PLANE_OPERATIONS.workdays.createSchedule, handler: (input, context) => result(() => workdays.createSchedule(context.principal, input.path.teamId, input.body as Record<string, unknown>)) },
		{ binding: CONTROL_PLANE_OPERATIONS.workdays.updateSchedule, handler: (input, context) => result(() => workdays.updateSchedule(context.principal, input.path.teamId, input.path.scheduleId, input.body as Record<string, unknown>, context.ifMatch)) },
	];
}
