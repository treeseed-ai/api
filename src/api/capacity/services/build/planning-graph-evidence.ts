import type { PlanningGraphNodeEvidence,PlanningGraphEvidenceReference } from '@treeseed/sdk/agent-capacity';
import type { CapacityGovernanceDatabase } from '../../database.ts';
import { decodeDurableJsonObject } from '../../durable-json.ts';
import type { DurableCapacityWorkdayRun } from '../../repositories/capacity/workdays/workday-run.ts';

type Row = Record<string, unknown>;

function text(value: unknown): string { return typeof value === 'string' ? value : ''; }

function reference(row: Row): PlanningGraphEvidenceReference {
	return {
		contractId: text(row.contract_id).replace(/_/gu, '-'),
		recordId: text(row.id),
		subjectId: text(row.subject_id) || null,
		payload: decodeDurableJsonObject(row.payload_json, { owner: 'agent signal', ownerId: text(row.id), column: 'payload_json' }),
		metadata: {
			assignmentId: row.assignment_id ?? null,
			commitSha: row.commit_sha ?? null,
			immutableRef: row.immutable_ref ?? null,
			digest: row.digest ?? null,
			evidenceRef: row.evidence_ref ?? null,
			causationId: row.causation_id,
			correlationId: row.correlation_id,
		},
	};
}

export async function loadPlanningGraphEvidence(
	store: CapacityGovernanceDatabase,
	run: DurableCapacityWorkdayRun,
	projectId: string,
): Promise<PlanningGraphNodeEvidence[]> {
	const rows = await store.all(`SELECT signal.*, demand.agent_id, demand.activity_type, demand.metadata_json AS demand_metadata_json
		FROM agent_signals signal
		LEFT JOIN capacity_workday_demands demand ON demand.assignment_id = signal.assignment_id
		WHERE signal.team_id = ? AND signal.project_id = ? AND signal.workday_run_id = ?
		ORDER BY signal.created_at ASC, signal.id ASC LIMIT 2000`, [run.teamId, projectId, run.id]);
	const grouped = new Map<string, PlanningGraphEvidenceReference[]>();
	for (const row of rows) {
		const demandMetadata = row.demand_metadata_json ? decodeDurableJsonObject(row.demand_metadata_json, { owner:'workday demand',ownerId:text(row.assignment_id),column:'metadata_json' }) : {};
		const nodeId = text(demandMetadata.planningGraphNodeId) || (row.agent_id && row.activity_type ? `${String(row.agent_id)}:${String(row.activity_type)}` : '$external');
		grouped.set(nodeId, [...(grouped.get(nodeId) ?? []), reference(row)]);
	}
	return [...grouped].map(([nodeId, references]) => ({ nodeId, references }));
}

export function selectedPlanningGraphInputs(evidence: PlanningGraphNodeEvidence[]) {
	return evidence.flatMap((entry) => entry.references.map((signal) => ({
		producerNodeId: entry.nodeId,
		kind: 'signal',
		contractId: signal.contractId,
		recordId: signal.recordId,
		subjectId: signal.subjectId ?? null,
		payload: signal.payload ?? {},
		metadata: signal.metadata ?? {},
	})));
}
