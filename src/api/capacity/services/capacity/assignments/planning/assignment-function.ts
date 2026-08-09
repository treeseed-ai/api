import { createHash } from "node:crypto";
import {
  selectCapacitySupply,
  type CapacitySupplyPolicy,
} from "@treeseed/sdk/agent-capacity";
import type { CapacityGovernanceDatabase } from "../../../../database.ts";
import { CapacityGovernanceError } from "../../../../database.ts";
import type { DurableProviderAssignment } from "../../../../repositories/capacity/assignments/assignment.ts";
import { CapacityWorkdayDemandRepository } from "../../../../repositories/capacity/workdays/workday-demand.ts";
import { CapacityWorkdayParticipationRepository } from "../../../../repositories/capacity/workdays/workday-participation.ts";
import {
CapacityWorkdayRunRepository,
type DurableCapacityWorkdayRun,
} from "../../../../repositories/capacity/workdays/workday-run.ts";
import { CapacityAuditRepository } from "../../../../repositories/support/audit.ts";
import type { ProviderLeasePrincipal } from "../../../accounts/lease-authority-service.ts";
import type { ProviderSynthesisExecutionProvider } from "../../providers/provider-synthesis-context-service.ts";
import { evaluateDurableWorkdayContinuation } from "../../workdays/lifecycle/workday-continuation-service.ts";
import type { ConfiguredWorkspaceInput } from "../../workdays/treedx/workday-treedx-workspace-service.ts";
import { workdayTreeDxWorkspaceId } from "../../workdays/treedx/workday-treedx-workspace-service.ts";
import { admitSynthesizedProviderAssignment } from "../admission/assignment-admission-service.ts";
import { teamSupplyPolicy } from "../../../../domain/supply-policy.ts";

type JsonRecord = Record<string, unknown>;
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

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}
function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
function assignmentId(demandId: string, generation: number): string {
	return `assignment_${createHash("sha256").update(`${demandId}:${generation}`).digest("base64url").slice(0, 32)}`;
}
export function resolveAssignmentContentPathScope(payload: JsonRecord, access: 'read' | 'write', contentRoot: string, fallback: string[]): string[] {
  const configured = record(record(payload.contentAccess)[access]).paths;
  if (!Array.isArray(configured) || configured.length === 0) return fallback;
  const root = contentRoot.replace(/\\/gu, '/').replace(/\/+$/u, '');
  const paths = configured.map(String).map((value) => value.trim().replace(/\\/gu, '/').replace(/^\.\//u, '')).filter(Boolean);
  const invalid = paths.filter((value) => value.startsWith('/') || value.split('/').includes('..') || (value !== root && !value.startsWith(`${root}/`)));
  if (invalid.length) {
    throw new CapacityGovernanceError(
      'capacity_workday_content_path_scope_invalid',
      'Agent content access contains a path outside the project content root.',
      500,
      { contentRoot, access, invalid },
    );
  }
  return [...new Set(paths)];
}
export function resolveAssignmentContentBaseRef(payload: JsonRecord): string {
  const intent = record(payload.intent);
  const relatedArtifact = record(intent.relatedArtifact);
  const relatedArtifacts = Array.isArray(intent.relatedArtifacts)
    ? intent.relatedArtifacts.map(record)
    : [];
  return text(
    relatedArtifact.commitSha,
    text(
      relatedArtifacts.find((artifact) => text(artifact.commitSha))?.commitSha,
      text(payload.contentBaseRef, "refs/heads/main"),
    ),
  );
}
function errorCode(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : "capacity_admission_denied";
}
export function compilePlanningAssignmentInput(
  payload: JsonRecord,
  intent: JsonRecord,
  activityType: string,
) {
  const subjectModel = text(intent.subjectModel);
  const subjectId = text(intent.subjectId);
  return {
    ...payload,
    ...intent,
    activityType,
    subjectModel: subjectModel || null,
    subjectId: subjectId || null,
    ...(subjectModel === "proposal" && subjectId
      ? { proposalId: subjectId }
      : {}),
  };
}
function assignmentInput(
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
  const contentRoot = text(payload.contentRoot, "src/content");
  const contentBaseRef = resolveAssignmentContentBaseRef(payload);
  const planning = demand.mode === "planning";
  const requiredCapabilities = Array.isArray(demand.metadata.requiredCapabilities)
    ? demand.metadata.requiredCapabilities.map(String).filter(Boolean)
    : [];
	const selectedSupply = record(demand.metadata.supplySelection);
	const selectedExecutionProviderId = text(selectedSupply.executionProviderId);
  const selection = selectCapacitySupply({
    policy,
    requiredCapabilities,
	    candidates: executionProviders.filter((provider) => !selectedExecutionProviderId || provider.id === selectedExecutionProviderId).map((provider) => ({
	      capacityProviderId: principal.capacityProviderId,
	      membershipId: principal.membershipId,
	      providerSessionId: sessionId,
	      grantId: text(selectedSupply.grantId),
      executionProviderId: provider.id,
      status: provider.status,
      capabilities: provider.capabilities,
      reliability: provider.reliability ?? 1,
      pressure: provider.pressure ?? 'normal',
      availableConcurrency: provider.availableConcurrency ?? 1,
      estimatedCost: provider.estimatedCost ?? null,
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
  const allowedReadPaths = resolveAssignmentContentPathScope(payload, 'read', contentRoot, ["**"]);
  const allowedWritePaths = planning
    ? resolveAssignmentContentPathScope(payload, 'write', contentRoot, [contentRoot, `${contentRoot}/**`])
    : ["**"];
  const workspaceId = workdayTreeDxWorkspaceId(id);
  const expiresAt = new Date(Date.parse(now) + demand.requestedSeconds * 1_000).toISOString();
  const treedxProxyHandle = {
    id: `tdx_${id}`,
    teamId: demand.teamId,
    projectId: demand.projectId,
    assignmentId: id,
    repositoryId,
    workspaceId,
    status: "provisioning",
    scopes: [
      "project:read",
      "project:write",
      "workspace:read",
      "workspace:write",
      "files:read",
      "files:search",
      "files:write",
      "git:commit",
    ],
    allowedOperations: [
      "files:read",
      "files:search",
      "files:write",
      "git:commit",
      "workspace:write",
    ],
    allowedPaths: allowedReadPaths,
    allowedReadPaths,
    allowedWritePaths,
    expiresAt,
    metadata: {
      source: "workday-demand",
      demandId: demand.id,
      workdayRunId: demand.workdayRunId,
    },
  };
  const configuredBudget = record(record(payload.capacityEnvelope).budget);
  const configuredTokens = record(configuredBudget.tokens);
  const capacityBudget = {
    schemaVersion: 'treeseed.capacity-budget/v2',
    ...configuredBudget,
    time: { ...record(configuredBudget.time), requestedSeconds: demand.requestedSeconds, reservedSeconds: demand.requestedSeconds, activeSeconds: 0, elapsedSeconds: 0, releasedSeconds: 0, overrunSeconds: 0, hardDeadlineAt: expiresAt, remainingSeconds: demand.requestedSeconds },
    tokens: { inputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, outputTokens: 0, hardLimitTokens: configuredTokens.hardLimitTokens ?? null, warningTokens: configuredTokens.warningTokens ?? null, hardLimitEnforceable: configuredTokens.hardLimitEnforceable === true },
    maxAttempts: Math.max(1, Number(configuredBudget.maxAttempts ?? 1)),
    maxConcurrency: 1,
    deadline: expiresAt,
    pricingGeneration: configuredBudget.pricingGeneration ?? null,
    enforcementConfidence: configuredBudget.enforcementConfidence ?? 'bounded',
  };
  const capacityEnvelope = {
    ...record(payload.capacityEnvelope),
    workDayId: demand.workdayId,
    projectId: demand.projectId,
    capacityProviderId: principal.capacityProviderId,
    executionProviderId: executionProvider.id,
    mode: demand.mode,
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
  const planningOutputTypes = [
    "content_artifact_refs",
    intent.artifactKind,
    demand.activityType === "estimating" ? "structured_agent_estimate" : null,
  ].filter(Boolean);
  const decisionInput =
    demand.mode === "planning"
      ? {
          kind: "workday-demand",
          projectId: demand.projectId,
          agentId: demand.agentId,
          handlerId: demand.handlerId,
          mode: demand.mode,
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
          metadata: {
            ...record(record(payload.decisionInput).metadata),
            source: "workday-demand",
            demandId: demand.id,
            capacityPlanId: demand.capacityPlanId,
          },
        };
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
    projectAgentClassId: demand.projectAgentClassId,
    mode: demand.mode,
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
      ? { paths: allowedWritePaths, types: planningOutputTypes,
          publishedSignals: Array.isArray(record(payload.signalPolicy).publishes) ? record(payload.signalPolicy).publishes : [] }
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
    },
    metadata: {
      demandId: demand.id,
      activityType: demand.activityType,
		agentClassSlug: text(demand.metadata.agentClassSlug),
      contentRoot,
      agentContentPath: text(payload.agentContentPath),
      workdayRunId: demand.workdayRunId,
      workspaceProvisioning: true,
      allowPlanningContentArtifacts: planning,
    },
    workspace: {
      repositoryId,
      workspaceId,
      allowedPaths: allowedReadPaths,
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
  await store.createCapacityWorkdayTreeDxWorkspace(
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
  await store.run(
    `UPDATE treedx_proxy_handles SET status = 'issued', updated_at = ? WHERE assignment_id = ? AND status = 'provisioning'`,
    [now, input.assignmentId],
  );
}

async function recordDenial(
  store: AssignmentFunctionStore,
  principal: ProviderLeasePrincipal,
  demandId: string,
  error: unknown,
  now: string,
) {
  const code = errorCode(error);
  const details = error && typeof error === "object" && "details" in error
    && error.details && typeof error.details === "object" && !Array.isArray(error.details)
    ? error.details as JsonRecord
    : {};
  await new CapacityAuditRepository(store).record({
    id: `audit:${demandId}:${code}`,
    teamId: principal.teamId,
    providerId: principal.capacityProviderId,
    membershipId: principal.membershipId,
    actorType: "provider-membership",
    actorId: principal.membershipId,
    action: "assignment-function.denied",
    resourceType: "capacity-workday-demand",
    resourceId: demandId,
    idempotencyKey: `${demandId}:${code}`,
    metadata: {
      reasons: [code],
      message: error instanceof Error ? error.message : String(error),
      details,
    },
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
    const pendingInput = assignmentInput(pending, principal, sessionId, exactProviders, policy, now);
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
    await demands.releaseClaim(demand.id, demand.claimToken!, now);
    return null;
  }
  let input: ReturnType<typeof assignmentInput>;
  try {
    input = assignmentInput(demand, principal, sessionId, executionProviders, policy, now);
  } catch (error) {
    await demands.releaseClaim(demand.id, demand.claimToken!, now);
    await recordDenial(store, principal, demand.id, error, now);
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
    await recordDenial(store, principal, demand.id, error, now);
    return null;
  }
  if (!assignment) {
    await demands.releaseClaim(demand.id, demand.claimToken!, now);
    return null;
  }
  await demands.markAdmitted(demand.id, demand.claimToken!, assignment.id, now);
  await new CapacityWorkdayParticipationRepository(store).bindAssignment(
    demand.id,
    assignment.id,
    now,
  );
  await provisionWorkspace(store, demand, input, now);
  return store.getProviderAssignment(principal.teamId, assignment.id);
}
