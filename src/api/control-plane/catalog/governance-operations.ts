import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { GovernanceServiceError } from '../governance/governance-service.ts';
import { ControlPlaneOperationError, type BoundOperation, type OperationInvocationContext } from './operation-registry.ts';

export interface GovernanceOperationDependencies {
	governance: {
		approvals(principal: OperationInvocationContext['principal'], projectId: string, query: Record<string, unknown>): Promise<Record<string, any>>;
		approval(principal: OperationInvocationContext['principal'], projectId: string, approvalId: string): Promise<Record<string, any>>;
		decideApproval(principal: OperationInvocationContext['principal'], projectId: string, approvalId: string, body: Record<string, unknown>, ifMatch?: string): Promise<Record<string, any>>;
		createProposal(principal: OperationInvocationContext['principal'], projectId: string, body: Record<string, unknown>): Promise<Record<string, any>>;
		updateProposal(principal: OperationInvocationContext['principal'], projectId: string, proposalId: string, body: Record<string, unknown>, ifMatch?: string): Promise<Record<string, any>>;
		openProposal(principal: OperationInvocationContext['principal'], projectId: string, proposalId: string, body: Record<string, unknown>, ifMatch?: string): Promise<Record<string, any>>;
		startVoting(principal: OperationInvocationContext['principal'], projectId: string, proposalId: string, body: Record<string, unknown>, ifMatch?: string): Promise<Record<string, any>>;
		vote(principal: OperationInvocationContext['principal'], projectId: string, proposalId: string, body: Record<string, unknown>): Promise<Record<string, any>>;
		evaluate(principal: OperationInvocationContext['principal'], projectId: string, proposalId: string, body: Record<string, unknown>, ifMatch?: string): Promise<Record<string, any>>;
		withdraw(principal: OperationInvocationContext['principal'], projectId: string, proposalId: string, body: Record<string, unknown>, ifMatch?: string): Promise<Record<string, any>>;
		supersede(principal: OperationInvocationContext['principal'], projectId: string, proposalId: string, body: Record<string, unknown>, ifMatch?: string): Promise<Record<string, any>>;
		proposals(principal: OperationInvocationContext['principal'], projectId: string, query: Record<string, unknown>): Promise<Record<string, any>>;
		proposal(principal: OperationInvocationContext['principal'], projectId: string, proposalId: string): Promise<Record<string, any>>;
		proposalEvents(principal: OperationInvocationContext['principal'], projectId: string, proposalId: string, query: Record<string, unknown>): Promise<Record<string, any>>;
		decisions(principal: OperationInvocationContext['principal'], projectId: string, query: Record<string, unknown>): Promise<Record<string, any>>;
		decision(principal: OperationInvocationContext['principal'], projectId: string, decisionId: string): Promise<Record<string, any>>;
		decisionEvents(principal: OperationInvocationContext['principal'], projectId: string, decisionId: string, query: Record<string, unknown>): Promise<Record<string, any>>;
	};
}

function result<T>(call: () => Promise<T>) {
	return call().catch((error) => {
		if (error instanceof GovernanceServiceError) throw new ControlPlaneOperationError(error.status, error.code, error.message);
		throw error;
	});
}

export function createGovernanceOperations(dependencies: GovernanceOperationDependencies): BoundOperation[] {
	const governance = dependencies.governance;
	return [
		{ binding: CONTROL_PLANE_OPERATIONS.governance.approvals,
			handler: (input, context) => result(() => governance.approvals(context.principal, input.path.projectId, input.query)) },
		{ binding: CONTROL_PLANE_OPERATIONS.governance.approval,
			handler: (input, context) => result(() => governance.approval(context.principal, input.path.projectId, input.path.approvalId)) },
		{ binding: CONTROL_PLANE_OPERATIONS.governance.decideApproval,
			handler: (input, context) => result(() => governance.decideApproval(context.principal, input.path.projectId, input.path.approvalId,
				input.body as Record<string, unknown>, context.ifMatch)) },
		{ binding: CONTROL_PLANE_OPERATIONS.governance.createProposal,
			handler: (input, context) => result(() => governance.createProposal(context.principal, input.path.projectId, input.body as Record<string, unknown>)) },
		{ binding: CONTROL_PLANE_OPERATIONS.governance.updateProposal,
			handler: (input, context) => result(() => governance.updateProposal(context.principal, input.path.projectId, input.path.proposalId, input.body as Record<string, unknown>, context.ifMatch)) },
		{ binding: CONTROL_PLANE_OPERATIONS.governance.openProposal,
			handler: (input, context) => result(() => governance.openProposal(context.principal, input.path.projectId, input.path.proposalId, input.body as Record<string, unknown>, context.ifMatch)) },
		{ binding: CONTROL_PLANE_OPERATIONS.governance.startVoting,
			handler: (input, context) => result(() => governance.startVoting(context.principal, input.path.projectId, input.path.proposalId, input.body as Record<string, unknown>, context.ifMatch)) },
		{ binding: CONTROL_PLANE_OPERATIONS.governance.vote,
			handler: (input, context) => result(() => governance.vote(context.principal, input.path.projectId, input.path.proposalId, input.body as Record<string, unknown>)) },
		{ binding: CONTROL_PLANE_OPERATIONS.governance.evaluate,
			handler: (input, context) => result(() => governance.evaluate(context.principal, input.path.projectId, input.path.proposalId, input.body as Record<string, unknown>, context.ifMatch)) },
		{ binding: CONTROL_PLANE_OPERATIONS.governance.withdraw,
			handler: (input, context) => result(() => governance.withdraw(context.principal, input.path.projectId, input.path.proposalId, input.body as Record<string, unknown>, context.ifMatch)) },
		{ binding: CONTROL_PLANE_OPERATIONS.governance.supersede,
			handler: (input, context) => result(() => governance.supersede(context.principal, input.path.projectId, input.path.proposalId, input.body as Record<string, unknown>, context.ifMatch)) },
		{ binding: CONTROL_PLANE_OPERATIONS.governance.proposals,
			handler: (input, context) => result(() => governance.proposals(context.principal, input.path.projectId, input.query)) },
		{ binding: CONTROL_PLANE_OPERATIONS.governance.proposal,
			handler: (input, context) => result(() => governance.proposal(context.principal, input.path.projectId, input.path.proposalId)) },
		{ binding: CONTROL_PLANE_OPERATIONS.governance.proposalEvents,
			handler: (input, context) => result(() => governance.proposalEvents(context.principal, input.path.projectId, input.path.proposalId, input.query)) },
		{ binding: CONTROL_PLANE_OPERATIONS.governance.decisions,
			handler: (input, context) => result(() => governance.decisions(context.principal, input.path.projectId, input.query)) },
		{ binding: CONTROL_PLANE_OPERATIONS.governance.decision,
			handler: (input, context) => result(() => governance.decision(context.principal, input.path.projectId, input.path.decisionId)) },
		{ binding: CONTROL_PLANE_OPERATIONS.governance.decisionEvents,
			handler: (input, context) => result(() => governance.decisionEvents(context.principal, input.path.projectId, input.path.decisionId, input.query)) },
	];
}
