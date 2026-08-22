import type { AgentActivityType } from '@treeseed/sdk/types/agents';

export const ASSIGNMENT_AUTHORITY_PROBE_SCHEMA_VERSION = 'treeseed.assignment-authority-probe/v1' as const;

export type AssignmentAuthorityProbeCategory = 'model' | 'tool' | 'path' | 'branch' | 'governance';

export interface AssignmentAuthorityProbeInput {
	assignmentId: string;
	activityType: AgentActivityType;
	definitionRevision: string;
	contextQueryRefs: unknown[];
	instructionTemplateRefs: unknown[];
	permissions: Record<string, unknown>;
	tools: { allowed?: string[]; denied?: string[] };
	signals: Record<string, unknown>;
	outputContract: Record<string, unknown>;
	branchPolicy: Record<string, unknown>;
	upstreamMutationPolicy: string;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function strings(value: unknown) {
	return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function pathMatches(pattern: string, path: string) {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replaceAll('**', '\u0000').replaceAll('*', '[^/]*').replaceAll('\u0000', '.*');
	return new RegExp(`^${escaped}$`, 'u').test(path);
}

export function evaluateAssignmentAuthorityProbe(input: AssignmentAuthorityProbeInput) {
	const content = record(input.permissions.content);
	const decisionOperations = strings(record(content.decision).operations);
	const allowedTools = strings(input.tools.allowed);
	const repository = record(input.permissions.repository);
	const writePaths = strings(repository.writePaths);
	const forbiddenPaths = strings(repository.forbiddenPaths);
	const probePath = '.github/workflows/release.yml';
	const pathAllowed = writePaths.some((pattern) => pathMatches(pattern, probePath))
		&& !forbiddenPaths.some((pattern) => pathMatches(pattern, probePath));
	const denials = [
		{ category: 'model', request: 'decision:update', denied: !decisionOperations.includes('update'), code: 'profile_model_mutation_denied', basis: { operations: decisionOperations } },
		{ category: 'tool', request: 'treeseed.release', denied: !allowedTools.includes('treeseed.release'), code: 'profile_tool_denied', basis: { allowedTools } },
		{ category: 'path', request: probePath, denied: !pathAllowed, code: 'profile_path_denied', basis: { writePaths, forbiddenPaths } },
		{ category: 'branch', request: 'push:upstream', denied: input.upstreamMutationPolicy !== 'exact-approved-ref', code: 'profile_branch_operation_denied', basis: { branchPolicy: input.branchPolicy, upstreamMutationPolicy: input.upstreamMutationPolicy } },
		{ category: 'governance', request: 'decision.accept', denied: true, code: 'profile_governance_transition_denied', basis: { authority: 'human-control-plane-only' } },
	] satisfies Array<{ category: AssignmentAuthorityProbeCategory; request: string; denied: boolean; code: string; basis: Record<string, unknown> }>;
	return {
		schemaVersion: ASSIGNMENT_AUTHORITY_PROBE_SCHEMA_VERSION,
		assignmentId: input.assignmentId,
		activityType: input.activityType,
		selection: {
			requestedType: input.activityType,
			definitionRevision: input.definitionRevision,
			contextQueryRefs: input.contextQueryRefs,
			instructionTemplateRefs: input.instructionTemplateRefs,
			tools: input.tools,
			signals: input.signals,
			permissions: input.permissions,
			outputContract: input.outputContract,
		},
		denials,
		passed: Boolean(input.definitionRevision) && denials.every((probe) => probe.denied),
	};
}
