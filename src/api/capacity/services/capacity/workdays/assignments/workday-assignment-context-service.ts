import type { CapacityGovernanceDatabase } from "../../../../database.ts";
import { CapacityGovernanceError } from "../../../../database.ts";
import type { DurableCapacityWorkdayRun } from "../../../../repositories/capacity/workdays/workday-run.ts";
import {
  compileCapacityWorkdayAssignmentIntent,
  type CapacityWorkdayAgent,
  type CapacityWorkdayAssignmentIntent,
} from "../policy/workday-agent-policy.ts";
import type { WorkdayProject } from "../policy/workday-project-policy.ts";
import { canonicalArtifactManifestReferences } from "../../../../domain/artifact-manifest-evidence.ts";

type JsonRecord = Record<string, unknown>;

export interface CapacityWorkdayArtifactRef extends JsonRecord {
  contentPath: string;
  model: string;
  artifactKind: string;
  subjectId: string;
  producedByAgent: string;
}

export interface CapacityWorkdayResolvedIntent extends CapacityWorkdayAssignmentIntent {
  relatedArtifact?: CapacityWorkdayArtifactRef | null;
  relatedArtifacts?: CapacityWorkdayArtifactRef[];
  subjectPath?: string | null;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function persistedObject(value: unknown, owner: string): JsonRecord {
  let decoded: unknown;
  try {
    decoded = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    throw new CapacityGovernanceError(
      "capacity_workday_artifact_json_invalid",
      `${owner} contains invalid JSON.`,
      500,
      { owner },
    );
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new CapacityGovernanceError(
      "capacity_workday_artifact_json_invalid",
      `${owner} must contain a JSON object.`,
      500,
      { owner },
    );
  }
  return decoded as JsonRecord;
}

export async function listCapacityWorkdayContentArtifactRefs(
  store: CapacityGovernanceDatabase,
  run: DurableCapacityWorkdayRun,
  projectId: string,
  limit = 200,
): Promise<CapacityWorkdayArtifactRef[]> {
  const parsedLimit = Number(limit);
  if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
    throw new CapacityGovernanceError(
      "capacity_workday_artifact_limit_invalid",
      "Artifact evidence limit must be positive and finite.",
      400,
    );
  }
  const rows = await store.all(
    `SELECT amr.id, amr.outputs_json
		   FROM agent_mode_runs amr
		   JOIN capacity_provider_assignments pa
		     ON pa.id = amr.provider_assignment_id
		    AND pa.team_id = amr.team_id
		   JOIN capacity_workday_demands demand ON demand.assignment_id = pa.id
		  WHERE pa.team_id = ?
		    AND pa.project_id = ?
		    AND demand.workday_run_id = ?
		    AND amr.status = 'succeeded'
		  ORDER BY amr.created_at DESC
		  LIMIT ?`,
    [
      run.teamId,
      projectId,
      run.id,
      Math.max(1, Math.min(Math.floor(parsedLimit), 500)),
    ],
  );
  const refs: CapacityWorkdayArtifactRef[] = [];
  for (const row of rows) {
    const outputs = persistedObject(
      row.outputs_json,
      `mode run ${String(row.id)} outputs`,
    );
    for (const candidate of canonicalArtifactManifestReferences(
      outputs,
      `mode run ${String(row.id)}`,
    )) {
      const ref = record(candidate);
      const contentPath = text(ref.contentPath);
      if (!contentPath) continue;
      refs.push({
        ...ref,
        contentPath,
        model: text(ref.model),
        artifactKind: text(ref.artifactKind ?? ref.kind),
        subjectId: text(ref.subjectId),
        producedByAgent: text(ref.producedByAgent ?? ref.agentId),
      });
    }
  }
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.model}:${ref.artifactKind}:${ref.contentPath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function resolveCapacityWorkdayAssignmentIntent(
  store: CapacityGovernanceDatabase,
  run: DurableCapacityWorkdayRun,
  project: WorkdayProject,
  agent: CapacityWorkdayAgent,
): Promise<CapacityWorkdayResolvedIntent> {
  const configuredIntent = compileCapacityWorkdayAssignmentIntent(agent);
  const workdayPurpose = text(run.scenarioId);
  const intent: CapacityWorkdayResolvedIntent = {
    ...configuredIntent,
    objective: workdayPurpose
      ? `Workday purpose: ${workdayPurpose}\n\nAgent responsibility: ${configuredIntent.objective}`
      : configuredIntent.objective,
  };
  if (intent.includeWorkdayArtifacts) {
    const artifacts = await listCapacityWorkdayContentArtifactRefs(
      store,
      run,
      project.id,
    );
    return { ...intent, relatedArtifacts: artifacts.slice(0, 24) };
  }
  if (intent.subjectModel !== "proposal" || intent.subjectId) return intent;
  const artifacts = await listCapacityWorkdayContentArtifactRefs(
    store,
    run,
    project.id,
  );
  const proposal =
    artifacts.find((artifact) => artifact.model === "proposal") ??
    artifacts.find((artifact) => artifact.artifactKind === "planning_proposal");
  if (!proposal) {
    return {
      ...intent,
      objective: `${intent.objective} No generated proposal exists yet, so create an objective-scoped planning note that states what proposal context is needed next.`,
      artifactKind: "planning_note",
      subjectModel: "objective",
      subjectId: "core",
    };
  }
  const proposalId = proposal.contentPath.replace(
    /^.*\/([^/]+)\.(md|mdx)$/u,
    "$1",
  );
  return {
    ...intent,
    subjectId: proposalId,
    subjectPath: proposal.contentPath,
    relatedArtifact: proposal,
  };
}
