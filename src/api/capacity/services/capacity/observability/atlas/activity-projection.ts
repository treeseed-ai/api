import type { AgentAtlasActivityItem, AgentAtlasEventCategory } from "@treeseed/sdk/agent-capacity";

type Row = Record<string, unknown>;

function record(value: unknown): Row {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Row;
  if (typeof value === "string") {
    try { return record(JSON.parse(value)); } catch { return {}; }
  }
  return {};
}

function text(...values: unknown[]) {
  return String(values.find((value) => typeof value === "string" && value) ?? "");
}

function iso(value: unknown, fallback: string) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function category(eventType: string): AgentAtlasEventCategory {
  const value = eventType.toLowerCase();
  if (value.includes("question")) return "question";
  if (value.includes("proposal")) return "proposal";
  if (value.includes("estimate")) return "estimate";
  if (value.includes("fail") || value.includes("error") || value.includes("blocked")) return "failure";
  if (value.includes("assignment")) return "assignment";
  if (value.includes("artifact") || value.includes("content")) return "artifact";
  if (value.includes("signal")) return "signal";
  if (value.includes("tool")) return "tool";
  if (value.includes("usage") || value.includes("settle") || value.includes("ledger")) return "usage";
  if (value.includes("message") || value.includes("discussion")) return "message";
  if (value.includes("note")) return "note";
  return "execution";
}

export function projectAgentAtlasActivity(row: Row): AgentAtlasActivityItem {
  const context = record(row.context_json ?? row.context);
  const refs = record(row.refs_json ?? row.refs);
  const metadata = record(row.metadata_json ?? row.metadata);
  const eventType = text(row.event_type, row.eventType, "event");
  const status = text(row.status);
  return {
    id: text(row.id),
    workdayId: text(row.run_id, row.runId),
    sequence: Number(row.event_index ?? row.eventIndex) || 0,
    timestamp: iso(row.created_at ?? row.createdAt, new Date(0).toISOString()),
    category: category(eventType),
    direction: eventType.includes("requested") || eventType.includes("received")
      ? "input"
      : eventType.includes("published") || eventType.includes("completed")
        ? "output"
        : "internal",
    severity: ["failed", "error"].includes(status) ? "error" : status === "warning" ? "warning" : "info",
    summary: text(row.message, row.title, eventType),
    projectId: text(row.project_id, row.projectId) || null,
    agentId: text(context.agentId) || null,
    activityProfile: text(context.activityType) || null,
    signalContractId: text(context.signalContractId, metadata.contractId) || null,
    assignmentId: text(row.assignment_id, row.assignmentId) || null,
    artifactRefs: Array.isArray(refs.artifacts) ? refs.artifacts.map(record) : [],
    metadata: { eventType, ...metadata },
  };
}
