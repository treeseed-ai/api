import { evaluateAssignmentAuthorityProbe,type AgentActivityType } from '@treeseed/sdk/agent-capacity';
import { CapacityGovernanceError } from '../../../../database.ts';

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function array(value: unknown) { return Array.isArray(value) ? value : []; }
function text(...values: unknown[]) { return values.find((value) => typeof value === 'string' && value.trim()) as string | undefined ?? ''; }
const ACTIVITY_TYPES=new Set<AgentActivityType>(['planning','estimating','acting','reviewing','reporting','chat']);

export function assignmentAuthorityProbe(assignment: Record<string, unknown>) {
	const decisionInput = record(assignment.decisionInput);
	const input = record(decisionInput.input);
	const metadata = record(assignment.metadata);
	const authority = record(input.authoritySnapshot);
	const activityCandidate = text(metadata.activityType,assignment.mode);
	if (!ACTIVITY_TYPES.has(activityCandidate as AgentActivityType)) {
		throw new CapacityGovernanceError('assignment_activity_profile_invalid','The assignment does not freeze a recognized activity profile.',409);
	}
	const agentDefinition = record(input.agentDefinition);
	const revisions = record(metadata.configurationRevisions);
	const definitionRevision = text(agentDefinition.immutableRef,revisions.agentDefinitionRevision);
	if (!definitionRevision) throw new CapacityGovernanceError('assignment_definition_revision_missing','The assignment does not freeze an exact agent definition revision.',409);
	return evaluateAssignmentAuthorityProbe({
		assignmentId:text(assignment.id),activityType:activityCandidate as AgentActivityType,definitionRevision,
		contextQueryRefs:array(input.contextQueryRefs),instructionTemplateRefs:array(input.instructionTemplateRefs),
		permissions:record(authority.permissions ?? input.permissions),tools:record(authority.tools ?? input.toolPolicy),
		signals:record(input.signalPolicy),outputContract:record(input.outputContract),branchPolicy:record(authority.branchPolicy ?? input.contentBranchPolicy),
		upstreamMutationPolicy:text(record(assignment.workspaceContext).upstreamMutationPolicy,metadata.upstreamMutationPolicy,'denied'),
	});
}
