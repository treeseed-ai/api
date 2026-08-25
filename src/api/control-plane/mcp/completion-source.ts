import type { OperationInvocationContext, OperationRegistry } from '../catalog/operation-registry.ts';
import { enforceOperationAuthorization } from '../authorization/invocation-policy.ts';

const sourceOperations: Readonly<Record<string, string>> = {
	projectId: 'projects.list',
	teamId: 'teams.list',
	proposalId: 'governance.proposals.list',
	decisionId: 'governance.decisions.list',
	graphId: 'assignment.graphs.list',
	workflowId: 'research.workflows.list',
	connectionId: 'services.connections.list',
	agentSlug: 'agents.list',
	invocationId: 'communications.invocations.list',
	capacityPlanId: 'plans.list',
	runId: 'workdays.list',
	assignmentId: 'assignments.list',
	operationId: 'operations.list',
};

function collect(value: unknown, variable: string, output: Set<string>) {
	if (Array.isArray(value)) {
		for (const entry of value) collect(entry, variable, output);
		return;
	}
	if (!value || typeof value !== 'object') return;
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === 'string' && (key === variable || (variable.endsWith('Id') && key === 'id') || (variable.endsWith('Slug') && key === 'slug'))) output.add(entry);
		else collect(entry, variable, output);
	}
}

export async function completeResourceVariable(
	registry: OperationRegistry,
	variable: string,
	prefix: string,
	argumentsByName: Record<string, string>,
	context: OperationInvocationContext,
) {
	const candidates = new Set(Object.values(argumentsByName));
	const operationId = sourceOperations[variable];
	const operation = operationId ? registry.operations.get(operationId) : undefined;
	if (operation) {
		try {
			enforceOperationAuthorization(operation.binding.descriptor, context.authInfo);
			const path = operation.binding.schema.path.parse(argumentsByName);
			const input = { path, query: operation.binding.schema.query.parse({}), body: operation.binding.schema.body.parse(undefined) };
			collect(await operation.handler(input as never, context), variable, candidates);
		} catch {
			// Completion is advisory and must not weaken operation validation or leak authorization failures.
		}
	}
	return [...candidates].filter((value) => value.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())).sort().slice(0, 100);
}

const promptSuggestions: Readonly<Record<string, readonly string[]>> = {
	operate: ['Inspect current control-plane status', 'Diagnose blockers and suggest the next safe action'],
	research: ['Research the open question using governed knowledge', 'Identify evidence gaps before proposing work'],
	'governance-review': ['Review the proposal against current evidence', 'Explain approval blockers and required revisions'],
	'workday-planning': ['Plan the next time-based workday', 'Explain allocation, borrowing, and starvation protections'],
	'project-agent-chat': ['Invoke the project agent for a governed discussion', 'Check the status of the current project-agent conversation'],
};

export function completePromptObjective(prompt: string, prefix: string) {
	return (promptSuggestions[prompt] ?? []).filter((value) => value.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase()));
}
