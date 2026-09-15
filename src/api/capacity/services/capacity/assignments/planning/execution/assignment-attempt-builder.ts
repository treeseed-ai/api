import { createHash } from 'node:crypto';
import {
	appliedWorkdaySchema,
	assignmentAttemptSchema,
	type AssignmentAttempt,
	type ExactEntityReference,
	type ExactGrant,
} from '@treeseed/sdk/agent-capacity';
import { assignmentSourceBranch } from '@treeseed/sdk/capacity-provider/sandbox';
import { CapacityGovernanceError } from '../../../../../database.ts';
import type { ProviderLeasePrincipal } from '../../../../accounts/lease-authority-service.ts';
import type { ProviderSynthesisExecutionProvider } from '../../../providers/provider-synthesis-context-service.ts';
import type { ReadyExecutionNode } from '../../../../build/ready-execution-node.ts';
import type { DurableCapacityWorkdayRun } from '../../../../../repositories/capacity/workdays/workday-run.ts';
import { workdayTreeDxWorkspaceId } from '../../../workdays/treedx/workday-treedx-workspace-service.ts';
import { compileAssignmentTimeBudget } from '../assignment-time-budget.ts';

const stable = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
	if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
		.sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
	return JSON.stringify(value);
};
const id = (prefix: string, values: unknown[]) => `${prefix}_${createHash('sha256').update(stable(values)).digest('base64url').slice(0, 32)}`;

function selectProvider(requiredCapabilities: string[], providers: ProviderSynthesisExecutionProvider[], lanePurpose: 'workday' | 'communication') {
	if (!requiredCapabilities.length) throw new CapacityGovernanceError(
		'capacity_execution_capabilities_required',
		'An executable node must declare its provider capability demand before admission.', 409,
	);
	for (const provider of [...providers].sort((left, right) => left.id.localeCompare(right.id))) {
		if (!['available', 'idle', 'normal'].includes(provider.status) || (provider.availableConcurrency ?? 1) < 1) continue;
		if (!requiredCapabilities.every((capability) => provider.capabilities.includes(capability))) continue;
		const lane = [...provider.lanes].filter((candidate) => candidate.purpose === lanePurpose
			&& requiredCapabilities.every((capability) => !candidate.capabilities.length || candidate.capabilities.includes(capability)))
			.sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))[0];
		const offer = [...provider.offers].filter((candidate) => {
			const capabilities = candidate.capabilities.map((capability) => capability.id);
			return requiredCapabilities.every((capability) => capabilities.includes(capability));
		}).sort((left, right) => left.capabilities.length - right.capabilities.length || left.offerId.localeCompare(right.offerId))[0];
		if (lane && offer) return { provider, lane, offer };
	}
	throw new CapacityGovernanceError('capacity_execution_provider_unavailable',
		'No advertised provider runtime satisfies the ready execution node.', 409, { requiredCapabilities });
}

function uniqueReferences(values: ExactEntityReference[]): ExactEntityReference[] {
	return [...new Map(values.map((reference) => [stable(reference), reference])).values()];
}

function communicationWritePaths(path: string | undefined) {
	const normalized = path?.replace(/\\/gu, '/').replace(/^\.\//u, '') ?? '';
	const marker = 'discussion-messages/';
	const markerIndex = normalized.indexOf(marker);
	const prefix = markerIndex >= 0 ? normalized.slice(0, markerIndex) : '';
	return [`${prefix}discussion-messages/**`, `${prefix}discussion-events/**`];
}

function grant(candidate: ReadyExecutionNode): ExactGrant {
	const requested = candidate.node.requestedPermissions!;
	const ceiling = candidate.effectiveProfile.permissionCeiling;
	const outside = (values: string[], allowed: string[]) => values.filter((value) => !allowed.includes(value));
	const denied = {
		read: outside(requested.content.read, ceiling.content.read),
		write: outside(requested.content.write, ceiling.content.write),
		tools: outside(requested.tools, ceiling.tools),
	};
	if (denied.read.length || denied.write.length || denied.tools.length) throw new CapacityGovernanceError(
		'assignment_permission_ceiling_exceeded', 'Ready node requests authority outside its effective activity profile.', 409, denied);
	if (candidate.node.workspace === 'git' && !requested.tools.includes('source.write')) throw new CapacityGovernanceError(
		'assignment_source_write_required', 'A Git workspace requires source.write authority.', 409);
	if (candidate.node.workspace !== 'git' && requested.tools.includes('source.write')) throw new CapacityGovernanceError(
		'assignment_dual_write_denied', 'source.write is valid only for a Git workspace.', 409);
	if (candidate.node.workspace !== 'treedx' && requested.content.write.length) throw new CapacityGovernanceError(
		'assignment_dual_write_denied', 'Content writes require a TreeDX workspace.', 409);
	const sourceRefs = candidate.contextRefs.filter((reference) => reference.store === 'git');
	const sourceRead = requested.tools.includes('source.read')
		? [...new Set([...sourceRefs.map((reference) => reference.repository), ...candidate.sourceRepositories]
			.filter((value): value is string => Boolean(value)))]
		: [];
	const contentRefs = candidate.contextRefs.filter((reference) => reference.store === 'treedx');
	const treeDxBase = contentRefs[0] ?? (candidate.node.sourceRef.store === 'treedx' ? candidate.node.sourceRef : null);
	const contentWrite = candidate.node.workspace === 'treedx' && treeDxBase?.repository && treeDxBase.commit
		? requested.content.write.flatMap((model) => candidate.node.kind === 'communication' && model === 'discussion'
			? communicationWritePaths(candidate.node.sourceRef.path).map((path, index) => ({ store: 'treedx' as const, model,
				id: `${candidate.node.id}:${model}:${index + 1}`, repository: treeDxBase.repository, commit: treeDxBase.commit, path }))
			: [model === candidate.node.sourceRef.model && candidate.node.sourceRef.path
				? candidate.node.sourceRef
				: ({ store: 'treedx' as const, model, id: `${candidate.node.id}:${model}`,
					repository: treeDxBase.repository, commit: treeDxBase.commit, path: `${model}s/${candidate.node.id}.mdx` })]) : [];
	return {
		contentRead: uniqueReferences([candidate.node.sourceRef, ...(candidate.node.authorityRefs ?? []), ...contentRefs]
			.filter((reference) => reference.store === 'treedx' && requested.content.read.includes(reference.model))),
		contentWrite,
		sourceRead,
		sourceWrite: candidate.node.workspace === 'git' && requested.tools.includes('source.write')
			? [...new Set(sourceRefs.map((reference) => reference.repository).filter((value): value is string => Boolean(value)))] : [],
		tools: [...requested.tools],
	};
}

function workspace(candidate: ReadyExecutionNode, assignmentId: string, exactGrant: ExactGrant) {
	if (candidate.node.workspace === 'read-only') return { mode: 'read-only' as const };
	const reference = candidate.node.sourceRef.store === candidate.node.workspace ? candidate.node.sourceRef
		: candidate.contextRefs.find((item) => item.store === candidate.node.workspace);
	if (!reference?.repository || !reference.commit) throw new CapacityGovernanceError(
		'assignment_workspace_reference_missing', `Node ${candidate.node.id} lacks its exact ${candidate.node.workspace} workspace reference.`, 409);
	const writablePaths = candidate.node.workspace === 'treedx'
		? exactGrant.contentWrite.map((item) => item.path).filter((path): path is string => Boolean(path))
		: [reference.path ?? '**'];
	if (!writablePaths.length) throw new CapacityGovernanceError('assignment_workspace_write_scope_missing',
		`Node ${candidate.node.id} has no exact writable paths for its ${candidate.node.workspace} workspace.`, 409);
	const priorCandidate = candidate.node.pairRole === 'actor' && candidate.node.nodeRevision > 1
		? candidate.predecessorResults.flatMap((result) => result.references)
			.find((item) => item.kind === 'git' && item.repository === reference.repository)
		: undefined;
	return candidate.node.workspace === 'git'
		? { mode: 'git' as const, repository: reference.repository, baseCommit: priorCandidate?.commit ?? reference.commit,
			branch: assignmentSourceBranch(assignmentId), writablePaths }
		: { mode: 'treedx' as const, workspaceId: workdayTreeDxWorkspaceId(assignmentId), repository: reference.repository,
			baseCommit: reference.commit, writablePaths };
}

export function buildAssignmentAttempt(input: {
	candidate: ReadyExecutionNode;
	run: DurableCapacityWorkdayRun;
	principal: ProviderLeasePrincipal;
	providerSessionId: string;
	providers: ProviderSynthesisExecutionProvider[];
	attempt: number;
	now: string;
}): { assignment: AssignmentAttempt; executionProviderId: string; laneId: string; lanePurpose: 'workday' | 'communication' } {
	const { candidate } = input;
	if (!candidate.node.estimate) throw new CapacityGovernanceError('execution_node_estimate_missing', 'Ready execution nodes require an estimate.', 409);
	const communication = candidate.node.kind === 'communication';
	const selected = selectProvider(candidate.node.requiredCapabilities ?? [], input.providers, communication ? 'communication' : 'workday');
	const assignmentId = id('assignment', [candidate.node.teamId,candidate.node.id,candidate.node.nodeRevision,input.attempt]);
	const appliedPlan = appliedWorkdaySchema.parse(input.run.parameters.appliedPlan);
	if (appliedPlan.executionMode !== input.run.executionMode) throw new CapacityGovernanceError(
		'assignment_workday_execution_mode_mismatch',
		'Assignment admission found contradictory execution mode authority.', 409,
		{ run: input.run.executionMode, appliedPlan: appliedPlan.executionMode },
	);
	const deadline = compileAssignmentTimeBudget({ now: input.now,
		requestedSeconds: candidate.node.estimate.expectedSeconds, configuredBudget: {} }).authorityExpiresAt;
	const exactGrant = grant(candidate);
	const contentRead = new Set(exactGrant.contentRead.map(stable));
	const contextRefs = candidate.contextRefs.filter((reference) => reference.store === 'treedx'
		? contentRead.has(stable(reference)) : reference.store === 'git' && Boolean(reference.repository && exactGrant.sourceRead.includes(reference.repository)));
	const assignment = assignmentAttemptSchema.parse({
		schemaVersion: 'treeseed.assignment-attempt/v1', id: assignmentId, idempotencyKey: assignmentId,
		teamId: candidate.node.teamId, projectId: candidate.node.projectId, workdayId: input.run.id,
		nodeId: candidate.node.id, ...(candidate.node.workItemId ? { workItemId: candidate.node.workItemId } : {}),
		nodeRevision: candidate.node.nodeRevision, graphRevision: candidate.graphRevision,
		sourceRef: candidate.node.sourceRef, authorityRefs: candidate.node.authorityRefs,
		effectiveProfile: candidate.effectiveProfile,
		requiredCapabilities: candidate.node.requiredCapabilities ?? [],
		grant: exactGrant,
		provider: { providerId: input.principal.capacityProviderId, offerId: selected.offer.offerId,
			offerRevision: 1, runtimeBuild: selected.provider.runtimeBuild },
		contextRefs,
		predecessorResultIds: candidate.predecessorResults.map((result) => result.id),
		acceptanceCriteria: candidate.node.acceptanceCriteria,
		workspace: workspace(candidate, assignmentId, exactGrant),
		estimate: candidate.node.estimate,
		limits: { maximumSeconds: candidate.node.estimate.maximumSeconds, maximumContextBytes: 4_000_000,
			maximumContextTokens: 200_000, maximumContextItems: 1_000 },
		deadline, leaseId: id('lease', [assignmentId]), reservationId: id('reservation', [assignmentId]),
		attempt: input.attempt, status: 'created', createdAt: input.now,
	});
	return { assignment, executionProviderId: selected.provider.id, laneId: selected.lane.id,
		lanePurpose: communication ? 'communication' : 'workday' };
}
