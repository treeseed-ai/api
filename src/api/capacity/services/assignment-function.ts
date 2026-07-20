import { createHash } from "node:crypto";
import type { CapacityGovernanceDatabase } from "../database.ts";
import { CapacityGovernanceError } from "../database.ts";
import { CapacityAuditRepository } from "../repositories/audit.ts";
import type { DurableProviderAssignment } from "../repositories/assignment.ts";
import { CapacityWorkdayDemandRepository } from "../repositories/workday-demand.ts";
import { CapacityWorkdayParticipationRepository } from "../repositories/workday-participation.ts";
import {
  CapacityWorkdayRunRepository,
  type DurableCapacityWorkdayRun,
} from "../repositories/workday-run.ts";
import { admitSynthesizedProviderAssignment } from "./assignment-admission-service.ts";
import type { ProviderLeasePrincipal } from "./lease-authority-service.ts";
import { workdayTreeDxWorkspaceId } from "./workday-treedx-workspace-service.ts";
import { evaluateDurableWorkdayContinuation } from "./workday-continuation-service.ts";

type JsonRecord = Record<string, unknown>;
interface AssignmentFunctionStore extends CapacityGovernanceDatabase {
  getProviderAssignment(
    teamId: string,
    assignmentId: string,
  ): Promise<DurableProviderAssignment | null>;
  createCapacityWorkdayTreeDxWorkspace(
    project: { id: string },
    run: DurableCapacityWorkdayRun,
    input: JsonRecord,
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
function assignmentId(demandId: string): string {
  return `assignment_${createHash("sha256").update(demandId).digest("base64url").slice(0, 32)}`;
}
function errorCode(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : "capacity_admission_denied";
}
function assignmentInput(
  demand: Awaited<ReturnType<CapacityWorkdayDemandRepository["claimNext"]>>,
  principal: ProviderLeasePrincipal,
  sessionId: string,
  now: string,
) {
  if (!demand?.claimToken)
    throw new CapacityGovernanceError(
      "capacity_workday_demand_claim_missing",
      "Claimed demand has no claim token.",
      500,
    );
  const id = demand.assignmentId ?? assignmentId(demand.id);
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
  const contentBaseRef = text(payload.contentBaseRef, "refs/heads/main");
  const planning = demand.mode === "planning";
  const allowedReadPaths = ["**"];
  const allowedWritePaths = planning
    ? [contentRoot, `${contentRoot}/**`]
    : ["**"];
  const workspaceId = workdayTreeDxWorkspaceId(id);
  const expiresAt = new Date(Date.parse(now) + 3_600_000).toISOString();
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
  const capacityEnvelope = {
    ...record(payload.capacityEnvelope),
    workDayId: demand.workdayId,
    projectId: demand.projectId,
    capacityProviderId: principal.capacityProviderId,
    mode: demand.mode,
    reservedCredits: demand.requestedCredits,
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
          input: {
            ...payload,
            activityType: demand.activityType,
            objective: text(intent.objective),
            artifactKind: intent.artifactKind ?? null,
            subjectModel: planningSubjectModel || null,
            subjectId: planningSubjectId || null,
            ...(planningSubjectModel === "proposal" && planningSubjectId
              ? { proposalId: planningSubjectId }
              : {}),
          },
          metadata: {
            source: "workday-demand",
            demandId: demand.id,
            sourceType: demand.sourceType,
            activityType: demand.activityType,
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
    providerSessionId: sessionId,
    projectAgentClassId: demand.projectAgentClassId,
    mode: demand.mode,
    workDayId: demand.workdayId,
    requestedCredits: demand.requestedCredits,
    decisionId: demand.decisionId,
    proposalId:
      planningSubjectModel === "proposal" ? planningSubjectId || null : null,
    requiredCapabilities: Array.isArray(demand.metadata.requiredCapabilities)
      ? demand.metadata.requiredCapabilities
      : [],
    agentId: demand.agentId,
    handlerId: demand.handlerId,
    capacityEnvelope,
    decisionInput,
    allowedOutputs: planning
      ? { paths: allowedWritePaths, types: planningOutputTypes }
      : {},
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
    },
    metadata: {
      demandId: demand.id,
      activityType: demand.activityType,
      contentRoot,
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
  code: string,
  now: string,
) {
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
    metadata: { reasons: [code] },
    now,
  });
}

export async function assignNextCompiledDemand(
  store: AssignmentFunctionStore,
  principal: ProviderLeasePrincipal,
  sessionId: string,
  now = new Date().toISOString(),
): Promise<DurableProviderAssignment | null> {
  const demands = new CapacityWorkdayDemandRepository(store);
  for (const pending of await demands.listProvisioning(
    principal.teamId,
    principal.capacityProviderId,
  )) {
    const pendingInput = assignmentInput(pending, principal, sessionId, now);
    await provisionWorkspace(store, pending, pendingInput, now);
  }
  const demand = await demands.claimNext(
    principal.teamId,
    principal.capacityProviderId,
    now,
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
  const input = assignmentInput(demand, principal, sessionId, now);
  let assignment: DurableProviderAssignment | null;
  try {
    assignment = await admitSynthesizedProviderAssignment(
      store,
      principal,
      input,
    );
  } catch (error) {
    await demands.releaseClaim(demand.id, demand.claimToken!, now);
    await recordDenial(store, principal, demand.id, errorCode(error), now);
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
