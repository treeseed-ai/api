import type { ResearchWorkflowRecord } from '@treeseed/sdk/agent-capacity';
import { validateResearchWorkflow } from '@treeseed/sdk/agent-capacity';
import type { CapacityGovernanceDatabase } from '../database.ts';
import { CapacityGovernanceError } from '../database.ts';
import { decodeDurableJsonObject } from '../durable-json.ts';

type Row = Record<string, unknown>;

function required(row: Row, column: string) {
	const value = row[column];
	if (typeof value !== 'string' || !value) throw new CapacityGovernanceError('research_workflow_corrupt', `Stored research workflow has invalid ${column}.`, 500, { id: row.id ?? null, column });
	return value;
}

export function serializeResearchWorkflowRow(row: Row | null): ResearchWorkflowRecord | null {
	if (!row) return null;
	const id = required(row, 'id');
	const stored = decodeDurableJsonObject(row.workflow_json, { owner: 'research workflow', ownerId: id, column: 'workflow_json' }) as unknown as ResearchWorkflowRecord;
	const workflow = {
		...stored, id, teamId: required(row, 'team_id'), projectId: required(row, 'project_id'), objectiveRef: required(row, 'objective_ref'),
		questionRef: required(row, 'question_ref'), status: required(row, 'status') as ResearchWorkflowRecord['status'],
		stateVersion: Number(row.state_version), createdAt: required(row, 'created_at'), updatedAt: required(row, 'updated_at'),
	};
	const validation = validateResearchWorkflow(workflow);
	if (!validation.ok) throw new CapacityGovernanceError('research_workflow_corrupt', 'Stored research workflow violates the SDK contract.', 500, { id, diagnostics: validation.diagnostics });
	return workflow;
}

function fingerprint(workflow: ResearchWorkflowRecord) {
	const { createdAt: _createdAt, updatedAt: _updatedAt, ...business } = workflow;
	return JSON.stringify(business);
}

export class ResearchWorkflowRepository {
	constructor(private readonly database: CapacityGovernanceDatabase) {}
	async get(id: string) { await this.database.ensureInitialized(); return serializeResearchWorkflowRow(await this.database.first('SELECT * FROM research_workflows WHERE id = ? LIMIT 1', [id])); }
	async getByIdempotency(projectId: string, idempotencyKey: string) { await this.database.ensureInitialized(); return serializeResearchWorkflowRow(await this.database.first('SELECT * FROM research_workflows WHERE project_id = ? AND idempotency_key = ? LIMIT 1', [projectId, idempotencyKey])); }
	async list(projectId: string, status?: string) {
		await this.database.ensureInitialized();
		const rows = await this.database.all(`SELECT * FROM research_workflows WHERE project_id = ?${status ? ' AND status = ?' : ''} ORDER BY updated_at DESC, id DESC LIMIT 100`, status ? [projectId, status] : [projectId]);
		return rows.map((row) => serializeResearchWorkflowRow(row)!);
	}
	async create(workflow: ResearchWorkflowRecord, idempotencyKey: string) {
		await this.database.run(`INSERT INTO research_workflows (id, team_id, project_id, objective_ref, question_ref, status, state_version, workflow_json, idempotency_key, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (project_id, idempotency_key) DO NOTHING`, [workflow.id, workflow.teamId, workflow.projectId, workflow.objectiveRef, workflow.questionRef, workflow.status, workflow.stateVersion, JSON.stringify(workflow), idempotencyKey, workflow.createdAt, workflow.updatedAt]);
		const persisted = await this.getByIdempotency(workflow.projectId, idempotencyKey);
		if (!persisted || fingerprint(persisted) !== fingerprint(workflow)) throw new CapacityGovernanceError('research_workflow_idempotency_conflict', 'Idempotency key is already bound to different research workflow input.', 409, { projectId: workflow.projectId, idempotencyKey });
		return persisted;
	}
	async advance(previous: ResearchWorkflowRecord, next: ResearchWorkflowRecord) {
		await this.database.batch([
			{ query: `UPDATE research_workflows SET status = ?, state_version = ?, workflow_json = ?, updated_at = ? WHERE id = ? AND state_version = ?`, params: [next.status, next.stateVersion, JSON.stringify(next), next.updatedAt, next.id, previous.stateVersion] },
			{ query: 'SELECT 1 / CASE WHEN EXISTS (SELECT 1 FROM research_workflows WHERE id = ? AND state_version = ?) THEN 1 ELSE 0 END AS research_workflow_cas_guard', params: [next.id, next.stateVersion] },
		]);
		const persisted = await this.get(next.id);
		if (!persisted || persisted.stateVersion !== next.stateVersion) throw new CapacityGovernanceError('research_workflow_state_conflict', 'Research workflow changed concurrently.', 409, { workflowId: next.id, expectedStateVersion: previous.stateVersion });
		return persisted;
	}
}
