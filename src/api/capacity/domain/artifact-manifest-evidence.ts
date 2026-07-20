import { CapacityGovernanceError } from "../database.ts";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

export function canonicalArtifactManifestReferences(
  output: unknown,
  owner: string,
): JsonRecord[] {
  const root = record(output);
  if (!root)
    throw new CapacityGovernanceError(
      "capacity_artifact_evidence_corrupt",
      `${owner} output must be an object.`,
      500,
      { owner },
    );
  if (root.artifactManifest === undefined || root.artifactManifest === null)
    return [];
  const manifest = record(root.artifactManifest);
  if (!manifest)
    throw new CapacityGovernanceError(
      "capacity_artifact_evidence_corrupt",
      `${owner} artifact manifest must be an object.`,
      500,
      { owner },
    );
  if (manifest.contentReferences === undefined) return [];
  if (!Array.isArray(manifest.contentReferences))
    throw new CapacityGovernanceError(
      "capacity_artifact_evidence_corrupt",
      `${owner} artifact manifest contentReferences must be an array.`,
      500,
      { owner },
    );
  return manifest.contentReferences.map((reference, index) => {
    const parsed = record(reference);
    if (!parsed)
      throw new CapacityGovernanceError(
        "capacity_artifact_evidence_corrupt",
        `${owner} artifact manifest content reference ${index} must be an object.`,
        500,
        { owner, index },
      );
    return parsed;
  });
}
