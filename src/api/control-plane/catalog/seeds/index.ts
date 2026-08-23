import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { SeedOperationError } from '../../seeds/seed-operation-error.ts';
import { ControlPlaneOperationError, type BoundOperation, type OperationInvocationContext } from '../operation-registry.ts';
type Principal = OperationInvocationContext['principal'];
export interface SeedOperationDependencies { seeds: {
	validate(principal: Principal, body: Record<string, unknown>): Promise<Record<string, unknown>>;
	runs(principal: Principal, query: Record<string, unknown>): Promise<Record<string, unknown>>;
	run(principal: Principal, runId: string): Promise<Record<string, unknown>>;
	plan(principal: Principal, name: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
	apply(principal: Principal, name: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
	show(principal: Principal, name: string): Promise<Record<string, unknown>>;
	verify(principal: Principal, name: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
	reconcile(principal: Principal, name: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
	resolveResources(principal: Principal, body: Record<string, unknown>): Promise<Record<string, unknown>>;
}; }
function result<T>(call: () => T | Promise<T>) { return Promise.resolve().then(call).catch((error) => {
	if (error instanceof SeedOperationError) throw new ControlPlaneOperationError(error.status, error.code, error.message);
	throw error;
}); }
export function createSeedOperations({ seeds }: SeedOperationDependencies): BoundOperation[] { return [
	{ binding: CONTROL_PLANE_OPERATIONS.seeds.runs, handler: (input, context) => result(() => seeds.runs(context.principal, input.query as Record<string, unknown>)) },
	{ binding: CONTROL_PLANE_OPERATIONS.seeds.run, handler: (input, context) => result(() => seeds.run(context.principal, input.path.runId)) },
	{ binding: CONTROL_PLANE_OPERATIONS.seeds.validate, handler: (input, context) => result(() => seeds.validate(context.principal, input.body as Record<string, unknown>)) },
	{ binding: CONTROL_PLANE_OPERATIONS.seeds.plan, handler: (input, context) => result(() => seeds.plan(context.principal, input.path.name, input.body as Record<string, unknown>)) },
	{ binding: CONTROL_PLANE_OPERATIONS.seeds.apply, handler: (input, context) => result(() => seeds.apply(context.principal, input.path.name, input.body as Record<string, unknown>)) },
	{ binding: CONTROL_PLANE_OPERATIONS.seeds.show, handler: (input, context) => result(() => seeds.show(context.principal, input.path.name)) },
	{ binding: CONTROL_PLANE_OPERATIONS.seeds.verify, handler: (input, context) => result(() => seeds.verify(context.principal, input.path.name, input.body as Record<string, unknown>)) },
	{ binding: CONTROL_PLANE_OPERATIONS.seeds.reconcile, handler: (input, context) => result(() => seeds.reconcile(context.principal, input.path.name, input.body as Record<string, unknown>)) },
	{ binding: CONTROL_PLANE_OPERATIONS.seeds.resolveResources, handler: (input, context) => result(() => seeds.resolveResources(context.principal, input.body as Record<string, unknown>)) },
]; }
