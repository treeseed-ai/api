import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import type { createCapabilityOntologyService } from '../../repositories/capabilities/capability-ontology-service.ts';
import type { BoundOperation } from '../operation-registry.ts';

export interface CapabilityOntologyOperationDependencies { capabilityOntology: ReturnType<typeof createCapabilityOntologyService> }
export function createCapabilityOntologyOperations({ capabilityOntology }: CapabilityOntologyOperationDependencies): BoundOperation[] {
	return [
		{ binding: CONTROL_PLANE_OPERATIONS.capabilities.list, handler: (input) => capabilityOntology.list(input.query as Record<string,unknown>) },
		{ binding: CONTROL_PLANE_OPERATIONS.capabilities.show, handler: (input) => capabilityOntology.show(input.path.capabilityId, input.query.version) },
		{ binding: CONTROL_PLANE_OPERATIONS.capabilities.generation, handler: () => capabilityOntology.active() },
		{ binding: CONTROL_PLANE_OPERATIONS.providers.capabilityProposal, handler: (input,context) => capabilityOntology.propose(context.providerAuth, input.body as Record<string,unknown>) },
		{ binding: CONTROL_PLANE_OPERATIONS.providers.capabilityProposalStatus, handler: (input,context) => capabilityOntology.proposal(context.providerAuth, input.path.proposalId) },
	];
}
