import type { AgentAtlasWorkdaySummary } from "@treeseed/sdk/agent-capacity";

type Row = Record<string, unknown>;

function text(...values: unknown[]) {
  return String(values.find((value) => typeof value === "string" && value) ?? "");
}

function iso(value: unknown) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function assignmentCounts(assignments: Row[]) {
  const status = (row: Row) => text(row.status).toLowerCase();
  return {
    total: assignments.length,
    active: assignments.filter((row) => ["pending", "admitted", "leased", "queued", "running"].includes(status(row))).length,
    completed: assignments.filter((row) => status(row) === "completed").length,
    failed: assignments.filter((row) => ["failed", "expired", "returned"].includes(status(row))).length,
    cancelled: assignments.filter((row) => status(row) === "cancelled").length,
  };
}

function summaryMessage(title: string, status: string, counts: ReturnType<typeof assignmentCounts>) {
  const failures = counts.failed ? ` ${counts.failed} ${counts.failed === 1 ? "assignment needs" : "assignments need"} attention.` : "";
  if (status === "running") {
    if (counts.active) return `${title} is active with ${counts.active} ${counts.active === 1 ? "assignment" : "assignments"} in progress.`;
    return `${title} is active and waiting for eligible work or provider capacity.`;
  }
  if (status === "completed") return `${title} completed with ${counts.completed} successful ${counts.completed === 1 ? "assignment" : "assignments"}.${failures}`;
  if (status === "cancelled") return `${title} was cancelled.${failures}`;
  if (status === "degraded") return `${title} completed with incomplete or failed evidence.${failures}`;
  if (status === "failed") return `${title} failed.${failures}`;
  return `${title} is ${status || "not yet started"}.${failures}`;
}

export function projectAgentAtlasWorkdaySummary(input: {
  selectedWorkdayId: string | null;
  workdays: Row[];
  assignments: Row[];
  eventTotal: number;
}): AgentAtlasWorkdaySummary | null {
  if (!input.selectedWorkdayId) return null;
  const workday = input.workdays.find((row) => text(row.id) === input.selectedWorkdayId);
  if (!workday) return null;
  const title = text(workday.scenario_id, "Workday");
  const status = text(workday.status, "unknown");
  const counts = assignmentCounts(input.assignments);
  return {
    id: input.selectedWorkdayId,
    title,
    status,
    startedAt: iso(workday.started_at ?? workday.created_at),
    finishedAt: iso(workday.completed_at),
    assignments: counts,
    eventCount: input.eventTotal,
    message: summaryMessage(title, status, counts),
  };
}
