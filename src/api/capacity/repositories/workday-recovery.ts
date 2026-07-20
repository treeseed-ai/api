import { MAX_CAPACITY_PAGE_LIMIT } from "@treeseed/sdk/capacity-pagination";
import type {
  CapacityWorkdayRunRecord,
  CapacityWorkdayRunStatus,
} from "@treeseed/sdk/agent-capacity";
import { decodeDurableJsonObject } from "../durable-json.ts";
import type { CapacityGovernanceDatabase } from "../database.ts";
import { CapacityGovernanceError } from "../database.ts";
import { serializeCapacityWorkdayRunRow } from "./workday-run.ts";
import { canonicalArtifactManifestReferences } from "../domain/artifact-manifest-evidence.ts";

type Row = Record<string, unknown>;
export interface WorkdayModeRunEvidence {
  modeRunCount: number;
  succeededModeRuns: number;
  failedModeRuns: number;
  contentArtifactCount: number;
}
export interface RecoverableTerminalWorkday {
  run: CapacityWorkdayRunRecord;
  hasUnfinishedAssignments: boolean;
  hasOpenEnvelopes: boolean;
  missingDeadlineEvent: boolean;
}

function count(value: unknown, field: string): number {
  const parsed = Number(value ?? 0);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new CapacityGovernanceError(
      "capacity_workday_evidence_corrupt",
      `Workday evidence has invalid ${field}.`,
      500,
      { field, value },
    );
  return parsed;
}
function referenceKey(value: unknown): string {
  if (typeof value === "string" && value) return `string:${value}`;
  if (value && typeof value === "object" && !Array.isArray(value))
    return `object:${JSON.stringify(value)}`;
  throw new CapacityGovernanceError(
    "capacity_workday_evidence_corrupt",
    "Mode-run artifact reference must be a nonempty string or object.",
    500,
  );
}

export class CapacityWorkdayRecoveryRepository {
  constructor(private readonly database: CapacityGovernanceDatabase) {}

  async listRunning(
    teamId: string | null,
    afterId = "",
  ): Promise<CapacityWorkdayRunRecord[]> {
    await this.database.ensureInitialized();
    const rows = await this.database.all(
      `SELECT * FROM capacity_workday_runs WHERE status = 'running' AND id > ?${teamId ? " AND team_id = ?" : ""} ORDER BY id ASC LIMIT ?`,
      teamId
        ? [afterId, teamId, MAX_CAPACITY_PAGE_LIMIT]
        : [afterId, MAX_CAPACITY_PAGE_LIMIT],
    );
    return rows.map((row) => serializeCapacityWorkdayRunRow(row)!);
  }

  async modeRunEvidence(
    teamId: string,
    runId: string,
  ): Promise<WorkdayModeRunEvidence> {
    await this.database.ensureInitialized();
    const totals = await this.database.first(
      `SELECT COUNT(*) AS mode_run_count,
			COALESCE(SUM(CASE WHEN amr.status = 'succeeded' THEN 1 ELSE 0 END), 0) AS succeeded_mode_runs,
			COALESCE(SUM(CASE WHEN amr.status = 'failed' THEN 1 ELSE 0 END), 0) AS failed_mode_runs
			FROM agent_mode_runs amr JOIN capacity_provider_assignments pa ON pa.id = amr.provider_assignment_id AND pa.team_id = amr.team_id
			JOIN capacity_workday_demands demand ON demand.assignment_id = pa.id
			WHERE pa.team_id = ? AND demand.workday_run_id = ?`,
      [teamId, runId],
    );
    const references = new Set<string>();
    let cursor = "";
    while (true) {
      const rows = await this.database.all(
        `SELECT amr.id, amr.outputs_json FROM agent_mode_runs amr
				JOIN capacity_provider_assignments pa ON pa.id = amr.provider_assignment_id AND pa.team_id = amr.team_id
				JOIN capacity_workday_demands demand ON demand.assignment_id = pa.id
				WHERE pa.team_id = ? AND demand.workday_run_id = ? AND amr.status = 'succeeded' AND amr.id > ?
				ORDER BY amr.id ASC LIMIT ?`,
        [teamId, runId, cursor, MAX_CAPACITY_PAGE_LIMIT],
      );
      for (const row of rows) {
        const modeRunId = String(row.id ?? "");
        const outputs = decodeDurableJsonObject(row.outputs_json, {
          owner: "agent mode run",
          ownerId: modeRunId,
          column: "outputs_json",
        });
        for (const ref of canonicalArtifactManifestReferences(
          outputs,
          `mode run ${modeRunId}`,
        ))
          references.add(referenceKey(ref));
      }
      if (rows.length < MAX_CAPACITY_PAGE_LIMIT) break;
      cursor = String(rows.at(-1)?.id ?? "");
      if (!cursor)
        throw new CapacityGovernanceError(
          "capacity_workday_evidence_cursor_invalid",
          "Mode-run evidence cursor is missing.",
          500,
          { runId },
        );
    }
    return {
      modeRunCount: count(totals?.mode_run_count, "modeRunCount"),
      succeededModeRuns: count(
        totals?.succeeded_mode_runs,
        "succeededModeRuns",
      ),
      failedModeRuns: count(totals?.failed_mode_runs, "failedModeRuns"),
      contentArtifactCount: references.size,
    };
  }

  async completeDeadline(
    run: CapacityWorkdayRunRecord,
    status: "completed" | "degraded",
    summary: Row,
    metrics: Row,
    actual: Row,
    error: Row,
    now: string,
  ) {
    await this.database.ensureInitialized();
    const results = await this.database.batch([
      {
        query: `UPDATE capacity_workday_runs SET status = ?, completed_at = COALESCE(completed_at, ?), summary_json = ?, metrics_json = ?, actual_json = ?, error_json = ?, updated_at = ?
			WHERE id = ? AND team_id = ? AND status = 'running' RETURNING id`,
        params: [
          status,
          now,
          JSON.stringify(summary),
          JSON.stringify(metrics),
          JSON.stringify(actual),
          JSON.stringify(error),
          now,
          run.id,
          run.teamId,
        ],
      },
    ]);
    return Boolean((results as Array<{ results?: Row[] }>)[0]?.results?.[0]);
  }

  async listTerminal(
    teamId: string | null,
    afterId = "",
  ): Promise<CapacityWorkdayRunRecord[]> {
    await this.database.ensureInitialized();
    const rows = await this.database.all(
      `SELECT * FROM capacity_workday_runs WHERE status IN ('completed','cancelled','failed','degraded') AND id > ?${teamId ? " AND team_id = ?" : ""} ORDER BY id ASC LIMIT ?`,
      teamId
        ? [afterId, teamId, MAX_CAPACITY_PAGE_LIMIT]
        : [afterId, MAX_CAPACITY_PAGE_LIMIT],
    );
    return rows.map((row) => serializeCapacityWorkdayRunRow(row)!);
  }

  async recoveryState(
    run: CapacityWorkdayRunRecord,
  ): Promise<RecoverableTerminalWorkday> {
    await this.database.ensureInitialized();
    const [assignment, envelope, event] = await Promise.all([
      this.database.first(
        `SELECT assignment.id FROM capacity_provider_assignments assignment JOIN capacity_workday_demands demand ON demand.assignment_id = assignment.id WHERE assignment.team_id = ? AND demand.workday_run_id = ? AND assignment.status IN ('pending','leased','running','returned') LIMIT 1`,
        [run.teamId, run.id],
      ),
      this.database.first(
        `SELECT id FROM workday_capacity_envelopes WHERE team_id = ? AND workday_run_id = ? AND status NOT IN ('completed','cancelled','failed','degraded') LIMIT 1`,
        [run.teamId, run.id],
      ),
      this.database.first(
        `SELECT id FROM capacity_workday_events WHERE id = ? AND run_id = ? AND team_id = ? LIMIT 1`,
        [`workday-deadline:${run.id}`, run.id, run.teamId],
      ),
    ]);
    return {
      run,
      hasUnfinishedAssignments: Boolean(assignment),
      hasOpenEnvelopes: Boolean(envelope),
      missingDeadlineEvent:
        Boolean(run.actual.deadlineTerminalizedAt) && !event,
    };
  }
}
