import { createHash } from "node:crypto";
import {
  AGENT_ATLAS_TOPOLOGY_CONTRACT,
  type AgentAtlasTopologyEdge,
  type AgentAtlasTopologyNode,
  type AgentAtlasTopologySnapshot,
} from "@treeseed/sdk/agent-capacity";
import type { WorkdayPlanningGraphSnapshot } from "./workday-planning-graph-policy.ts";
import type { WorkdayProject } from "./workday-project-policy.ts";

function text(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function compileWorkdayAtlasTopology(input: {
  project: WorkdayProject;
  planning: WorkdayPlanningGraphSnapshot;
  immutableRef: string;
  capturedAt: string;
}): AgentAtlasTopologySnapshot {
  const projectId = text(input.project.id);
  const groups = input.planning.groups ?? {};
  const groupEdges = input.planning.groupEdges ?? {};
  const effectiveGroups = (direct: string[]) => {
    const values = new Set(direct);
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of Object.values(groupEdges)) {
        if (
          edge.propagatesMembership &&
          values.has(edge.fromGroupId) &&
          !values.has(edge.toGroupId)
        ) {
          values.add(edge.toGroupId);
          changed = true;
        }
      }
    }
    return [...values].sort();
  };
  const projectNodeId = `project:${projectId}`;
  const groupIds = [
    ...new Set([
      ...Object.keys(groups),
      ...input.planning.agents.flatMap((agent) => agent.groupIds),
    ]),
  ].sort();
  const nodes: AgentAtlasTopologyNode[] = [
    {
      id: projectNodeId,
      kind: "project",
      projectId,
      parentId: null,
      name: text(input.project.name, input.project.slug, projectId),
      slug: text(input.project.slug, projectId),
      capacityClass: null,
      activityProfile: null,
      directGroupIds: [],
      effectiveGroupIds: [],
      contentPath: null,
      metadata: {},
    },
  ];
  for (const groupId of groupIds) {
    const group = groups[groupId];
    const parent = Object.values(groupEdges).find(
      (edge) => edge.fromGroupId === groupId && edge.propagatesMembership,
    );
    nodes.push({
      id: `group:${projectId}:${groupId}`,
      kind: "group",
      projectId,
      parentId: parent
        ? `group:${projectId}:${parent.toGroupId}`
        : projectNodeId,
      name:
        group?.name ?? groupId.replace(/^group:/u, "").replace(/[-_]/gu, " "),
      slug: group?.slug ?? groupId.replace(/^group:/u, ""),
      capacityClass: null,
      activityProfile: null,
      directGroupIds: [],
      effectiveGroupIds: [],
      contentPath: null,
      metadata: { source: group ? "group-definition" : "agent-membership" },
    });
  }
  for (const agent of input.planning.agents)
    nodes.push({
      id: `agent:${projectId}:${agent.nodeId}`,
      kind: "agent",
      projectId,
		parentId: projectNodeId,
      name: agent.displayName,
      slug: agent.slug,
      capacityClass: agent.projectAgentClassSlug,
      activityProfile: agent.activityType,
      directGroupIds: agent.groupIds,
      effectiveGroupIds: effectiveGroups(agent.groupIds),
      contentPath: agent.contentPath,
		metadata: { planningNodeId: agent.nodeId, handler: agent.handler },
    });
  const edges: AgentAtlasTopologyEdge[] = [];
  for (const agent of input.planning.agents)
    for (const groupId of agent.groupIds)
      edges.push({
        id: `membership:${projectId}:${groupId}:${agent.nodeId}`,
        kind: "group-membership",
        fromNodeId: `group:${projectId}:${groupId}`,
        toNodeId: `agent:${projectId}:${agent.nodeId}`,
        contractId: null,
        direction: "relation",
        metadata: {},
      });
  for (const edge of input.planning.graph.edges)
    for (const contractId of edge.contracts)
      edges.push({
        id: `signal:${projectId}:${edge.fromNodeId}:${edge.toNodeId}:${contractId}`,
        kind: "declared-signal",
        fromNodeId: `agent:${projectId}:${edge.fromNodeId}`,
        toNodeId: `agent:${projectId}:${edge.toNodeId}`,
        contractId,
        direction: "output",
        metadata: {
          contract: input.planning.signalContracts[contractId] ?? null,
        },
      });
  const revision = createHash("sha256")
    .update(
      JSON.stringify({
        projectId,
        immutableRef: input.immutableRef,
        nodes,
        edges,
        planning: input.planning.revision,
      }),
    )
    .digest("hex");
  return {
    contract: AGENT_ATLAS_TOPOLOGY_CONTRACT,
    revision,
    projectId,
    immutableRef: input.immutableRef,
    capturedAt: input.capturedAt,
    planningGraphRevision: input.planning.revision,
    nodes,
    edges,
  };
}
