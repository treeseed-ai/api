import type { CapacitySupplyPolicy } from "@treeseed/sdk/agent-capacity";
import { capacitySupplyCandidateStatus, selectCapacitySupply } from '../../../../policy/supply-selection.ts';
import { evaluateMinimumAssignmentDuration } from '../../../../policy/timing/assignment-duration.ts';
import type { CapacityGovernanceDatabase } from "../../../../database.ts";
import { CapacityGovernanceError } from "../../../../database.ts";
import type { DurableProviderAssignment } from "../../../../repositories/capacity/assignments/assignment.ts";
import { CapacityWorkdayDemandRepository } from "../../../../repositories/capacity/workdays/workday-demand.ts";
import { CapacityWorkdayParticipationRepository } from "../../../../repositories/capacity/workdays/workday-participation.ts";
import { CapacityWorkdayRunRepository,type DurableCapacityWorkdayRun } from "../../../../repositories/capacity/workdays/workday-run.ts";
import type { ProviderLeasePrincipal } from "../../../accounts/lease-authority-service.ts";
import type { ProviderSynthesisExecutionProvider } from "../../providers/provider-synthesis-context-service.ts";
import { evaluateDurableWorkdayContinuation } from "../../workdays/lifecycle/workday-continuation-service.ts";
import type { ConfiguredWorkspaceInput } from "../../workdays/treedx/workday-treedx-workspace-service.ts";
import { workdayTreeDxWorkspaceId } from "../../workdays/treedx/workday-treedx-workspace-service.ts";
import { admitSynthesizedProviderAssignment } from "../admission/assignment-admission-service.ts";
import { teamSupplyPolicy } from "../../../../domain/supply-policy.ts";
import { persistIssuedWorkspaceAuthority } from './workspace-authority-persistence.ts';
import { compileAssignmentTimeBudget } from './assignment-time-budget.ts';
import { selectAssignmentLane } from './assignment-lane-selection.ts';
import { assertBatteryAdmission } from './admission/battery-admission.ts';
import { compilePlanningAllowedOutputs,compilePlanningAssignmentInput } from './planning-assignment-contract.ts';
import { assignmentBootstrapReadPaths,assignmentContextQueryReadPaths,assignmentDiscussionMessageReadPaths,assignmentInstructionTemplateReadPaths,assignmentOperationalContentPaths,assignmentTreeDxProxyHandle,mergeAssignmentPathScopes } from './assignment-operational-paths.ts';
export { compilePlanningAllowedOutputs,compilePlanningAssignmentInput } from './planning-assignment-contract.ts';
export { resolveAssignmentContentBaseRef } from './content-base-ref.ts';
import { resolveAssignmentContentBaseRef } from './content-base-ref.ts';
import { assignmentConfigurationAttribution } from './assignment-configuration-attribution.ts';
import { negotiateAssignmentCapabilityOffers, persistCapabilityNegotiation } from './support/capability-offer-negotiation.ts';
import { resolveAssignmentContentPathScope } from './assignment-content-path-scope.ts';
import { bindOperationHandoffAssignment } from '../handoffs/operation-handoff-lifecycle-service.ts';
import { assignmentRecord as record, assignmentText as text,
	deterministicAssignmentId as assignmentId, type AssignmentJsonRecord as JsonRecord } from './support/assignment-function-support.ts';
import { recordAssignmentDenial } from './support/assignment-denial.ts';
export { assignmentConfigurationAttribution } from './assignment-configuration-attribution.ts';
export { resolveAssignmentContentPathScope } from './assignment-content-path-scope.ts';
interface AssignmentFunctionStore extends CapacityGovernanceDatabase {
  getProject(projectId: string): Promise<JsonRecord | null>;
  getTeam(teamId: string): Promise<JsonRecord | null>;
  listHubRepositories(projectId: string): Promise<JsonRecord[]>;
  getProjectArchitecture(projectId: string): Promise<JsonRecord | null>;
  getProviderAssignment(
    teamId: string,
    assignmentId: string,
  ): Promise<DurableProviderAssignment | null>;
  createCapacityWorkdayTreeDxWorkspace(
    project: { id: string },
    run: DurableCapacityWorkdayRun,
    input: ConfiguredWorkspaceInput,
  ): Promise<JsonRecord>;
}
async function assignmentInput(
	store: AssignmentFunctionStore,
  demand: Awaited<ReturnType<CapacityWorkdayDemandRepository["claimNext"]>>,
  principal: ProviderLeasePrincipal,
  sessionId: string,
  executionProviders: ProviderSynthesisExecutionProvider[],
  policy: CapacitySupplyPolicy,
  now: string,
) {
  if (!demand?.claimToken)
    throw new CapacityGovernanceError(
      "capacity_workday_demand_claim_missing",
      "Claimed demand has no claim token.",
      500,
    );
	const id = demand.assignmentId ?? assignmentId(demand.id, Math.max(0, Number(demand.metadata.failoverCount ?? 0)));
  const payload = record(demand.payload);
  const intent = record(payload.intent);
  const repositoryId = text(payload.repositoryId);
  if (!repositoryId)
    throw new CapacityGovernanceError(
      "capacity_workday_demand_repository_missing",
      "Demand omitted its TreeDX repository.",
      500,
      { demandId: demand.id },
    );
  const contentRoot = text(payload.contentRoot);
  if (!contentRoot)
    throw new CapacityGovernanceError(
      "capacity_workday_demand_content_path_missing",
      "Demand omitted its configured project content path.",
      500,
      { demandId: demand.id },
    );
  const contentBaseRef = resolveAssignmentContentBaseRef(payload);
  const project = await store.getProject(demand.projectId);
  if (!project) throw new CapacityGovernanceError(
    "capacity_workday_demand_project_missing",
    "Demand project is unavailable while composing assignment identity.",
    409,
    { demandId: demand.id, projectId: demand.projectId },
  );
  const planning = demand.mode === "planning";
	const contentPrefix = contentRoot === '.' ? '' : `${contentRoot.replace(/\/+$/u, '')}/`;
	const projectSlug = text(project.slug) || demand.projectId;
	const coreObjectivePath = `${contentPrefix}objectives/core`;
	const coreObjectiveCandidates = [`${coreObjectivePath}.mdx`, `${coreObjectivePath}.md`];
	const projectReadmePath = `${contentPrefix}README.md`;
	const identityAnchorPaths = [...coreObjectiveCandidates, projectReadmePath];
	// The admitted demand freezes the selected profile; intent cannot decide authority.
	const activityType=demand.activityType;
	const executionMode = demand.metadata.executionMode === 'production' ? 'production' as const : 'simulation' as const;
  const requiredCapabilities = Array.isArray(demand.metadata.requiredCapabilities)
    ? demand.metadata.requiredCapabilities.map(String).filter(Boolean)
    : [];
	const { capabilityDemand, offerNegotiations } = negotiateAssignmentCapabilityOffers(demand.metadata.capabilityDemand, executionProviders);
	const selectedSupply = record(demand.metadata.supplySelection);
	const selectedExecutionProviderId = text(selectedSupply.executionProviderId);
  const selection = selectCapacitySupply({
    policy,
    requiredCapabilities,
	assignmentWindow: { startedAt: now, durationSeconds: demand.requestedSeconds },
	    candidates: executionProviders.filter((provider) => (!selectedExecutionProviderId || provider.id === selectedExecutionProviderId)
		&& (!capabilityDemand || provider.offers.some((offer) => offerNegotiations.has(`${provider.id}:${offer.offerId}`)))).map((provider) => ({
	      capacityProviderId: principal.capacityProviderId,
	      membershipId: principal.membershipId,
	      providerSessionId: sessionId,
	      grantId: text(selectedSupply.grantId),
      executionProviderId: provider.id,
      status: capacitySupplyCandidateStatus(provider.status),
      capabilities: provider.capabilities,
      reliability: provider.reliability ?? 1,
      pressure: provider.pressure ?? 'normal',
      availableConcurrency: provider.availableConcurrency ?? 1,
      estimatedCost: provider.estimatedCost ?? null,
	  minimumAssignmentDuration: provider.minimumAssignmentDuration,
    })),
  });
	const executionProvider = executionProviders.find((provider) => provider.id === selection.selected?.executionProviderId);
  if (!executionProvider) {
    throw new CapacityGovernanceError(
      "capacity_execution_provider_unavailable",
      "No advertised execution provider satisfies this demand.",
      409,
	  { demandId: demand.id, requiredCapabilities, rejected: selection.rejected.map((entry) => ({ executionProviderId: entry.candidate.executionProviderId, reasons: entry.reasons })) },
    );
  }
	const executionKind = demand.metadata.executionKind === 'conversation' ? 'conversation' : demand.metadata.executionKind === 'recovery' ? 'recovery' : demand.metadata.executionKind === 'simulation' ? 'simulation' : 'workday';
	const triggerKind = demand.metadata.triggerKind === 'discussion' ? 'discussion' : demand.metadata.triggerKind === 'agent-handoff' ? 'agent-handoff' : demand.metadata.triggerKind === 'manual' ? 'manual' : 'scheduled';
	const requestedLane = demand.metadata.lanePurpose === 'platform' ? 'platform' as const
		: executionKind === 'conversation' ? 'communication' as const : 'workday' as const;
	const compatibleLanes = executionProvider.lanes.filter((candidate) => requiredCapabilities.every((capability) => candidate.capabilities.length === 0 || candidate.capabilities.includes(capability)));
	const laneLoads = new Map<string, number>();
	for (const candidate of compatibleLanes) {
		const count = await store.first(`SELECT COUNT(*) AS count FROM capacity_provider_assignments WHERE capacity_provider_id = ? AND lane_id = ? AND status IN ('pending','leased','running')`, [principal.capacityProviderId, candidate.id]);
		laneLoads.set(candidate.id, Number(count?.count ?? 0));
	}
	const selectedOffer = capabilityDemand ? executionProvider.offers.find((offer) => offerNegotiations.has(`${executionProvider.id}:${offer.offerId}`)) : null;
	const negotiationReceipt = selectedOffer ? offerNegotiations.get(`${executionProvider.id}:${selectedOffer.offerId}`) : null;
	const { lane, communicationOverflow } = selectAssignmentLane(executionKind, compatibleLanes, laneLoads, requestedLane);
	if (!lane) throw new CapacityGovernanceError('capacity_provider_lane_unavailable', `No ${requestedLane} lane satisfies this demand.`, 409, { executionProviderId: executionProvider.id, lanePurpose: requestedLane });
	await assertBatteryAdmission({ store, teamId: demand.teamId, providerId: principal.capacityProviderId,
		executionProvider, lanes: compatibleLanes, laneLoads, requestedLane });
	const effectiveLanePurpose = lane.purpose;
	const evaluatedMinimumDuration = executionProvider.minimumAssignmentDuration
		? evaluateMinimumAssignmentDuration(executionProvider.minimumAssignmentDuration, now)
		: null;
	const minimumAssignmentDuration = evaluatedMinimumDuration ? {
		requirement: evaluatedMinimumDuration.requirement,
		minimumWindowSeconds: evaluatedMinimumDuration.minimumWindowSeconds,
		startedAt: null,
		minimumDeadlineAt: null,
	} : null;
  const taskReadPaths = resolveAssignmentContentPathScope(payload, 'read', contentRoot, ["**"]);
  const sourceMessageRefs = [...new Set([
	text(payload.discussionMessageId), text(payload.subjectPath),
	...(Array.isArray(payload.operationHandoffSourceMessageRefs) ? payload.operationHandoffSourceMessageRefs.map(String) : []),
  ].filter(Boolean))];
  const discussionMessageReadPaths = executionKind === 'conversation' ? assignmentDiscussionMessageReadPaths(sourceMessageRefs) : [];
  const chatWritePaths=['discussion-messages','discussion-events','notes','questions','proposals'].flatMap((collection)=>[`${contentRoot}/${collection}`,`${contentRoot}/${collection}/**`]);
  const taskWritePaths = activityType==='chat'
	? resolveAssignmentContentPathScope(payload,'write',contentRoot,chatWritePaths)
	: planning
    ? resolveAssignmentContentPathScope(payload, 'write', contentRoot, [contentRoot, `${contentRoot}/**`])
    : ["**"];
  const operationalPaths = assignmentOperationalContentPaths(contentRoot, id);
  const bootstrapReadPaths = assignmentBootstrapReadPaths(contentRoot, payload.agentContentPath, intent.subjectPath);
  const contextQueryReadPaths = assignmentContextQueryReadPaths(contentRoot, payload.contextQueryRefs, payload.contextQueryChecks);
  const instructionTemplateReadPaths = assignmentInstructionTemplateReadPaths(contentRoot, payload.instructionTemplateRefs);
  const allowedReadPaths = mergeAssignmentPathScopes(taskReadPaths, discussionMessageReadPaths, bootstrapReadPaths, identityAnchorPaths, contextQueryReadPaths, instructionTemplateReadPaths, operationalPaths);
  const allowedWritePaths = mergeAssignmentPathScopes(taskWritePaths, operationalPaths);
  const workspaceAllowedPaths = mergeAssignmentPathScopes(allowedReadPaths, allowedWritePaths);
  const workspaceId = workdayTreeDxWorkspaceId(id);
  const configuredBudget = record(record(payload.capacityEnvelope).budget);
  const timing = compileAssignmentTimeBudget({ now, requestedSeconds: demand.requestedSeconds, configuredBudget });
  const { closeoutSeconds, preparationSeconds, authorityExpiresAt } = timing;
  const treedxProxyHandle = assignmentTreeDxProxyHandle({ assignmentId: id, teamId: demand.teamId, projectId: demand.projectId,
	executionMode, repositoryId, workspaceId, allowedPaths: workspaceAllowedPaths, allowedReadPaths, allowedWritePaths,
	expiresAt: authorityExpiresAt, demandId: demand.id, workdayRunId: demand.workdayRunId });
  const capacityBudget = timing.capacityBudget;
  const capacityEnvelope = {
    ...record(payload.capacityEnvelope),
    workDayId: demand.workdayId,
    projectId: demand.projectId,
    capacityProviderId: principal.capacityProviderId,
		executionProviderId: executionProvider.id,
		laneId: lane.id,
		lanePurpose: effectiveLanePurpose,
		communicationOverflow,
		executionKind,
    mode: demand.mode,
	executionMode,
		requestedSeconds: demand.requestedSeconds,
		reservedSeconds: demand.requestedSeconds,
		activeSeconds: 0,
		elapsedSeconds: 0,
		releasedSeconds: 0,
		overrunSeconds: 0,
    budget: capacityBudget,
    metadata: {
      ...record(record(payload.capacityEnvelope).metadata),
      source: "workday-demand",
      demandId: demand.id,
    },
  };
  const planningSubjectModel = text(intent.subjectModel);
  const planningSubjectId = text(intent.subjectId);
  const decisionInput =
    demand.mode === "planning"
      ? {
          kind: "workday-demand",
          projectId: demand.projectId,
          agentId: demand.agentId,
          handlerId: demand.handlerId,
          mode: demand.mode,
		  executionMode,
          input: compilePlanningAssignmentInput(payload, intent, demand.activityType),
          metadata: {
            source: "workday-demand",
            demandId: demand.id,
            sourceType: demand.sourceType,
            activityType: demand.activityType,
            planningGraph: record(payload.planningGraph),
          },
        }
      : {
          ...record(payload.decisionInput),
          teamId: demand.teamId,
          projectId: demand.projectId,
          projectAgentClassId: demand.projectAgentClassId,
          mode: "acting",
		  executionMode,
          metadata: {
            ...record(record(payload.decisionInput).metadata),
            source: "workday-demand",
            demandId: demand.id,
            capacityPlanId: demand.capacityPlanId,
          },
        };
  const attribution=assignmentConfigurationAttribution({payload,projectAgentClassId:demand.projectAgentClassId,
    activityType:demand.activityType,handlerId:demand.handlerId,contentBaseRef,executionProvider:executionProvider as unknown as JsonRecord});
  return {
    assignmentId: id,
    reservationId: `reservation_${id}`,
    synthesisKey: demand.idempotencyKey,
    synthesizedFrom: "workday_demand",
	    projectId: demand.projectId,
	    environment: text(demand.metadata.environment, "local"),
	    grantId: text(selectedSupply.grantId) || null,
    providerSessionId: sessionId,
    executionProviderId: executionProvider.id,
	 offerId: selectedOffer?.offerId ?? null,
	 capabilityDemand,
	 capabilityNegotiation: negotiationReceipt,
	 laneId: lane.id,
	 lanePurpose: effectiveLanePurpose,
	 communicationOverflow,
	 executionKind,
	 triggerKind,
	 invocationId: text(demand.metadata.invocationId) || null,
	 parentWorkdayId: text(demand.metadata.parentWorkdayId) || null,
	 parentAssignmentId: text(demand.metadata.parentAssignmentId) || null,
	 handoffRootId: text(demand.metadata.handoffRootId) || null,
	 handoffParentId: text(demand.metadata.handoffParentId) || null,
	 handoffDepth: Math.max(0,Number(demand.metadata.handoffDepth??0)),
	 sourceMessageRefs,
	 operationHandoffId: text(demand.metadata.operationHandoffId) || text(payload.operationHandoffId) || null,
    projectAgentClassId: demand.projectAgentClassId,
    mode: demand.mode,
	executionMode,
    workDayId: demand.workdayId,
		requestedSeconds: demand.requestedSeconds,
    budget: capacityBudget,
    decisionId: demand.decisionId,
    proposalId:
      planningSubjectModel === "proposal" ? planningSubjectId || null : null,
    requiredCapabilities,
    agentId: demand.agentId,
    handlerId: demand.handlerId,
    capacityEnvelope,
    decisionInput,
    allowedOutputs: planning
      ? compilePlanningAllowedOutputs(
          payload,
          intent,
          demand.activityType,
          taskWritePaths,
        )
      : record(payload.allowedOutputs),
    workspaceContext: {
      workspaceAccessMode: "workspace_write",
      treedxProxyHandle,
    },
    treedxProxyHandle,
    explanation: {
      source: "workday-demand",
      demandId: demand.id,
      sourceType: demand.sourceType,
      sourceId: demand.sourceId,
      planningGraph: planning ? record(payload.planningGraph) : undefined,
		minimumAssignmentDuration,
		lanePurpose: effectiveLanePurpose,
		communicationOverflow,
		executionKind,
	  executionMode,
	  upstreamMutationPolicy: executionMode === 'production' ? 'checkpoint-only' : 'denied',
    },
    metadata: {
      demandId: demand.id,
	  offerId: selectedOffer?.offerId ?? null,
	  capabilityDemand,
	  capabilityNegotiation: negotiationReceipt,
	  executionMode,
	  upstreamMutationPolicy: executionMode === 'production' ? 'checkpoint-only' : 'denied',
	  activityType: demand.activityType,
	  executionPolicy: record(payload.executionPolicy),
	  chatProfile: record(payload.chatProfile),
	  identityManifest: executionKind === 'conversation' ? {
		  schemaVersion: 'treeseed.agent-identity-manifest/v1',
		  agentHandle: `@${projectSlug}/${text(demand.agentId)}`,
		  teamId: demand.teamId, projectId: demand.projectId, projectSlug,
		  agentSlug: text(demand.agentId), repositoryId, immutableRef: contentBaseRef,
		  agentProfile: { path: text(payload.agentContentPath), expectedRevision: contentBaseRef },
		  coreObjective: { path: coreObjectivePath, candidates: coreObjectiveCandidates, expectedRevision: contentBaseRef },
		  projectReadme: { path: projectReadmePath, expectedRevision: contentBaseRef },
		  instructionTemplates: instructionTemplateReadPaths.map((path) => ({ path, expectedRevision: contentBaseRef })),
	  } : {},
	  contextManifest: allowedReadPaths.map((path) => ({ path, immutableRef: contentBaseRef, access: 'read' })),
		agentClassSlug: text(demand.metadata.agentClassSlug),
      contentRoot,
      agentContentPath: text(payload.agentContentPath),
      workdayRunId: demand.workdayRunId,
      workspaceProvisioning: true,
      allowPlanningContentArtifacts: planning,
      groupIds:attribution.groupIds,
      configurationRevisions:attribution.configurationRevisions,
	  minimumAssignmentDuration,
	  lanePurpose: effectiveLanePurpose,
	  communicationOverflow,
	  executionKind,
    },
    workspace: {
      repositoryId,
      workspaceId,
      allowedPaths: workspaceAllowedPaths,
      baseRef: contentBaseRef,
    },
  };
}

async function provisionWorkspace(
  store: AssignmentFunctionStore,
  demand: NonNullable<
    Awaited<ReturnType<CapacityWorkdayDemandRepository["claimNext"]>>
  >,
  input: ReturnType<typeof assignmentInput>,
  now: string,
) {
  const run = await new CapacityWorkdayRunRepository(store).get(
    demand.teamId,
    demand.workdayRunId,
  );
  if (!run)
    throw new CapacityGovernanceError(
      "capacity_workday_run_missing",
      "Demand-owned workday run no longer exists.",
      500,
      { demandId: demand.id },
    );
  const workspace = await store.createCapacityWorkdayTreeDxWorkspace(
    { id: demand.projectId },
    run,
    {
      repositoryId: input.workspace.repositoryId,
      assignmentId: input.assignmentId,
      baseRef: input.workspace.baseRef,
      branchName: `refs/heads/${input.assignmentId}`,
      mode: "writable",
      allowedPaths: input.workspace.allowedPaths,
      ttlSeconds: Math.max(
        1800,
        Number(run.parameters.durationSeconds ?? 600) + 1800,
      ),
    },
  );
  await persistIssuedWorkspaceAuthority({
    store,
    assignmentId: input.assignmentId,
    proxyHandle: input.treedxProxyHandle,
    workspaceContext: input.workspaceContext,
    workspace,
    now,
  });
}

export async function assignNextCompiledDemand(
  store: AssignmentFunctionStore,
  principal: ProviderLeasePrincipal,
  sessionId: string,
  executionProviders: ProviderSynthesisExecutionProvider[],
  now = new Date().toISOString(),
): Promise<DurableProviderAssignment | null> {
  const demands = new CapacityWorkdayDemandRepository(store);
  const policy = teamSupplyPolicy(await store.getTeam(principal.teamId));
  for (const pending of await demands.listProvisioning(
    principal.teamId,
    principal.capacityProviderId,
  )) {
    const assignment = pending.assignmentId ? await store.getProviderAssignment(principal.teamId, pending.assignmentId) : null;
    const exactProviders = assignment ? executionProviders.filter((provider) => provider.id === assignment.executionProviderId) : executionProviders;
    const pendingInput = await assignmentInput(store, pending, principal, sessionId, exactProviders, policy, now);
    await provisionWorkspace(store, pending, pendingInput, now);
  }
  const demand = await demands.claimNext(
    principal.teamId,
    principal.capacityProviderId,
    now,
	principal.membershipId,
	sessionId,
  );
  if (!demand) return null;
  const continuation = await evaluateDurableWorkdayContinuation(store, {
    teamId: demand.teamId,
    workdayRunId: demand.workdayRunId,
    workdayId: demand.workdayId,
    usefulEligibleWork: true,
    now,
  });
  if (!continuation.continue) {
    await demands.cancelClaim(demand.id, demand.claimToken!, now);
    return null;
  }
  let input: ReturnType<typeof assignmentInput>;
  try {
    input = await assignmentInput(store, demand, principal, sessionId, executionProviders, policy, now);
  } catch (error) {
    await demands.releaseClaim(demand.id, demand.claimToken!, now);
    await recordAssignmentDenial(store, principal, demand.id, error, now);
    return null;
  }
  let assignment: DurableProviderAssignment | null;
  try {
    assignment = await admitSynthesizedProviderAssignment(
      store,
      principal,
      input,
    );
  } catch (error) {
    await demands.releaseClaim(demand.id, demand.claimToken!, now);
    await recordAssignmentDenial(store, principal, demand.id, error, now);
    return null;
  }
  if (!assignment) {
    await demands.releaseClaim(demand.id, demand.claimToken!, now);
    return null;
  }
  await demands.markAdmitted(demand.id, demand.claimToken!, assignment.id, now);
	await persistCapabilityNegotiation(store, { assignmentId: assignment.id, teamId: demand.teamId,
		receipt: input.capabilityNegotiation, now });
	if (assignment.operationHandoffId && assignment.decisionId) await bindOperationHandoffAssignment(store, assignment.operationHandoffId, assignment.id, assignment.decisionId, now);
  await new CapacityWorkdayParticipationRepository(store).bindAssignment(
    demand.id,
    assignment.id,
    now,
  );
  await provisionWorkspace(store, demand, input, now);
  return store.getProviderAssignment(principal.teamId, assignment.id);
}
