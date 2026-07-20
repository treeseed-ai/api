import { describe, expect, it, vi } from "vitest";
import { CapacityWorkdayRecoveryRepository } from "../../src/api/capacity/repositories/workday-recovery.ts";

describe("capacity workday recovery repository", () => {
  it("deduplicates artifact references while preserving strict evidence totals", async () => {
    const database = {
      ensureInitialized: vi.fn(async () => undefined),
      first: vi.fn(async () => ({
        mode_run_count: 2,
        succeeded_mode_runs: 1,
        failed_mode_runs: 1,
      })),
      all: vi.fn(async () => [
        {
          id: "mode-a",
          outputs_json: JSON.stringify({
            artifactManifest: {
              contentReferences: [
                { model: "notes", contentPath: "notes/research/a.mdx" },
              ],
            },
          }),
        },
      ]),
    } as never;
    await expect(
      new CapacityWorkdayRecoveryRepository(database).modeRunEvidence(
        "team-a",
        "run-a",
      ),
    ).resolves.toEqual({
      modeRunCount: 2,
      succeededModeRuns: 1,
      failedModeRuns: 1,
      contentArtifactCount: 1,
    });
  });

  it("fails closed when durable mode-run artifact evidence is malformed", async () => {
    const database = {
      ensureInitialized: vi.fn(async () => undefined),
      first: vi.fn(async () => ({
        mode_run_count: 1,
        succeeded_mode_runs: 1,
        failed_mode_runs: 0,
      })),
      all: vi.fn(async () => [{ id: "mode-a", outputs_json: "{broken" }]),
    } as never;
    await expect(
      new CapacityWorkdayRecoveryRepository(database).modeRunEvidence(
        "team-a",
        "run-a",
      ),
    ).rejects.toMatchObject({ code: "capacity_durable_json_invalid" });
  });
});
