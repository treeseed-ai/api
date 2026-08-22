import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { CapacityOperationError } from '../../repositories/capacity/capacity-operation-error.ts';
import { ControlPlaneOperationError, type BoundOperation, type OperationInvocationContext } from '../operation-registry.ts';

type Principal = OperationInvocationContext['principal'];
export interface WorkdayOperationDependencies { workdays: {
	list(principal: Principal, teamId: string, query: Record<string, unknown>): Promise<Record<string, unknown>>;
	preflight(principal: Principal, teamId: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
	start(principal: Principal, teamId: string, body: Record<string, unknown>, idempotencyKey?: string): Promise<Record<string, unknown>>;
	show(principal: Principal, teamId: string, runId: string): Promise<Record<string, unknown>>;
	events(principal: Principal, teamId: string, runId: string, query: Record<string, unknown>): Promise<Record<string, unknown>>;
	schedules(principal: Principal, teamId: string): Promise<Record<string, unknown>>;
	createSchedule(principal: Principal, teamId: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
	updateSchedule(principal: Principal, teamId: string, scheduleId: string, body: Record<string, unknown>, ifMatch?: string): Promise<Record<string, unknown>>;
}; }

function result<T>(call: () => T | Promise<T>) { return Promise.resolve().then(call).catch((error) => {
	if (error instanceof CapacityOperationError) throw new ControlPlaneOperationError(error.status, error.code, error.message);
	throw error;
}); }

export function createWorkdayOperations({ workdays }: WorkdayOperationDependencies): BoundOperation[] {
	return [
		{ binding: CONTROL_PLANE_OPERATIONS.workdays.list, handler: (input, context) => result(() => workdays.list(context.principal, input.path.teamId, input.query as Record<string, unknown>)) },
		{ binding: CONTROL_PLANE_OPERATIONS.workdays.preflight, handler: (input, context) => result(() => workdays.preflight(context.principal, input.path.teamId, input.body as Record<string, unknown>)) },
		{ binding: CONTROL_PLANE_OPERATIONS.workdays.start, handler: (input, context) => result(() => workdays.start(context.principal, input.path.teamId, input.body as Record<string, unknown>, context.idempotencyKey)) },
		{ binding: CONTROL_PLANE_OPERATIONS.workdays.show, handler: (input, context) => result(() => workdays.show(context.principal, input.path.teamId, input.path.runId)) },
		{ binding: CONTROL_PLANE_OPERATIONS.workdays.events, handler: (input, context) => result(() => workdays.events(context.principal, input.path.teamId, input.path.runId, input.query as Record<string, unknown>)) },
		{ binding: CONTROL_PLANE_OPERATIONS.workdays.schedules, handler: (input, context) => result(() => workdays.schedules(context.principal, input.path.teamId)) },
		{ binding: CONTROL_PLANE_OPERATIONS.workdays.createSchedule, handler: (input, context) => result(() => workdays.createSchedule(context.principal, input.path.teamId, input.body as Record<string, unknown>)) },
		{ binding: CONTROL_PLANE_OPERATIONS.workdays.updateSchedule, handler: (input, context) => result(() => workdays.updateSchedule(context.principal, input.path.teamId, input.path.scheduleId, input.body as Record<string, unknown>, context.ifMatch)) },
	];
}
