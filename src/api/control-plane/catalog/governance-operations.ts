import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { GovernanceReaderError } from '../governance/governance-reader-service.ts';
import { ControlPlaneOperationError, type BoundOperation, type OperationInvocationContext } from './operation-registry.ts';

export interface GovernanceOperationDependencies {
	governanceReader: {
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
		if (error instanceof GovernanceReaderError) throw new ControlPlaneOperationError(error.status, error.code, error.message);
		throw error;
	});
}

export function createGovernanceOperations(dependencies: GovernanceOperationDependencies): BoundOperation[] {
	const reader = dependencies.governanceReader;
	return [
		{ binding: CONTROL_PLANE_OPERATIONS.governance.proposals,
			handler: (input, context) => result(() => reader.proposals(context.principal, input.path.projectId, input.query)) },
		{ binding: CONTROL_PLANE_OPERATIONS.governance.proposal,
			handler: (input, context) => result(() => reader.proposal(context.principal, input.path.projectId, input.path.proposalId)) },
		{ binding: CONTROL_PLANE_OPERATIONS.governance.proposalEvents,
			handler: (input, context) => result(() => reader.proposalEvents(context.principal, input.path.projectId, input.path.proposalId, input.query)) },
		{ binding: CONTROL_PLANE_OPERATIONS.governance.decisions,
			handler: (input, context) => result(() => reader.decisions(context.principal, input.path.projectId, input.query)) },
		{ binding: CONTROL_PLANE_OPERATIONS.governance.decision,
			handler: (input, context) => result(() => reader.decision(context.principal, input.path.projectId, input.path.decisionId)) },
		{ binding: CONTROL_PLANE_OPERATIONS.governance.decisionEvents,
			handler: (input, context) => result(() => reader.decisionEvents(context.principal, input.path.projectId, input.path.decisionId, input.query)) },
	];
}
