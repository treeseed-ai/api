import { createHash } from "node:crypto";
import type { AgentAtlasActivityItem, AgentAtlasAssignmentSummary, AgentAtlasDelta, AgentAtlasEventCategory, AgentAtlasNodeState, AgentAtlasProjection, AgentAtlasReplayCursor, AgentAtlasScope, AgentAtlasSizingMetric, AgentAtlasTopologySnapshot } from "@treeseed/sdk/agent-capacity";
import { agentAtlasSizingMetrics } from "@treeseed/sdk/agent-capacity";
import { compileWorkdayAtlasTopology } from "../workdays/policy/workday-atlas-topology-policy.ts";
import { compileWorkdayPlanningGraphSnapshot, type WorkdayPlanningGraphSnapshot } from "../workdays/policy/workday-planning-graph-policy.ts";

type Row = Record<string, unknown>;
type Snapshot = { overview: { revision: string; generatedAt: string; timeZone: string; team?: { id: string }; operatingDay: { start: string; end: string }; workdayContext: { selectedDate: string; selectedWorkdayId: string | null } }; rows: { projects: Row[]; classes: Row[]; workdays: Row[]; events: Row[]; assignments: Row[]; executions: Row[]; demands: Row[]; usage: Row[]; ledger: Row[] } };

function record(value: unknown): Row {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Row;
  if (typeof value === "string")
    try {
      return record(JSON.parse(value));
    } catch {
      return {};
    }
  return {};
}
function text(...values: unknown[]) { return String(values.find((value) => typeof value === "string" && value) ?? ""); }
function number(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function iso(value: unknown, fallback: string) { const parsed = Date.parse(String(value ?? "")); return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }

function category(eventType: string): AgentAtlasEventCategory {
  const value = eventType.toLowerCase();
  if (value.includes("question")) return "question";
  if (value.includes("proposal")) return "proposal";
  if (value.includes("estimate")) return "estimate";
  if (value.includes("assignment")) return "assignment";
  if (value.includes("artifact") || value.includes("content")) return "artifact";
  if (value.includes("signal")) return "signal";
  if (value.includes("tool")) return "tool";
  if (value.includes("usage") || value.includes("settle") || value.includes("ledger")) return "usage";
  if (value.includes("message") || value.includes("discussion")) return "message";
  if (value.includes("note")) return "note";
  if (value.includes("fail") || value.includes("error") || value.includes("blocked")) return "failure";
  return "execution";
}

function eventActivity(row: Row): AgentAtlasActivityItem {
  const context = record(row.context_json ?? row.context);
  const refs = record(row.refs_json ?? row.refs);
  const metadata = record(row.metadata_json ?? row.metadata);
  const eventType = text(row.event_type, row.eventType, "event");
  const status = text(row.status);
  return {
    id: text(row.id),
    workdayId: text(row.run_id, row.runId),
    sequence: number(row.event_index ?? row.eventIndex),
    timestamp: iso(row.created_at ?? row.createdAt, new Date(0).toISOString()),
    category: category(eventType),
    direction:
      eventType.includes("requested") || eventType.includes("received")
        ? "input"
        : eventType.includes("published") || eventType.includes("completed")
          ? "output"
          : "internal",
    severity: ["failed", "error"].includes(status)
      ? "error"
      : status === "warning"
        ? "warning"
        : "info",
    summary: text(row.message, row.title, eventType),
    projectId: text(row.project_id, row.projectId) || null,
    agentId: text(context.agentId) || null,
    activityProfile: text(context.activityType) || null,
    signalContractId:
      text(context.signalContractId, metadata.contractId) || null,
    assignmentId: text(row.assignment_id, row.assignmentId) || null,
    artifactRefs: array(refs.artifacts).map(record),
    metadata: { eventType, ...metadata },
  };
}

function runTopologies(snapshot: Snapshot): AgentAtlasTopologySnapshot[] {
  const projects = new Map(
    snapshot.rows.projects.map((project) => [text(project.id), project]),
  );
  const frozen = snapshot.rows.workdays.flatMap((run) => {
    const parameters = record(run.parameters_json);
    const stored = record(parameters.atlasTopologyByProjectId);
    if (Object.keys(stored).length)
      return Object.values(stored) as AgentAtlasTopologySnapshot[];
    const planning = record(parameters.planningGraphByProjectId);
    return Object.entries(planning).flatMap(([projectId, value]) => {
      const project = projects.get(projectId);
      if (!project) return [];
      try {
        return [
          compileWorkdayAtlasTopology({
            project: project as never,
            planning: value as WorkdayPlanningGraphSnapshot,
            immutableRef: text(record(value).revision),
            capturedAt: iso(
              run.started_at ?? run.created_at,
              snapshot.overview.generatedAt,
            ),
          }),
        ];
      } catch {
        return [];
      }
    });
  });
  const current =
    snapshot.overview.workdayContext.selectedWorkdayId === null
      ? snapshot.rows.projects.flatMap((project) => {
          const projectId = text(project.id);
          const classes = (snapshot.rows.classes ?? []).filter(
            (agentClass) => text(agentClass.project_id) === projectId,
          );
          if (!classes.length) return [];
          try {
            const planning = compileWorkdayPlanningGraphSnapshot(
              classes,
              undefined,
            );
            const metadata = record(classes[0]?.metadata_json);
            return [
              compileWorkdayAtlasTopology({
                project: project as never,
                planning,
                immutableRef: text(metadata.immutableRef, planning.revision),
                capturedAt: snapshot.overview.generatedAt,
              }),
            ];
          } catch {
            return [];
          }
        })
      : [];
  const snapshots = [...current, ...frozen];
  const uniqueSnapshots = [
    ...new Map(
      snapshots.map((topology) => [
        `${topology.projectId}:${topology.revision}`,
        topology,
      ]),
    ).values(),
  ];
  const revisionsByProject = new Map<string, Set<string>>();
  for (const topology of uniqueSnapshots)
    revisionsByProject.set(
      topology.projectId,
      new Set([
        ...(revisionsByProject.get(topology.projectId) ?? []),
        topology.revision,
      ]),
    );
  return uniqueSnapshots.map((topology) => {
    if ((revisionsByProject.get(topology.projectId)?.size ?? 0) < 2)
      return topology;
    const suffix = `@${createHash("sha256").update(topology.revision).digest("hex").slice(0, 8)}`;
    const ids = new Map(
      topology.nodes.map((node) => [node.id, `${node.id}${suffix}`]),
    );
    return {
      ...topology,
      nodes: topology.nodes.map((node) => ({
        ...node,
        id: ids.get(node.id)!,
        parentId: node.parentId
          ? (ids.get(node.parentId) ?? node.parentId)
          : null,
        metadata: { ...node.metadata, revisionVariant: topology.revision },
      })),
      edges: topology.edges.map((edge) => ({
        ...edge,
        id: `${edge.id}${suffix}`,
        fromNodeId: ids.get(edge.fromNodeId) ?? edge.fromNodeId,
        toNodeId: ids.get(edge.toNodeId) ?? edge.toNodeId,
        metadata: { ...edge.metadata, revisionVariant: topology.revision },
      })),
    };
  });
}

function assignmentStatus(eventType: string, fallback: string) {
  if (eventType.includes("complet")) return "completed";
  if (eventType.includes("fail")) return "failed";
  if (eventType.includes("return")) return "returned";
  if (eventType.includes("start") || eventType.includes("running"))
    return "running";
  if (eventType.includes("lease")) return "leased";
  if (eventType.includes("admit")) return "admitted";
  if (eventType.includes("queue") || eventType.includes("creat"))
    return "queued";
  return fallback;
}

function assignmentSummaries(
  snapshot: Snapshot,
  activity: AgentAtlasActivityItem[],
  observedAt: string,
): AgentAtlasAssignmentSummary[] {
  const demandByAssignment = new Map(
    snapshot.rows.demands.map((row) => [text(row.assignment_id), row]),
  );
  return snapshot.rows.assignments
    .filter(
      (row) =>
        !text(row.created_at) || iso(row.created_at, observedAt) <= observedAt,
    )
    .map((row) => {
      const demand = demandByAssignment.get(text(row.id));
      const payload = record(row.payload_json);
      const metadata = record(demand?.metadata_json);
      const graph = record(payload.planningGraph);
      const events = activity.filter(
        (item) => item.assignmentId === text(row.id),
      );
      const latest = events.at(-1);
      const latestMetadata = record(latest?.metadata);
      const progress = Number(
        latestMetadata.progressPercent ??
          metadata.progressPercent ??
          payload.progressPercent,
      );
      return {
        id: text(row.id),
        projectId: text(row.project_id),
        workdayId: text(demand?.workday_run_id, row.workday_run_id),
        agentId: text(row.agent_id, payload.agentId) || null,
        name: text(payload.objective, payload.title, row.id),
        status: assignmentStatus(
          text(latestMetadata.eventType),
          events.length ? "queued" : text(row.status, "unknown"),
        ),
        progressPercent: Number.isFinite(progress)
          ? Math.max(0, Math.min(100, progress))
          : null,
        startedAt:
          events.find((item) => text(item.metadata.eventType).includes("start"))
            ?.timestamp ?? null,
        finishedAt:
          [...events]
            .reverse()
            .find((item) =>
              /complet|fail|return/u.test(text(item.metadata.eventType)),
            )?.timestamp ?? null,
        decisionId: text(row.decision_id, payload.decisionId) || null,
        proposalId: text(row.proposal_id, payload.proposalId) || null,
        graphId: text(graph.graphId, payload.assignmentGraphId) || null,
        graphNodeId: text(graph.nodeId, metadata.planningGraphNodeId) || null,
      };
    });
}

function normalizeMetric(
  states: Array<{
    state: AgentAtlasNodeState;
    raw: Record<AgentAtlasSizingMetric, number>;
  }>,
) {
  for (const metric of agentAtlasSizingMetrics) {
    const maximum = Math.max(1, ...states.map((entry) => entry.raw[metric]));
    for (const entry of states)
      entry.state.metrics.push({
        metric,
        rawValue: entry.raw[metric],
        normalizedValue: Math.round((entry.raw[metric] / maximum) * 100),
        unit: metric === "cost" ? "microunits" : "count",
      });
  }
}

function nodeStates(
  snapshot: Snapshot,
  topologies: AgentAtlasTopologySnapshot[],
  assignments: AgentAtlasAssignmentSummary[],
  activity: AgentAtlasActivityItem[],
  observedAt: string,
) {
  const states = topologies.flatMap((topology) =>
    topology.nodes
      .filter((node) => node.kind === "agent")
      .map((node) => {
        const relatedAssignments = assignments.filter(
          (item) =>
            item.projectId === topology.projectId && item.agentId === node.slug,
        );
        const relatedExecutions = snapshot.rows.executions.filter(
          (row) =>
            text(row.project_id) === topology.projectId &&
            text(row.agent_id) === node.slug &&
            (!text(row.started_at) ||
              iso(row.started_at, observedAt) <= observedAt),
        );
        const relatedEvents = activity.filter(
          (item) =>
            item.projectId === topology.projectId && item.agentId === node.slug,
        );
        const active = relatedAssignments.find((item) =>
          ["pending", "admitted", "leased", "queued", "running"].includes(
            item.status,
          ),
        );
        const failed =
          relatedAssignments.some((item) =>
            ["failed", "expired", "returned"].includes(item.status),
          ) || relatedEvents.some((item) => item.severity === "error");
        const status: AgentAtlasNodeState["status"] = failed
          ? "degraded"
          : active?.status === "running"
            ? "running"
            : active
              ? "queued"
              : relatedAssignments.length &&
                  relatedAssignments.every(
                    (item) => item.status === "completed",
                  )
                ? "completed"
                : "idle";
        const cost = snapshot.rows.ledger
          .filter(
            (row) =>
              relatedAssignments.some(
                (item) => item.id === text(row.assignment_id),
              ) &&
              (!text(row.created_at) ||
                iso(row.created_at, observedAt) <= observedAt),
          )
          .reduce((sum, row) => sum + number(row.amount_microunits), 0);
        const state: AgentAtlasNodeState = {
          nodeId: node.id,
          workdayIds: [
            ...new Set(
              relatedAssignments.map((item) => item.workdayId).filter(Boolean),
            ),
          ],
          status,
          progressPercent: active?.progressPercent ?? null,
          elapsedSeconds: null,
          timeboxSeconds: null,
          metrics: [],
          activeAssignmentIds: active ? [active.id] : [],
          lastEventSequence: relatedEvents.at(-1)?.sequence ?? null,
          observedAt: relatedEvents.at(-1)?.timestamp ?? null,
        };
        return {
          state,
          raw: {
            activity: status === "running" ? 1 : 0,
            queue: relatedAssignments.filter((item) =>
              ["pending", "admitted", "leased", "queued"].includes(item.status),
            ).length,
            executions: relatedExecutions.length,
            artifacts: relatedEvents.reduce(
              (sum, item) => sum + item.artifactRefs.length,
              0,
            ),
            cost,
            attention: failed ? 1 : 0,
          },
        };
      }),
  );
  normalizeMetric(states);
  return states.map((entry) => entry.state);
}

function cursor(
  activity: AgentAtlasActivityItem[],
  observedAt: string,
): AgentAtlasReplayCursor {
  const positions: Record<string, number> = {};
  for (const item of activity)
    positions[item.workdayId] = Math.max(
      positions[item.workdayId] ?? -1,
      item.sequence,
    );
  return {
    cursor: Buffer.from(JSON.stringify({ observedAt, positions })).toString(
      "base64url",
    ),
    observedAt,
    positions,
  };
}

export class AgentAtlasProjectionService {
  projection(
    snapshot: Snapshot,
    input: {
      metric?: string;
      cursor?: string | null;
      observedAt?: string | null;
    } = {},
  ): AgentAtlasProjection {
    const allActivity = snapshot.rows.events
      .map(eventActivity)
      .sort(
        (left, right) =>
          left.timestamp.localeCompare(right.timestamp) ||
          left.workdayId.localeCompare(right.workdayId) ||
          left.sequence - right.sequence,
      );
    let observedAt = iso(input.observedAt, snapshot.overview.generatedAt);
    if (input.cursor)
      try {
        observedAt = text(
          record(
            JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")),
          ).observedAt,
          observedAt,
        );
      } catch {
        observedAt = snapshot.overview.generatedAt;
      }
    const activity = allActivity.filter((item) => item.timestamp <= observedAt);
    const topologies = runTopologies(snapshot);
    const assignments = assignmentSummaries(snapshot, activity, observedAt);
    const sizingMetric = agentAtlasSizingMetrics.includes(
      input.metric as AgentAtlasSizingMetric,
    )
      ? (input.metric as AgentAtlasSizingMetric)
      : "activity";
    const scope: AgentAtlasScope = {
      teamId: text(
        snapshot.overview.team?.id,
        snapshot.rows.workdays[0]?.team_id,
      ),
      selectedDate: snapshot.overview.workdayContext.selectedDate,
      workdayIds: snapshot.rows.workdays.map((row) => text(row.id)),
      projectIds: [],
      groupIds: [],
      agentIds: [],
      activityProfiles: [],
      sizingMetric,
    };
    const replayCursor = cursor(activity, observedAt);
    const revision = createHash("sha256")
      .update(`${snapshot.overview.revision}:${replayCursor.cursor}`)
      .digest("hex")
      .slice(0, 24);
    return {
      revision,
      generatedAt: snapshot.overview.generatedAt,
      timeZone: snapshot.overview.timeZone,
      scope,
      topologies,
      nodeStates: nodeStates(
        snapshot,
        topologies,
        assignments,
        activity,
        observedAt,
      ),
      assignments,
      activity,
      playback: {
        mode:
          observedAt < snapshot.overview.generatedAt ? "historical" : "live",
        startedAt: snapshot.overview.operatingDay.start,
        endedAt: snapshot.overview.operatingDay.end,
        liveEdgeAt: snapshot.overview.generatedAt,
        cursor: replayCursor,
      },
      alerts: topologies.length
        ? []
        : [
            {
              id: "atlas-topology-empty",
              severity: "info",
              message:
                "No scheduled agent topology is available for this scope.",
            },
          ],
    };
  }

  delta(
    current: AgentAtlasProjection,
    priorRevision?: string | null,
  ): AgentAtlasDelta {
    const unchanged = priorRevision === current.revision;
    return {
      revision: current.revision,
      generatedAt: current.generatedAt,
      cursor: current.playback.cursor,
      nodeUpserts: unchanged ? [] : current.nodeStates,
      removedNodeIds: [],
      assignmentUpserts: unchanged ? [] : current.assignments,
      removedAssignmentIds: [],
      activity: unchanged ? [] : current.activity,
    };
  }
}
