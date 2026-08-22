import type {
  GovernanceGroup,
  GovernanceGroupEdge,
} from "@treeseed/sdk/agent-capacity";

const GROUP_CONTRACT = 'treeseed.group/v1';
const GROUP_EDGE_CONTRACT = 'treeseed.group-edge/v1';

export interface GroupAuthoringIntent {
  name: string;
  description: string;
  classification: string;
  aliases?: string[];
  parentGroupId?: string;
  coordination?: GovernanceGroup['coordination'];
}

function slug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function unique(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function compileGroupDefinition(input: {
  intent: GroupAuthoringIntent;
  contentRoot: string;
  existingId?: string;
}) {
  const groupSlug = slug(input.intent.name);
  if (!groupSlug) throw new Error("Group name must produce a stable identity.");
  const id = input.existingId ?? `group:${groupSlug}`;
  const group: GovernanceGroup = {
    contract: GROUP_CONTRACT,
    id,
    slug: groupSlug,
    name: input.intent.name.trim(),
    description: input.intent.description.trim(),
    classification: slug(input.intent.classification) || "team",
    aliases: unique(input.intent.aliases ?? []),
    status: "active",
    coordination: input.intent.coordination,
  };
  const parentGroupId = input.intent.parentGroupId?.trim();
  const edge: GovernanceGroupEdge | null = parentGroupId
    ? {
        contract: GROUP_EDGE_CONTRACT,
        id: `group-edge:${groupSlug}:${slug(parentGroupId)}`,
        fromGroupId: id,
        toGroupId: parentGroupId,
        predicate: "is-part-of",
        propagatesMembership: true,
      }
    : null;
  const root = input.contentRoot.replace(/^\/+|\/+$/gu, "");
  return {
    group,
    edge,
    groupPath: `${root}/groups/${groupSlug}.mdx`,
    edgePath: edge ? `${root}/group-edges/${groupSlug}.mdx` : null,
  };
}

export function validateGroupDefinition(value: unknown): {
  ok: boolean;
  diagnostics: Array<{ path: string; message: string }>;
} {
  const group =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Partial<GovernanceGroup>)
      : {};
  const diagnostics: Array<{ path: string; message: string }> = [];
  if (group.contract !== GROUP_CONTRACT)
    diagnostics.push({
      path: "contract",
      message: `Group contract must be ${GROUP_CONTRACT}.`,
    });
  for (const key of ["id", "slug", "name", "classification"] as const)
    if (typeof group[key] !== "string" || !group[key]?.trim())
      diagnostics.push({ path: key, message: `Group ${key} is required.` });
  if (group.status !== "active" && group.status !== "archived")
    diagnostics.push({
      path: "status",
      message: "Group status must be active or archived.",
    });
  const coordination = group.coordination as Record<string, unknown> | undefined;
  for (const forbidden of ["signals", "subscriptions", "models", "events"])
    if (coordination && coordination[forbidden] !== undefined)
      diagnostics.push({
        path: `coordination.${forbidden}`,
        message: "Groups coordinate eligible participants and governance; signal and content filters belong to activity-profile subscriptions.",
      });
  return { ok: diagnostics.length === 0, diagnostics };
}

export function validateGroupEdgeDefinition(value: unknown): {
  ok: boolean;
  diagnostics: Array<{ path: string; message: string }>;
} {
  const edge =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Partial<GovernanceGroupEdge>)
      : {};
  const diagnostics: Array<{ path: string; message: string }> = [];
  if (edge.contract !== GROUP_EDGE_CONTRACT)
    diagnostics.push({
      path: "contract",
      message: `Group edge contract must be ${GROUP_EDGE_CONTRACT}.`,
    });
  for (const key of ["id", "fromGroupId", "toGroupId", "predicate"] as const)
    if (typeof edge[key] !== "string" || !edge[key]?.trim())
      diagnostics.push({
        path: key,
        message: `Group edge ${key} is required.`,
      });
  if (edge.fromGroupId && edge.fromGroupId === edge.toGroupId)
    diagnostics.push({
      path: "toGroupId",
      message: "A group cannot contain itself.",
    });
  return { ok: diagnostics.length === 0, diagnostics };
}
