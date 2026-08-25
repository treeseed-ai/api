import type { CapacityGovernanceDatabase } from "../../../../database.ts";
import { CapacityGovernanceError } from "../../../../database.ts";
import { canonicalArtifactManifestReferences } from "../../../../domain/artifact-manifest-evidence.ts";
import type { DurableCapacityWorkdayRun } from "../../../../repositories/capacity/workdays/workday-run.ts";
import {
compileCapacityWorkdayAssignmentIntent,
type CapacityWorkdayAgent,
type CapacityWorkdayAssignmentIntent,
} from "../policy/workday-agent-policy.ts";
import type { WorkdayProject } from "../policy/workday-project-policy.ts";

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
  upstreamEvidence?: CapacityWorkdayGraphInput[];
  subjectPath?: string | null;
}

export interface CapacityWorkdayGraphInput extends JsonRecord {
  producerNodeId: string;
  kind: 'signal';
  contractId: string;
  recordId: string;
  metadata: JsonRecord;
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

function signalArtifactModel(input: CapacityWorkdayGraphInput,value: JsonRecord) {
	const explicit = text(value.model);
	if (explicit) return explicit;
	const subjectId = text(value.subjectId ?? input.subjectId);
	if (subjectId.startsWith('proposal:') || input.contractId === 'proposal-ready') return 'proposal';
	return '';
}

function signalArtifactKind(input: CapacityWorkdayGraphInput,value: JsonRecord) {
	const explicit = text(value.artifactKind ?? value.kind);
	if (explicit) return explicit;
	return input.contractId === 'proposal-ready' ? 'planning_proposal' : '';
}

function selectedObjective(run: DurableCapacityWorkdayRun): string {
  const refs = Array.isArray(run.parameters.objectiveRefs) ? run.parameters.objectiveRefs : [];
  return text(refs[0]);
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
		   JOIN capacity_workday_demands demand ON demand.assignment_id = assignment.id
		  WHERE assignment.team_id = ?
		    AND assignment.project_id = ?
		    AND demand.workday_run_id = ?
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

export async function resolveCapacityWorkdayAssignmentIntent(
  store: CapacityGovernanceDatabase,
  run: DurableCapacityWorkdayRun,
  project: WorkdayProject,
  agent: CapacityWorkdayAgent,
  graphInputs: CapacityWorkdayGraphInput[] = [],
): Promise<CapacityWorkdayResolvedIntent> {
  const configuredIntent = compileCapacityWorkdayAssignmentIntent(agent);
  const workdayPurpose = text(run.scenarioId);
  const objectiveRef = selectedObjective(run);
  const intent: CapacityWorkdayResolvedIntent = {
    ...configuredIntent,
	...(configuredIntent.subjectModel === "objective" && objectiveRef ? { subjectId: objectiveRef.replace(/^objective:/u, "") } : {}),
    objective: workdayPurpose
      ? `Workday purpose: ${workdayPurpose}\n\nAgent responsibility: ${configuredIntent.objective}`
      : configuredIntent.objective,
  };
  const needsArtifacts = intent.includeWorkdayArtifacts
    || (intent.subjectModel === "proposal" && !intent.subjectId);
  const signalArtifacts = graphInputs.flatMap((input) => {
    const value = { ...record(input.payload), ...record(input.metadata) };
    const paths = [value.contentPath, ...array(value.changedPaths), ...array(value.evidenceRefs).map((entry) => typeof entry === 'string' ? entry : record(entry).contentPath)].map((entry) => text(entry)).filter(Boolean);
    return paths.map((contentPath) => ({
      ...value, contentPath, model: signalArtifactModel(input,value), artifactKind: signalArtifactKind(input,value),
      subjectId: text(value.subjectId ?? input.subjectId), producedByAgent: text(value.producedByAgent ?? value.agentId),
    } satisfies CapacityWorkdayArtifactRef));
  });
  const artifacts = signalArtifacts.length ? signalArtifacts : needsArtifacts
    ? await listCapacityWorkdayContentArtifactRefs(
      store,
      run,
      project.id,
    )
    : [];
  if (intent.includeWorkdayArtifacts || signalArtifacts.length) {
    const relatedArtifacts = artifacts.slice(0, 24);
    if (intent.subjectModel !== "proposal" || intent.subjectId) return { ...intent, relatedArtifacts, upstreamEvidence: graphInputs };
  }
  if (intent.subjectModel !== "proposal" || intent.subjectId) return { ...intent, upstreamEvidence: graphInputs };
  const proposal =
    artifacts.find((artifact) => artifact.model === "proposal") ??
    artifacts.find((artifact) => artifact.artifactKind === "planning_proposal");
  if (!proposal) {
    return {
      ...intent,
      objective: `${intent.objective} No generated proposal exists yet, so create an objective-scoped planning note that states what proposal context is needed next.`,
      artifactKind: "planning_note",
      subjectModel: "objective",
      subjectId: objectiveRef.replace(/^objective:/u, "") || "core",
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
    relatedArtifacts: signalArtifacts.length ? signalArtifacts.slice(0, 24) : [proposal],
    upstreamEvidence: graphInputs,
  };
}
