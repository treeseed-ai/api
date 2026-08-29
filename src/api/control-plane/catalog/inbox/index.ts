import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { InboxServiceError } from '../../inbox/inbox-service.ts';
import { ControlPlaneOperationError, type BoundOperation, type OperationInvocationContext } from '../operation-registry.ts';

type Principal = OperationInvocationContext['principal'];
type Row = Record<string, unknown>;
export interface InboxOperationDependencies { inbox: {
	list(principal: Principal, teamId: string, query: Row): Promise<Row>; show(principal: Principal, teamId: string, itemId: string): Promise<Row>;
	events(principal: Principal, teamId: string, query: Row): Promise<Row>; createQuestion(principal: Principal, teamId: string, body: Row, idempotencyKey?: string): Promise<Row>;
	draft(principal: Principal, teamId: string, itemId: string, purpose: string): Promise<Row|null>; putDraft(principal: Principal, teamId: string, itemId: string, purpose: string, body: Row, ifMatch?: string): Promise<Row>;
	deleteDraft(principal: Principal, teamId: string, itemId: string, purpose: string): Promise<Row>; action(principal: Principal, teamId: string, itemId: string, body: Row, idempotencyKey?: string, ifMatch?: string): Promise<Row>;
}; }
function result<T>(call: () => Promise<T>) { return call().catch((error) => { if (error instanceof InboxServiceError) throw new ControlPlaneOperationError(error.status, error.code, error.message); throw error; }); }
export function createInboxOperations(dependencies: InboxOperationDependencies): BoundOperation[] { const service=dependencies.inbox, operations=CONTROL_PLANE_OPERATIONS.inbox; return [
	{binding:operations.list,handler:(value,context)=>result(()=>service.list(context.principal,value.path.teamId,value.query as Row))},
	{binding:operations.show,handler:(value,context)=>result(()=>service.show(context.principal,value.path.teamId,value.path.itemId))},
	{binding:operations.events,handler:(value,context)=>result(()=>service.events(context.principal,value.path.teamId,value.query as Row))},
	{binding:operations.createQuestion,handler:(value,context)=>result(()=>service.createQuestion(context.principal,value.path.teamId,value.body as Row,context.idempotencyKey))},
	{binding:operations.getDraft,handler:(value,context)=>result(()=>service.draft(context.principal,value.path.teamId,value.path.itemId,value.path.purpose))},
	{binding:operations.putDraft,handler:(value,context)=>result(()=>service.putDraft(context.principal,value.path.teamId,value.path.itemId,value.path.purpose,value.body as Row,context.ifMatch))},
	{binding:operations.deleteDraft,handler:(value,context)=>result(()=>service.deleteDraft(context.principal,value.path.teamId,value.path.itemId,value.path.purpose))},
	{binding:operations.action,handler:(value,context)=>result(()=>service.action(context.principal,value.path.teamId,value.path.itemId,value.body as Row,context.idempotencyKey,context.ifMatch))},
]; }
