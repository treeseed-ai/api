import type { CapacityPage } from '@treeseed/sdk/capacity-pagination';
import type { DurableProviderAssignment } from '../../../../repositories/capacity/assignments/assignment.ts';
import type { ProviderLeasePrincipal } from '../../../accounts/lease-authority-service.ts';
import { resolveProviderSynthesisContext } from '../../providers/provider-synthesis-context-service.ts';
import { assignNextReadyExecutionNode } from '../planning/execution/living-execution-assignment.ts';
import type { LivingExecutionStore } from '../planning/support/living-execution-store.ts';

export interface ProviderSynthesisRequest {
	sessionId?: string | null;
	providerSessionId?: string | null;
	environment?: string | null;
	runnerId?: string | null;
	source?: string | null;
}

interface ProviderAssignmentFunctionStore extends LivingExecutionStore {
	listProjectAgentClassesPage(projectId: string, filters: { limit: number }): Promise<CapacityPage<unknown>>;
}

/**
 * The only production assignment-synthesis entrypoint. Ready living nodes are
 * claimed directly; no materialized demand or second graph may supply work.
 */
export async function synthesizeProviderAssignments(
	store: ProviderAssignmentFunctionStore,
	principal: ProviderLeasePrincipal,
	input: ProviderSynthesisRequest = {},
): Promise<{ assignments: DurableProviderAssignment[]; diagnostics: Record<string, unknown> }> {
	await store.ensureInitialized();
	const now = new Date().toISOString();
	const context = await resolveProviderSynthesisContext(store, principal, { ...input, now });
	const providerSessionId = String(input.sessionId ?? input.providerSessionId ?? context.session.id);
	const { assignment, selection } = await assignNextReadyExecutionNode(store, principal, providerSessionId, context.executionProviders, now);
	return {
		assignments: assignment ? [assignment] : [],
		diagnostics: { source: 'living-execution-graph', assigned: Boolean(assignment), selection },
	};
}
