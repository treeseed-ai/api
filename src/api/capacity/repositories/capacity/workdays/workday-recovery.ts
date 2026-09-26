import { assignmentResultSchema, type CapacityWorkdayRunRecord } from '@treeseed/sdk/agent-capacity';
import { MAX_CAPACITY_PAGE_LIMIT } from "@treeseed/sdk/capacity-pagination";
import type { CapacityGovernanceDatabase } from "../../../database.ts";
import { CapacityGovernanceError } from "../../../database.ts";
import { decodeDurableJsonObject } from "../../../durable-json.ts";
import { serializeCapacityWorkdayRunRow } from "./workday-run.ts";

type Row = Record<string, unknown>;
export interface WorkdayAssignmentEvidence {
  contentArtifactCount: number;
  requiredContentOutcomeAssignments: number;
  integratedContentOutcomeAssignments: number;
  abandonedContentOutcomeAssignments: number;
  unresolvedContentOutcomeAssignments: number;
}
export interface RecoverableTerminalWorkday {
  run: CapacityWorkdayRunRecord;
  hasUnfinishedAssignments: boolean;
  hasReadyNodes: boolean;
  missingDeadlineEvent: boolean;
}

function referenceKey(value: unknown): string {
  if (typeof value === "string" && value) return `string:${value}`;
  if (value && typeof value === "object" && !Array.isArray(value))
    return `object:${JSON.stringify(value)}`;
  throw new CapacityGovernanceError(
    "capacity_workday_evidence_corrupt",
    "Assignment artifact reference must be a nonempty string or object.",
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

  async assignmentEvidence(
    teamId: string,
    runId: string,
  ): Promise<WorkdayAssignmentEvidence> {
    await this.database.ensureInitialized();
    const references = new Set<string>();
	const contentOutcomes = new Set<string>();
    let cursor = "";
    while (true) {
      const rows = await this.database.all(
		`SELECT id, assignment_result_json FROM capacity_provider_assignments
				WHERE team_id = ? AND work_day_id = ? AND status = 'completed' AND id > ?
				ORDER BY id ASC LIMIT ?`,
        [teamId, runId, cursor, MAX_CAPACITY_PAGE_LIMIT],
      );
      for (const row of rows) {
        const assignmentId = String(row.id ?? "");
        const value = decodeDurableJsonObject(row.assignment_result_json, {
          owner: 'capacity provider assignment',
          ownerId: assignmentId,
          column: 'assignment_result_json',
        });
        const result = assignmentResultSchema.safeParse(value);
        if (!result.success || result.data.assignmentId !== assignmentId) throw new CapacityGovernanceError(
          'capacity_workday_evidence_corrupt', `Assignment ${assignmentId} has no valid immutable result.`, 500);
        for (const ref of result.data.references) if (ref.kind === 'treedx') {
          references.add(referenceKey(ref));
          contentOutcomes.add(assignmentId);
        }
      }
      if (rows.length < MAX_CAPACITY_PAGE_LIMIT) break;
      cursor = String(rows.at(-1)?.id ?? "");
      if (!cursor)
        throw new CapacityGovernanceError(
          "capacity_workday_evidence_cursor_invalid",
          "Assignment evidence cursor is missing.",
          500,
          { runId },
        );
    }
	const integrated = new Set<string>(); const abandoned = new Set<string>(); let auditCursor = '';
	while (contentOutcomes.size) {
	  const rows = await this.database.all(`SELECT audit.id,audit.target_id,audit.event_type FROM audit_events audit
		JOIN capacity_provider_assignments pa ON pa.id = audit.target_id AND pa.team_id = ?
		WHERE pa.work_day_id = ?
		AND audit.target_type = 'capacity_provider_assignment' AND audit.event_type IN ('assignment.content.integrated','assignment.content.abandoned')
		AND audit.id > ? ORDER BY audit.id ASC LIMIT ?`,[teamId,runId,auditCursor,MAX_CAPACITY_PAGE_LIMIT]);
	  for(const row of rows){const assignmentId=String(row.target_id??'');if(!contentOutcomes.has(assignmentId))continue;if(row.event_type==='assignment.content.integrated')integrated.add(assignmentId);else abandoned.add(assignmentId);}
	  if(rows.length<MAX_CAPACITY_PAGE_LIMIT)break;auditCursor=String(rows.at(-1)?.id??'');
	  if(!auditCursor)throw new CapacityGovernanceError('capacity_workday_evidence_cursor_invalid','Content outcome evidence cursor is missing.',500,{runId});
	}
    return {
      contentArtifactCount: references.size,
	  requiredContentOutcomeAssignments: contentOutcomes.size,
	  integratedContentOutcomeAssignments: integrated.size,
	  abandonedContentOutcomeAssignments: abandoned.size,
	  unresolvedContentOutcomeAssignments: [...contentOutcomes].filter((id)=>!integrated.has(id)).length,
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
    const [assignment, readyNode, event] = await Promise.all([
      this.database.first(
		`SELECT assignment.id FROM capacity_provider_assignments assignment
		  WHERE assignment.team_id = ? AND assignment.work_day_id = ? AND assignment.status IN ('pending','leased','running','returned') LIMIT 1`,
        [run.teamId, run.id],
      ),
      this.database.first(
        `SELECT id FROM execution_nodes WHERE team_id = ? AND workday_id = ? AND status = 'ready' LIMIT 1`,
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
      hasReadyNodes: Boolean(readyNode),
      missingDeadlineEvent:
        Boolean(run.actual.deadlineTerminalizedAt) && !event,
    };
  }
}
