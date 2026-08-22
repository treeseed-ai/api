import type { Context, Hono } from "hono";
import { AgentAtlasProjectionService } from "../../../services/capacity/observability/agent-atlas-projection-service.ts";
import { AgentLabProjectionService } from "../../../services/capacity/observability/agent-lab-projection-service.ts";
import type { WorkdayRouteDependencies } from "../workday-route-dependencies.ts";

function text(value: unknown, fallback = "") {
  return typeof value === "string" && value ? value : fallback;
}
function record(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  if (typeof value === "string")
    try {
      return record(JSON.parse(value));
    } catch {
      return {};
    }
  return {};
}
function timeZone(value: unknown) {
  const candidate = text(value, "UTC");
  try {
    new Intl.DateTimeFormat("en", { timeZone: candidate }).format();
    return candidate;
  } catch {
    return "UTC";
  }
}

async function load(c: Context, dependencies: WorkdayRouteDependencies) {
  const access = await dependencies.read(c);
  if (access.response) return { response: access.response };
  const preference = access.principal?.id
    ? await dependencies.store.first(
        "SELECT time_zone FROM user_preferences WHERE user_id = ? LIMIT 1",
        [access.principal.id],
      )
    : null;
  const snapshot = await new AgentLabProjectionService(
    dependencies.store,
  ).snapshot(
    c.req.param("teamId"),
    timeZone(preference?.time_zone),
    new Date(),
    { date: c.req.query("date"), workdayId: c.req.query("workday") },
  );
  if (!snapshot) return { response: dependencies.notFound(c, "Unknown team.") };
  return { snapshot, access };
}

function response(c: Context, payload: unknown, revision: string) {
  const etag = `"${revision}"`;
  if (c.req.header("If-None-Match") === etag)
    return new Response(null, {
      status: 304,
      headers: { etag, "cache-control": "private, no-cache" },
    });
  return c.json({ ok: true, payload }, 200, {
    etag,
    "cache-control": "private, no-cache",
  });
}

export function installOperatorAgentAtlasRoutes(
  app: Hono,
  dependencies: WorkdayRouteDependencies,
) {
  app.get("/v1/teams/:teamId/agent-lab/atlas", async (c) => {
    const context = await load(c, dependencies);
    if (context.response) return context.response;
    const projection = new AgentAtlasProjectionService().projection(
      context.snapshot!,
      {
        metric: c.req.query("metric"),
        cursor: c.req.query("cursor"),
        observedAt: c.req.query("at"),
      },
    );
    return response(c, projection, projection.revision);
  });

  app.get("/v1/teams/:teamId/agent-lab/atlas/delta", async (c) => {
    const context = await load(c, dependencies);
    if (context.response) return context.response;
    const service = new AgentAtlasProjectionService();
    const projection = service.projection(context.snapshot!, {
      metric: c.req.query("metric"),
      cursor: c.req.query("cursor"),
      observedAt: c.req.query("at"),
    });
    return response(
      c,
      service.delta(projection, c.req.query("revision")),
      projection.revision,
    );
  });

  app.get("/v1/teams/:teamId/agent-lab/atlas/events", async (c) => {
    const context = await load(c, dependencies);
    if (context.response) return context.response;
    const projection = new AgentAtlasProjectionService().projection(
      context.snapshot!,
      { cursor: c.req.query("cursor") },
    );
    const selected = new Set(
      (c.req.query("category") ?? "").split(",").filter(Boolean),
    );
    const severities = new Set(
      (c.req.query("severity") ?? "").split(",").filter(Boolean),
    );
    const items = projection.activity.filter(
      (item) =>
        (!selected.size || selected.has(item.category)) &&
        (!severities.size || severities.has(item.severity)),
    );
    return response(
      c,
      {
        items,
        cursor: projection.playback.cursor,
        revision: projection.revision,
      },
      projection.revision,
    );
  });

  app.get(
    "/v1/teams/:teamId/agent-lab/atlas/details/:kind/:entityId",
    async (c) => {
      const context = await load(c, dependencies);
      if (context.response) return context.response;
      const diagnostic = c.req.query("detail") === "diagnostic";
      if (diagnostic) {
        const access = await dependencies.diagnose(c);
        if (access.response) return access.response;
      }
      const kind = c.req.param("kind");
      const id = decodeURIComponent(c.req.param("entityId"));
      const projection = new AgentAtlasProjectionService().projection(
        context.snapshot!,
        { observedAt: c.req.query("at") },
      );
      const nodes = projection.topologies.flatMap((topology) =>
        topology.nodes.map((node) => ({ ...node, topology })),
      );
      const edges = projection.topologies.flatMap((topology) =>
        topology.edges.map((edge) => ({ ...edge, topology })),
      );
      const node = nodes.find(
        (item) =>
          item.id.replace(/@[a-f0-9]{8}$/u, "") === id && item.kind === kind,
      );
      const edge =
        kind === "signal"
          ? edges.find(
              (item) =>
                item.id.replace(/@[a-f0-9]{8}$/u, "") === id ||
                item.contractId === id,
            )
          : null;
      const event =
        kind === "event"
          ? projection.activity.find((item) => item.id === id)
          : null;
      const assignment =
        kind === "assignment"
          ? projection.assignments.find((item) => item.id === id)
          : null;
      let durable: Record<string, unknown> | null = null;
      if (kind === "proposal")
        durable = await dependencies.store.first(
          "SELECT * FROM governance_proposals WHERE id = ? AND team_id = ? LIMIT 1",
          [id, c.req.param("teamId")],
        );
      if (kind === "decision")
        durable = await dependencies.store.first(
          "SELECT * FROM governance_decisions WHERE id = ? AND team_id = ? LIMIT 1",
          [id, c.req.param("teamId")],
        );
      const artifact =
        kind === "artifact"
          ? context.snapshot!.artifacts.find((item) =>
              [item.id, item.receiptId, item.path, item.contentPath]
                .map(String)
                .includes(id),
            )
          : null;
      const data = node ?? edge ?? event ?? assignment ?? durable ?? artifact;
      if (!data)
        return dependencies.notFound(
          c,
          "Atlas record is outside the selected scope.",
        );
      const selected = record(data);
      const topology = record(selected.topology);
      const projectId = text(
        selected.projectId,
        selected.project_id,
        topology.projectId,
      );
      const designed =
        kind === "agent"
          ? context.snapshot!.rows.agents.find(
              (item) =>
                text(item.project_id) === projectId &&
                text(item.slug, item.agentSlug, item.id) ===
                  text(selected.slug),
            )
          : null;
      const relatedAssignments =
        kind === "agent"
          ? projection.assignments.filter(
              (item) =>
                item.projectId === projectId &&
                item.agentId === text(selected.slug),
            )
          : [];
      const observed =
        kind === "agent"
          ? projection.activity.filter(
              (item) =>
                item.projectId === projectId &&
                item.agentId === text(selected.slug),
            )
          : kind === "signal"
            ? projection.activity.filter(
                (item) => item.signalContractId === text(selected.contractId),
              )
            : [];
      const summary = {
        status: text(selected.status, selected.severity, "observed"),
        project: projectId || "portfolio",
        observedAt: projection.playback.cursor.observedAt,
      };
      return c.json({
        ok: true,
        payload: {
          id,
          kind,
          title: text(
            selected.name,
            selected.summary,
            selected.title,
            selected.contractId,
            id,
          ),
          description: text(
            selected.description,
            selected.summary,
            selected.capacityClass,
            selected.kind,
          ),
          status: text(selected.status, selected.severity, "observed"),
          projectId,
          summary,
          data: diagnostic ? {
            ...selected,
            definition: designed,
            assignments: relatedAssignments,
            observed,
          } : {},
          evidence: diagnostic ? {
            topologyRevision: topology.revision ?? null,
            immutableRef: topology.immutableRef ?? null,
            replayCursor: projection.playback.cursor,
          } : undefined,
        },
      });
    },
  );

  app.get("/v1/teams/:teamId/agent-lab/atlas/events/stream", async (c) => {
    const access = await dependencies.read(c);
    if (access.response) return access.response;
    const preference = access.principal?.id
      ? await dependencies.store.first(
          "SELECT time_zone FROM user_preferences WHERE user_id = ? LIMIT 1",
          [access.principal.id],
        )
      : null;
    const accountTimeZone = timeZone(preference?.time_zone);
    const teamId = c.req.param("teamId");
    const requestedWorkday = c.req.query("workday");
    let revision = c.req.query("revision") ?? "";
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const deadline = Date.now() + 25_000;
        while (Date.now() < deadline && !c.req.raw.signal.aborted) {
          const snapshot = await new AgentLabProjectionService(
            dependencies.store,
          ).snapshot(teamId, accountTimeZone, new Date(), {
            date: c.req.query("date"),
            workdayId: requestedWorkday,
          });
          if (snapshot) {
            const projection = new AgentAtlasProjectionService().projection(
              snapshot,
            );
            const delta = new AgentAtlasProjectionService().delta(
              projection,
              revision,
            );
            if (projection.revision !== revision) {
              controller.enqueue(
                encoder.encode(
                  `id: ${projection.revision}\nevent: atlas.delta\ndata: ${JSON.stringify(delta)}\n\n`,
                ),
              );
              revision = projection.revision;
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, private",
        connection: "keep-alive",
      },
    });
  });

  app.get("/v1/teams/:teamId/agent-lab/atlas/assignment-graphs", async (c) => {
    const access = await dependencies.diagnose(c);
    if (access.response) return access.response;
    const teamId = c.req.param("teamId");
    const projectId = c.req.query("project");
    const projectClause = projectId ? " AND graph.project_id = ?" : "";
    const values = projectId ? [teamId, projectId] : [teamId];
    const [rows, assignmentRows] = await Promise.all([
      dependencies.store.all(
        `SELECT graph.*, decision.proposal_id FROM decision_assignment_graphs graph LEFT JOIN governance_decisions decision ON decision.id = graph.decision_id WHERE graph.team_id = ?${projectClause} ORDER BY graph.updated_at DESC`,
        values,
      ),
      dependencies.store.all(
        `SELECT id, project_id, status, payload_json FROM capacity_provider_assignments WHERE team_id = ?${projectId ? " AND project_id = ?" : ""} ORDER BY created_at`,
        values,
      ),
    ]);
    const assignments = assignmentRows.map((row) => {
      const payload = record(row.payload_json);
      const planning = record(payload.planningGraph);
      const progress = Number(payload.progressPercent);
      return {
        id: String(row.id),
        status: String(row.status),
        graphId: text(planning.graphId, payload.assignmentGraphId),
        nodeId: text(planning.nodeId),
        progressPercent: Number.isFinite(progress)
          ? Math.max(0, Math.min(100, progress))
          : null,
      };
    });
    const payload = rows.map((row) => {
      const graph = record(row.graph_json);
      const nodes = Array.isArray(graph.nodes) ? graph.nodes.map(record) : [];
      return {
        ...graph,
        id: row.id,
        projectId: row.project_id,
        decisionId: row.decision_id,
        proposalId: row.proposal_id ?? null,
        status: row.status,
        active: Number(row.active) === 1,
        nodes: nodes.map((node) => {
          const linked = assignments.filter(
            (assignment) =>
              assignment.graphId === String(row.id) &&
              assignment.nodeId === String(node.id),
          );
          const progress = linked
            .map((assignment) => assignment.progressPercent)
            .filter((value): value is number => value !== null);
          return {
            ...node,
            assignmentIds: linked.map((assignment) => assignment.id),
            status: linked.length
              ? linked.every((assignment) => assignment.status === "completed")
                ? "completed"
                : linked.some((assignment) => assignment.status === "running")
                  ? "running"
                  : linked[0].status
              : node.status,
            progressPercent: progress.length
              ? Math.round(
                  progress.reduce((sum, value) => sum + value, 0) /
                    progress.length,
                )
              : null,
          };
        }),
      };
    });
    return c.json({ ok: true, payload });
  });
}
