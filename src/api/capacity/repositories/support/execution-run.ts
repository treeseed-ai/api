import {
  encodeCapacityPageCursor,
  normalizeCapacityPageLimit,
  type CapacityPage,
  type CapacityPageCursor,
} from "@treeseed/sdk/capacity-pagination";
import type { CapacityGovernanceDatabase } from "../../database.ts";
import { canonicalArtifactManifestReferences } from "../../domain/artifact-manifest-evidence.ts";
import { CapacityGovernanceError } from "../../database.ts";
import { serializeAgentModeRunRow } from "./mode-run.ts";

type Row = Record<string, unknown>;

export interface ExecutionRunListFilters {
  projectId?: string | null;
  providerId?: string | null;
  status?: string | null;
  mode?: string | null;
  assignmentId?: string | null;
  workdayId?: string | null;
  executionProviderId?: string | null;
  limit?: unknown;
  cursor?: CapacityPageCursor | null;
}

function record(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
}

function jsonRecord(value: unknown): Row {
  if (typeof value !== "string") return record(value);
  try {
    return record(JSON.parse(value));
  } catch {
    return {};
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function durationMs(start: unknown, end: unknown): number | null {
  if (typeof start !== "string" || typeof end !== "string") return null;
  const started = Date.parse(start);
  const finished = Date.parse(end);
  return Number.isFinite(started) && Number.isFinite(finished)
    ? Math.max(0, finished - started)
    : null;
}

function contentArtifactRefs(row: Row): Row[] {
  const refs: Row[] = [];
  const modeOutputs = jsonRecord(row.outputs_json);
  const assignmentOutput = jsonRecord(
    row.assignment_lifecycle_output_json ?? row.lifecycle_output_json,
  );
  refs.push(
    ...canonicalArtifactManifestReferences(
      modeOutputs,
      `mode run ${String(row.id ?? "")}`,
    ),
  );
  refs.push(
    ...canonicalArtifactManifestReferences(
      assignmentOutput,
      `assignment ${String(row.assignment_id ?? "")}`,
    ),
  );
  const seen = new Set<string>();
  return refs.filter((reference) => {
    const key = JSON.stringify(reference);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function tokenDiagnostics(row: Row) {
  const usage = jsonRecord(row.usage_actual_json);
  const outputs = jsonRecord(row.outputs_json);
  const outputMetadata = record(outputs.metadata);
  const artifact = record(outputMetadata.artifact);
  const snapshot = record(
    outputMetadata.executionSnapshot ?? artifact.executionSnapshot,
  );
  const snapshotMetadata = record(snapshot.metadata);
  const codex = record(snapshotMetadata.codex ?? outputMetadata.codex);
  const nativeUsage = record(usage.nativeUsage);
  const rawUsage = record(
    codex.usage ?? snapshot.usage ?? nativeUsage.executionUsage,
  );
  const numberOrNull = (...values: unknown[]) => {
    for (const value of values) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed !== 0) return parsed;
    }
    return null;
  };
  return {
    inputTokens: numberOrNull(
      rawUsage.input_tokens,
      rawUsage.inputTokens,
      rawUsage.prompt_tokens,
      rawUsage.promptTokens,
    ),
    outputTokens: numberOrNull(
      rawUsage.output_tokens,
      rawUsage.outputTokens,
      rawUsage.completion_tokens,
      rawUsage.completionTokens,
    ),
    cachedInputTokens: numberOrNull(
      rawUsage.cached_input_tokens,
      rawUsage.cachedInputTokens,
    ),
    rawUsage: Object.keys(rawUsage).length > 0 ? rawUsage : null,
  };
}

function telemetryEntry(row: Row) {
  const run = serializeAgentModeRunRow(row);
  if (!run) return null;
  const outputs = record(run.outputs);
  const metadata = record(run.metadata);
  const outputMetadata = record(outputs.metadata);
  return {
    id: run.id,
    status: run.status,
    mode: run.mode,
    agentId: run.agentId,
    handlerId: run.handlerId,
    assignmentId: run.providerAssignmentId,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    failedAt: run.failedAt,
    source: stringValue(metadata.source ?? outputMetadata.source),
    outputStatus: outputs.status ?? null,
    summary: outputs.summary ?? null,
    outputs,
    traceRefs: run.traceRefs,
    usageActual: run.usageActual,
    validation: run.validation,
    fallbackReason: run.fallbackReason,
    metadata,
  };
}

export async function listExecutionRunsForTeamPage(
  database: CapacityGovernanceDatabase,
  teamId: string,
  filters: ExecutionRunListFilters = {},
): Promise<CapacityPage<Row>> {
  await database.ensureInitialized();
  const clauses = ["a.team_id = ?"];
  const values: unknown[] = [teamId];
  if (filters.projectId) {
    clauses.push("a.project_id = ?");
    values.push(filters.projectId);
  }
  if (filters.providerId) {
    clauses.push("a.capacity_provider_id = ?");
    values.push(filters.providerId);
  }
  if (filters.status) {
    clauses.push("(m.status = ? OR a.status = ?)");
    values.push(filters.status, filters.status);
  }
  if (filters.mode) {
    clauses.push("m.mode = ?");
    values.push(filters.mode);
  }
  if (filters.assignmentId) {
    clauses.push("a.id = ?");
    values.push(filters.assignmentId);
  }
  if (filters.workdayId) {
    clauses.push("a.work_day_id = ?");
    values.push(filters.workdayId);
  }
  if (filters.executionProviderId) {
    clauses.push(
      "COALESCE(m.execution_provider_id, a.execution_provider_id) = ?",
    );
    values.push(filters.executionProviderId);
  }
  if (filters.cursor) {
    clauses.push("(m.created_at < ? OR (m.created_at = ? AND m.id < ?))");
    values.push(
      filters.cursor.createdAt,
      filters.cursor.createdAt,
      filters.cursor.id,
    );
  }
  const limit = normalizeCapacityPageLimit(filters.limit);
  const rows = await database.all(
    `SELECT
			m.*,
			a.status AS assignment_status,
			a.lease_state AS assignment_lease_state,
			a.work_day_id AS assignment_work_day_id,
			a.task_id AS assignment_task_id,
			a.decision_id AS assignment_decision_id,
			a.proposal_id AS assignment_proposal_id,
			a.runner_id AS assignment_runner_id,
			a.lifecycle_reason AS assignment_lifecycle_reason,
			a.lifecycle_code AS assignment_lifecycle_code,
			a.lifecycle_output_json AS assignment_lifecycle_output_json,
			a.decision_input_json AS assignment_decision_input_json,
			a.workspace_context_json AS assignment_workspace_context_json,
			a.allowed_outputs_json AS assignment_allowed_outputs_json,
			a.explanation_json AS assignment_explanation_json,
			a.created_at AS assignment_created_at,
			a.assigned_at AS assignment_assigned_at,
			a.claimed_at AS assignment_claimed_at,
			a.completed_at AS assignment_completed_at,
			a.failed_at AS assignment_failed_at,
			a.returned_at AS assignment_returned_at,
			p.slug AS project_slug,
			p.name AS project_name,
			c.slug AS agent_class_slug,
			c.name AS agent_class_name
		 FROM agent_mode_runs m
		 JOIN capacity_provider_assignments a ON a.id = m.provider_assignment_id
		 LEFT JOIN projects p ON p.id = m.project_id
		 LEFT JOIN project_agent_classes c ON c.project_id = m.project_id AND c.id = m.project_agent_class_id
		 WHERE ${clauses.join(" AND ")}
		 ORDER BY m.created_at DESC, m.id DESC
		 LIMIT ?`,
    [...values, limit + 1],
  );
  const selected = rows.slice(0, limit);
  const assignmentIds = [
    ...new Set(
      selected
        .map((row) => stringValue(row.provider_assignment_id))
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const telemetryRows = assignmentIds.length
    ? await database.all(
        `SELECT * FROM agent_mode_runs
			 WHERE team_id = ? AND provider_assignment_id IN (${assignmentIds.map(() => "?").join(", ")})
			 ORDER BY COALESCE(started_at, created_at) ASC, created_at ASC`,
        [teamId, ...assignmentIds],
      )
    : [];
  const telemetryByAssignment = new Map<string, Row[]>();
  for (const telemetryRow of telemetryRows) {
    const entry = telemetryEntry(telemetryRow);
    if (!entry || !entry.assignmentId) continue;
    telemetryByAssignment.set(entry.assignmentId, [
      ...(telemetryByAssignment.get(entry.assignmentId) ?? []),
      entry,
    ]);
  }
  const items = selected.map((row) => {
    const run = serializeAgentModeRunRow(row);
    if (!run) {
      throw new CapacityGovernanceError(
        "execution_run_projection_invalid",
        "Mode-run row could not be serialized.",
        500,
      );
    }
    const finishedAt =
      row.completed_at ??
      row.failed_at ??
      row.assignment_completed_at ??
      row.assignment_failed_at ??
      row.assignment_returned_at ??
      null;
    const tokens = tokenDiagnostics(row);
    return {
      id: run.id,
      status: run.status,
      mode: run.mode,
      timing: {
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        failedAt: run.failedAt,
        finishedAt,
        durationMs: durationMs(run.startedAt ?? run.createdAt, finishedAt),
      },
      agent: {
        projectId: run.projectId,
        projectSlug: row.project_slug ?? null,
        projectName: row.project_name ?? null,
        projectAgentClassId: run.projectAgentClassId,
        classSlug: row.agent_class_slug ?? null,
        className: row.agent_class_name ?? null,
        agentId: run.agentId,
        handlerId: run.handlerId,
      },
      assignment: {
        id: run.providerAssignmentId,
        status: row.assignment_status ?? null,
        leaseState: row.assignment_lease_state ?? null,
        workdayId: row.assignment_work_day_id ?? null,
        taskId: row.assignment_task_id ?? null,
        decisionId: row.assignment_decision_id ?? null,
        proposalId: row.assignment_proposal_id ?? null,
        runnerId: row.assignment_runner_id ?? null,
        lifecycleCode: row.assignment_lifecycle_code ?? null,
        lifecycleReason: row.assignment_lifecycle_reason ?? null,
      },
      executionProvider: {
        id: run.executionProviderId,
        capacityProviderId: run.capacityProviderId,
        tokenCounts: tokens,
        hasTokenCounts: Boolean(
          tokens.inputTokens || tokens.outputTokens || tokens.cachedInputTokens,
        ),
      },
      input: {
        selectedInput: run.selectedInput,
        decisionInput: jsonRecord(row.assignment_decision_input_json),
        capacityEnvelope: run.capacityEnvelope,
        workspaceContext: jsonRecord(row.assignment_workspace_context_json),
        allowedOutputs: jsonRecord(row.assignment_allowed_outputs_json),
      },
      output: {
        outputs: run.outputs,
        lifecycleOutput: jsonRecord(row.assignment_lifecycle_output_json),
        usageActual: run.usageActual,
        validation: run.validation,
        fallbackReason: run.fallbackReason,
      },
      contentArtifactRefs: contentArtifactRefs(row),
      context: {
        traceRefs: run.traceRefs,
        assignmentExplanation: jsonRecord(row.assignment_explanation_json),
      },
      metadata: { modeRun: run.metadata },
      modeRuns: telemetryByAssignment.get(run.providerAssignmentId) ?? [],
    };
  });
  const hasMore = rows.length > limit;
  const last = selected.at(-1);
  return {
    items,
    page: {
      limit,
      hasMore,
      nextCursor:
        hasMore && last
          ? encodeCapacityPageCursor({
              createdAt: String(last.created_at),
              id: String(last.id),
            })
          : null,
    },
  };
}
