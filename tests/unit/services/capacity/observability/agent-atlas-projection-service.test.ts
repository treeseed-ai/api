import { describe, expect, it } from "vitest";
import { AGENT_ATLAS_TOPOLOGY_CONTRACT } from "@treeseed/sdk/agent-capacity";
import { AgentAtlasProjectionService } from "../../../../../src/api/capacity/services/capacity/observability/agent-atlas-projection-service.ts";

const topology = {
  contract: AGENT_ATLAS_TOPOLOGY_CONTRACT,
  revision: "topology-1",
  projectId: "project-1",
  immutableRef: "a".repeat(40),
  capturedAt: "2026-08-08T12:00:00.000Z",
  planningGraphRevision: "graph-1",
  nodes: [
    {
      id: "project:project-1",
      kind: "project",
      projectId: "project-1",
      parentId: null,
      name: "Guide",
      slug: "guide",
      capacityClass: null,
      activityProfile: null,
      directGroupIds: [],
      effectiveGroupIds: [],
      contentPath: null,
      metadata: {},
    },
    {
      id: "agent:project-1:writer:planning:discovery",
      kind: "agent",
      projectId: "project-1",
      parentId: "project:project-1",
      name: "Guide Writer",
      slug: "writer",
      capacityClass: "editorial",
      activityProfile: "planning",
      directGroupIds: [],
      effectiveGroupIds: [],
      contentPath: "src/content/agents/writer.mdx",
      metadata: {},
    },
  ],
  edges: [],
};

function snapshot() {
  return {
    overview: {
      revision: "overview-1",
      generatedAt: "2026-08-08T14:00:00.000Z",
      timeZone: "America/New_York",
      operatingDay: {
        start: "2026-08-08T12:00:00.000Z",
        end: "2026-08-08T20:00:00.000Z",
      },
      workdayContext: {
        selectedDate: "2026-08-08",
        selectedWorkdayId: "run-1",
      },
    },
    rows: {
      projects: [{ id: "project-1", name: "Guide", slug: "guide" }],
      workdays: [
        {
          id: "run-1",
          team_id: "team-1",
          started_at: "2026-08-08T12:00:00.000Z",
          parameters_json: JSON.stringify({
            atlasTopologyByProjectId: { "project-1": topology },
          }),
        },
      ],
      events: [
        {
          id: "event-1",
          run_id: "run-1",
          event_index: 1,
          event_type: "assignment.started",
          status: "active",
          project_id: "project-1",
          assignment_id: "assignment-1",
          context_json: JSON.stringify({
            agentId: "writer",
            activityType: "planning",
          }),
          metadata_json: "{}",
          refs_json: "{}",
          created_at: "2026-08-08T12:30:00.000Z",
        },
        {
          id: "event-2",
          run_id: "run-1",
          event_index: 2,
          event_type: "artifact.published",
          status: "completed",
          project_id: "project-1",
          assignment_id: "assignment-1",
          context_json: JSON.stringify({ agentId: "writer" }),
          metadata_json: "{}",
          refs_json: JSON.stringify({
            artifacts: [{ path: "notes/result.mdx" }],
          }),
          created_at: "2026-08-08T13:30:00.000Z",
        },
      ],
      assignments: [
        {
          id: "assignment-1",
          project_id: "project-1",
          agent_id: "writer",
          status: "running",
          payload_json: JSON.stringify({ objective: "Draft guide" }),
        },
      ],
      executions: [],
      demands: [
        {
          assignment_id: "assignment-1",
          workday_run_id: "run-1",
          metadata_json: "{}",
        },
      ],
      usage: [],
      ledger: [],
    },
  };
}

describe("AgentAtlasProjectionService", () => {
  it("reduces durable events at the requested historical instant", () => {
    const projection = new AgentAtlasProjectionService().projection(
      snapshot() as never,
      { observedAt: "2026-08-08T13:00:00.000Z" },
    );
    expect(projection.playback.mode).toBe("historical");
    expect(projection.activity.map((item) => item.id)).toEqual(["event-1"]);
    expect(projection.topologies[0]?.immutableRef).toBe("a".repeat(40));
    expect(projection.nodeStates[0]?.progressPercent).toBeNull();
  });
  it("keeps event ordering and evidence at the live edge", () => {
    const projection = new AgentAtlasProjectionService().projection(
      snapshot() as never,
    );
    expect(projection.activity.map((item) => item.sequence)).toEqual([1, 2]);
    expect(projection.activity[1]?.artifactRefs).toEqual([
      { path: "notes/result.mdx" },
    ]);
    expect(projection.playback.cursor.positions).toEqual({ "run-1": 2 });
  });
  it("keeps conflicting frozen project revisions as explicit node variants", () => {
    const value = snapshot();
    value.rows.workdays.push({
      ...value.rows.workdays[0],
      id: "run-2",
      parameters_json: JSON.stringify({
        atlasTopologyByProjectId: {
          "project-1": {
            ...topology,
            revision: "topology-2",
            immutableRef: "b".repeat(40),
          },
        },
      }),
    });
    const projection = new AgentAtlasProjectionService().projection(
      value as never,
    );
    expect(projection.topologies).toHaveLength(2);
    expect(
      new Set(
        projection.topologies
          .flatMap((item) => item.nodes)
          .filter((item) => item.kind === "agent")
          .map((item) => item.id),
      ).size,
    ).toBe(2);
    expect(
      projection.topologies
        .flatMap((item) => item.nodes)
        .filter((item) => item.kind === "agent")
        .every((item) => /@[a-f0-9]{8}$/u.test(item.id)),
    ).toBe(true);
  });
});
