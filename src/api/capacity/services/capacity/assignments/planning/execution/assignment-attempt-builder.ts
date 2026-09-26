import { createHash } from 'node:crypto';
import {
	appliedWorkdaySchema,
	assignmentAttemptSchema,
	calculateAssignmentAllocation,
	remainingCapabilitySeconds,
	workdayPlanningEndsAt,
	type AssignmentAttempt,
	type ExactEntityReference,
	type ExactGrant,
	type CapabilityAccountingLimits,
} from '@treeseed/sdk/agent-capacity';
import { assignmentSourceBranch, simulationSourceBranch } from '@treeseed/sdk/capacity-provider/sandbox';
import { CapacityGovernanceError } from '../../../../../database.ts';
import type { ProviderLeasePrincipal } from '../../../../accounts/lease-authority-service.ts';
import type { ProviderSynthesisExecutionProvider } from '../../../providers/provider-synthesis-context-service.ts';
import { isProposalGovernanceReview, type ReadyExecutionNode } from '../../../../build/ready-execution-node.ts';
import type { DurableCapacityWorkdayRun } from '../../../../../repositories/capacity/workdays/workday-run.ts';
import { workdayTreeDxWorkspaceId } from '../../../workdays/treedx/workday-treedx-workspace-service.ts';
import { assignmentPreparationSeconds, compileAssignmentTimeBudget } from '../assignment-time-budget.ts';
import type { LivingAllocationInputs } from '../../admission/living-allocation-inputs.ts';

const stable = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
	if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
		.sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
	return JSON.stringify(value);
};
const id = (prefix: string, values: unknown[]) => `${prefix}_${createHash('sha256').update(stable(values)).digest('base64url').slice(0, 32)}`;
const knowledgeId = (nodeId: string) => `knowledge-${createHash('sha256').update(nodeId).digest('hex').slice(0, 24)}`;

function eligibleProviders(requiredCapabilities: string[], providers: ProviderSynthesisExecutionProvider[], lanePurpose: 'workday' | 'communication') {
	if (!requiredCapabilities.length) throw new CapacityGovernanceError(
		'capacity_execution_capabilities_required',
		'An executable node must declare its provider capability demand before admission.', 409,
	);
	const eligible: Array<{ provider: ProviderSynthesisExecutionProvider; lane: ProviderSynthesisExecutionProvider['lanes'][number];
		offer: ProviderSynthesisExecutionProvider['offers'][number] }> = [];
	for (const provider of [...providers].sort((left, right) => left.id.localeCompare(right.id))) {
		if (!['available', 'idle', 'normal'].includes(provider.status) || (provider.availableConcurrency ?? 1) < 1) continue;
		if (!requiredCapabilities.every((capability) => provider.capabilities.includes(capability))) continue;
		if (!provider.accountingLimits || !provider.accountingObservation
			|| !provider.accountingLimits.capabilityLimits[requiredCapabilities[0]!]) continue;
		const lane = [...provider.lanes].filter((candidate) => candidate.purpose === lanePurpose
			&& requiredCapabilities.every((capability) => !candidate.capabilities.length || candidate.capabilities.includes(capability)))
			.sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))[0];
		const offer = [...provider.offers].filter((candidate) => {
			const capabilities = candidate.capabilities.map((capability) => capability.id);
			return requiredCapabilities.every((capability) => capabilities.includes(capability));
		}).sort((left, right) => left.capabilities.length - right.capabilities.length || left.offerId.localeCompare(right.offerId))[0];
		if (lane && offer) eligible.push({ provider, lane, offer });
	}
	if (!eligible.length) throw new CapacityGovernanceError('capacity_execution_provider_unavailable',
		'No advertised provider runtime satisfies the ready execution node.', 409, { requiredCapabilities });
	return eligible;
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

function communicationDiscussionReference(candidate: ReadyExecutionNode): ExactEntityReference[] {
	if (candidate.node.kind !== 'communication') return [];
	const source = candidate.node.sourceRef;
	if (source.store !== 'treedx' || !source.repository || !source.commit || !source.path) return [];
	const normalized = source.path.replace(/\\/gu, '/').replace(/^\.\//u, '');
	const match = /^(.*)discussion-messages\/([^/]+)\/[^/]+$/u.exec(normalized);
	if (!match) return [];
	return [{ ...source, id: `${source.id}:discussion`, path: `${match[1]}discussions/${match[2]}.mdx` }];
}

function grant(candidate: ReadyExecutionNode, assignmentId: string): ExactGrant {
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
	const treeDxBase = candidate.node.sourceRef.store === 'treedx' ? candidate.node.sourceRef : contentRefs[0];
	const bookRef = contentRefs.find((reference) => reference.model === 'book'
		&& reference.repository === treeDxBase?.repository && reference.commit && reference.path);
	if (candidate.node.kind === 'acting' && candidate.node.workspace === 'treedx'
		&& requested.content.write.includes('knowledge') && !bookRef) throw new CapacityGovernanceError(
		'assignment_knowledge_book_reference_missing',
		`Node ${candidate.node.id} needs an exact Book reference before it can write a Knowledge page.`, 409);
	const requestedOutput = candidate.node.output;
	const outputId = (model: string) => requestedOutput?.model === model ? requestedOutput.id : undefined;
	const contentWrite = candidate.node.workspace === 'treedx' && treeDxBase?.repository && treeDxBase.commit
		? requested.content.write.flatMap((model) => candidate.node.kind === 'communication' && model === 'discussion'
			? communicationWritePaths(candidate.node.sourceRef.path).map((path, index) => ({ store: 'treedx' as const, model,
				id: `${candidate.node.id}:${model}:${index + 1}`, repository: treeDxBase.repository, commit: treeDxBase.commit, path }))
			: model === 'knowledge'
				? bookRef ? [{ store: 'treedx' as const, model, id: outputId(model) ?? knowledgeId(candidate.node.id),
					repository: treeDxBase.repository, commit: treeDxBase.commit,
					path: `knowledge/${bookRef.id}/${outputId(model) ?? knowledgeId(candidate.node.id)}.md` }]
					: []
				: [model === candidate.node.sourceRef.model && candidate.node.sourceRef.path
				? candidate.node.sourceRef
				: ({ store: 'treedx' as const, model, id: outputId(model) ?? `${assignmentId}:${model}`,
					repository: treeDxBase.repository, commit: treeDxBase.commit,
					path: `${model}s/${outputId(model) ?? assignmentId}.mdx` })]) : [];
	return {
		contentRead: uniqueReferences([candidate.node.sourceRef, ...communicationDiscussionReference(candidate),
			...(candidate.node.authorityRefs ?? []), ...contentRefs]
			.filter((reference) => reference.store === 'treedx' && requested.content.read.includes(reference.model))),
		contentWrite,
		sourceRead,
		sourceWrite: candidate.node.workspace === 'git' && requested.tools.includes('source.write')
			? [...new Set(sourceRefs.map((reference) => reference.repository).filter((value): value is string => Boolean(value)))] : [],
		tools: [...requested.tools],
	};
}

function workspace(candidate: ReadyExecutionNode, assignmentId: string, exactGrant: ExactGrant, run: DurableCapacityWorkdayRun) {
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
	const predecessorCommits = candidate.node.workspace === 'git'
		? [...new Set(candidate.predecessorResults.flatMap((result) => result.references)
			.filter((item) => item.kind === 'git' && item.repository === reference.repository)
			.map((item) => item.commit))]
		: [];
	const lineageBase = candidate.node.workspace === 'git' ? candidate.lineageSourceCommit : undefined;
	// A revision may have one current upstream commit plus the Actor's own older
	// candidate. Begin on the reviewed upstream and retain the older result as
	// context for the Actor to reconcile; unrelated multi-branch fan-in still
	// requires an explicit integration assignment.
	const revisionBase = candidate.node.workspace === 'git' && candidate.node.pairRole === 'actor'
		? candidate.directPredecessorSourceCommit : undefined;
	if (lineageBase && !predecessorCommits.includes(lineageBase)) throw new CapacityGovernanceError(
		'assignment_source_lineage_mismatch', 'The linear predecessor commit is absent from exact predecessor results.', 409);
	if (revisionBase && !predecessorCommits.includes(revisionBase)) throw new CapacityGovernanceError(
		'assignment_source_lineage_mismatch', 'The direct predecessor commit is absent from exact predecessor results.', 409);
	const explicitIntegration = predecessorCommits.length > 1
		&& candidate.node.kind === 'acting' && candidate.node.pairRole === 'actor'
		&& candidate.node.agentClass === 'releaser' && exactGrant.tools.includes('release');
	if (predecessorCommits.length > 1 && !explicitIntegration && !lineageBase && !revisionBase) throw new CapacityGovernanceError(
		'assignment_git_integration_required',
		`Node ${candidate.node.id} has multiple Git predecessor commits; an explicit integration assignment by a Releaser must establish one base.`,
		409, { nodeId: candidate.node.id, predecessorCommits,
			predecessorResults: candidate.predecessorResults.flatMap((result) => result.references
				.filter((item) => item.kind === 'git' && item.repository === reference.repository)
				.map((item) => ({ resultId: result.id, commit: item.commit }))) });
	return candidate.node.workspace === 'git'
		? { mode: 'git' as const, repository: reference.repository,
			baseCommit: explicitIntegration ? reference.commit : lineageBase ?? revisionBase ?? predecessorCommits[0] ?? reference.commit,
			branch: run.executionMode === 'simulation'
				? simulationSourceBranch(String(run.parameters.acceptanceCampaignId || 'local'), run.id, assignmentId)
				: assignmentSourceBranch(assignmentId), writablePaths }
		: { mode: 'treedx' as const, workspaceId: workdayTreeDxWorkspaceId(assignmentId), repository: reference.repository,
			baseCommit: reference.commit, writablePaths };
}

export function buildAssignmentAttempt(input: {
	candidate: ReadyExecutionNode;
	run: DurableCapacityWorkdayRun;
	principal: ProviderLeasePrincipal;
	providerSessionId: string;
	providers: ProviderSynthesisExecutionProvider[];
	allocationInputs: LivingAllocationInputs;
	attempt: number;
	now: string;
}): { assignment: AssignmentAttempt; allocation: ReturnType<typeof calculateAssignmentAllocation> & {
	opportunity: LivingAllocationInputs[string]['opportunity'] }; accountingLimits: CapabilityAccountingLimits;
	executionProviderId: string; laneId: string; lanePurpose: 'workday' | 'communication'; providerConcurrencyLimit: number } {
	const { candidate } = input;
	if (!candidate.node.estimate) throw new CapacityGovernanceError('execution_node_estimate_missing', 'Ready execution nodes require an estimate.', 409);
	const communication = candidate.node.kind === 'communication';
	const eligible = eligibleProviders(candidate.node.requiredCapabilities ?? [], input.providers, communication ? 'communication' : 'workday');
	const assignmentId = id('assignment', [candidate.node.teamId,candidate.node.id,candidate.node.nodeRevision,
		candidate.node.sourceRef.digest,candidate.node.sourceRef.commit,input.attempt]);
	const appliedPlan = appliedWorkdaySchema.parse(input.run.parameters.appliedPlan);
	if (appliedPlan.executionMode !== input.run.executionMode) throw new CapacityGovernanceError(
		'assignment_workday_execution_mode_mismatch',
		'Assignment admission found contradictory execution mode authority.', 409,
		{ run: input.run.executionMode, appliedPlan: appliedPlan.executionMode },
	);
	const planningTurn = ['planning', 'estimating'].includes(candidate.node.kind);
	const planningPhase = planningTurn || isProposalGovernanceReview(candidate.node);
	const windowEnd = planningPhase ? workdayPlanningEndsAt(appliedPlan) : appliedPlan.endsAt;
	const preparationSeconds = assignmentPreparationSeconds(undefined);
	const utcDayEnd = Date.parse(`${input.now.slice(0, 10)}T00:00:00.000Z`) + 86_400_000;
	const availableSeconds = candidate.node.kind === 'reporting' && appliedPlan.state === 'closing'
		? candidate.node.estimate.maximumSeconds : Math.max(0, (Date.parse(windowEnd) - Date.parse(input.now)) / 1000 - preparationSeconds);
	const capability = candidate.node.requiredCapabilities![0]!;
	const considered = eligible.flatMap((selected) => {
		const allocationInputs = input.allocationInputs[selected.provider.id];
		if (!allocationInputs) return [];
		const limits = selected.provider.accountingLimits!;
		const observation = selected.provider.accountingObservation!;
		const capabilityLimits = limits.capabilityLimits[capability]!;
		const allocationEstimate = candidate.node.estimate;
		const remaining = (dailyLimitSeconds: number, value: typeof observation.modelUsage | undefined) => value
			? remainingCapabilitySeconds({ now: input.now, maximumObservationAgeSeconds: 90, dailyLimitSeconds,
				observation: value, ledgerActiveSeconds: 0, ledgerReservedSeconds: 0 }).availableSeconds : 0;
		// Planning and estimating turns have equal policy-owned ceilings. Historical task
		// calibration does not shrink them, but constrained supply may shorten a turn as long
		// as the node's actual viable minimum still fits.
		const allocation = calculateAssignmentAllocation({ estimate: allocationEstimate,
			measurements: planningTurn ? [] : allocationInputs.measurements,
			constraints: [{ id: 'execution-window', remainingSeconds: availableSeconds },
				{ id: 'utc-day-window', remainingSeconds: Math.max(0, (utcDayEnd - Date.parse(input.now)) / 1000 - preparationSeconds) },
				{ id: 'model-day', remainingSeconds: remaining(limits.dailyActiveSecondsLimit, observation.modelUsage) },
				{ id: 'capability-day', remainingSeconds: remaining(capabilityLimits.dailyActiveSecondsLimit, observation.capabilityUsage[capability]) }, ...allocationInputs.constraints],
			providerMinimumSeconds: capabilityLimits.minimumAssignmentSeconds,
			providerMaximumSeconds: capabilityLimits.maximumAssignmentSeconds,
			...(planningTurn ? { planningTurnMaximumSeconds: appliedPlan.policySnapshot.planningTurnMaximumSeconds } : {}) });
		return [{ selected, allocation, allocationInputs }];
	});
	const admitted = considered.find(({ allocation }) => allocation.admitted);
	if (!admitted) throw new CapacityGovernanceError('capacity_assignment_allocation_deferred',
		'The remaining execution window cannot fit the viable task minimum.', 409,
		{ nodeId: candidate.node.id, providers: considered.map(({ selected, allocation }) => ({ providerId: selected.provider.id, allocation })) });
	const { selected, allocation, allocationInputs } = admitted;
	const limits = selected.provider.accountingLimits!;
	const deadline = compileAssignmentTimeBudget({ now: input.now,
		requestedSeconds: allocation.allocatedSeconds,
		configuredBudget: candidate.node.kind === 'reporting' && appliedPlan.state === 'closing' ? {} : { deadline: windowEnd } }).authorityExpiresAt;
	const exactGrant = grant(candidate, assignmentId);
	if (candidate.node.kind === 'reporting') exactGrant.contentRead.push(candidate.node.sourceRef);
	const contentRead = new Set(exactGrant.contentRead.map(stable));
	const contextRefs = candidate.contextRefs.filter((reference) => reference.store === 'treedx'
		? contentRead.has(stable(reference)) : reference.store === 'git' && Boolean(reference.repository && exactGrant.sourceRead.includes(reference.repository)));
	if (candidate.node.kind === 'reporting') contextRefs.push(candidate.node.sourceRef);
	const assignment = assignmentAttemptSchema.parse({
		schemaVersion: 'treeseed.assignment-attempt/v1', id: assignmentId, idempotencyKey: assignmentId,
		teamId: candidate.node.teamId, projectId: candidate.node.projectId, workdayId: input.run.id,
		nodeId: candidate.node.id, agentClass: candidate.node.agentClass,
		...(candidate.node.workItemId ? { workItemId: candidate.node.workItemId } : {}),
		nodeRevision: candidate.node.nodeRevision, graphRevision: candidate.graphRevision,
		sourceRef: candidate.node.sourceRef, authorityRefs: candidate.node.authorityRefs,
		effectiveProfile: candidate.effectiveProfile,
		requiredCapabilities: candidate.node.requiredCapabilities ?? [],
		grant: exactGrant,
		provider: { providerId: input.principal.capacityProviderId, offerId: selected.offer.offerId,
			executionProviderId: selected.provider.id, modelConfigurationId: selected.provider.accountingLimits!.modelConfigurationId,
			executionCapabilityId: candidate.node.requiredCapabilities![0],
			offerRevision: 1, runtimeBuild: selected.provider.runtimeBuild },
		contextRefs,
		predecessorResultIds: candidate.predecessorResults.map((result) => result.id),
		acceptanceCriteria: candidate.node.acceptanceCriteria,
		workspace: workspace(candidate, assignmentId, exactGrant, input.run),
		estimate: candidate.node.estimate,
		limits: { maximumSeconds: allocation.allocatedSeconds, maximumContextBytes: 4_000_000,
			maximumContextTokens: 200_000, maximumContextItems: 1_000 },
		deadline, leaseId: id('lease', [assignmentId]), reservationId: id('reservation', [assignmentId]),
		attempt: input.attempt, status: 'created', createdAt: input.now,
	});
	return { assignment, allocation: { ...allocation, opportunity: allocationInputs.opportunity }, accountingLimits: limits, executionProviderId: selected.provider.id, laneId: selected.lane.id,
		lanePurpose: communication ? 'communication' : 'workday',
		providerConcurrencyLimit: Math.max(1, Math.min(selected.provider.availableConcurrency ?? 1,
			selected.provider.maxConcurrentRunners, selected.lane.maxConcurrentRunners)) };
}
