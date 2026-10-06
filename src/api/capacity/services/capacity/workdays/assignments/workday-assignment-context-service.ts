import type { CapacityGovernanceDatabase } from "../../../../database.ts";
import { CapacityGovernanceError } from "../../../../database.ts";
import { canonicalArtifactManifestReferences } from "../../../../domain/artifact-manifest-evidence.ts";
import type { DurableCapacityWorkdayRun } from "../../../../repositories/capacity/workdays/workday-run.ts";

type JsonRecord = Record<string, unknown>;

export interface CapacityWorkdayArtifactRef extends JsonRecord {
  contentPath: string;
  model: string;
  artifactKind: string;
  subjectId: string;
  producedByAgent: string;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
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
    `SELECT assignment.id, assignment.lifecycle_output_json AS outputs_json
		   FROM capacity_provider_assignments assignment
		  WHERE assignment.team_id = ?
		    AND assignment.project_id = ?
		    AND assignment.work_day_id = ?
		    AND assignment.status = 'completed'
		  ORDER BY assignment.completed_at DESC, assignment.id ASC
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
      `assignment ${String(row.id)} lifecycle output`,
    );
    for (const candidate of canonicalArtifactManifestReferences(
      outputs,
      `assignment ${String(row.id)}`,
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
