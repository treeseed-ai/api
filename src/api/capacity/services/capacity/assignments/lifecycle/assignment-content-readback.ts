import { assignmentResultSchema, type AssignmentResult } from '@treeseed/sdk/agent-capacity';
import { CapacityGovernanceError } from '../../../../database.ts';
import { resolveKnowledgeGatewayConnection } from '../../../../../knowledge/gateway-treedx-connection.ts';

type Store = { run(sql: string, params?: unknown[]): Promise<unknown>; all(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> };
type Scope = { id: string; teamId: string; projectId: string };
type Reference = Extract<AssignmentResult['references'][number], { kind: 'treedx' }>;

/** Operational integration consumes exact results; it does not publish their authoring branches. */
export async function verifyAssignmentContent(store: Store, scope: Scope, result: AssignmentResult,
	read: (reference: Reference) => Promise<{ resolvedRef?: string; files?: { path?: string; content?: unknown }[] }> = async (reference) => {
		const connection = await resolveKnowledgeGatewayConnection(store, { projectId: scope.projectId,
			write: false, authoringPaths: true, communicationPaths: true, readRefs: [reference.commit] });
		if (!connection || connection.repositoryId !== reference.repository) throw new CapacityGovernanceError(
			'assignment_content_repository_mismatch', 'Result content must belong to its authoritative project library.', 409);
		return connection.client.readRepositoryFiles({ repoId: reference.repository, ref: reference.commit,
			paths: [reference.path], encoding: 'utf8', parseFrontmatter: false, allowProtected: true });
	}) {
	if (result.assignmentId !== scope.id || result.status !== 'completed') throw new CapacityGovernanceError(
		'assignment_content_result_invalid', 'Content read-back requires this assignment’s completed canonical result.', 409);
	const references = result.references.filter((reference): reference is Reference => reference.kind === 'treedx');
	for (const reference of references) {
		if (reference.projectId !== scope.projectId) throw new CapacityGovernanceError(
			'assignment_content_project_mismatch', 'Result content cannot cross its assignment project.', 409);
		const observed = await read(reference);
		if (observed.resolvedRef !== reference.commit || !observed.files?.some((file) =>
			file.path === reference.path && typeof file.content === 'string')) throw new CapacityGovernanceError(
			'assignment_content_readback_failed', 'Result content failed exact commit/path read-back.', 502,
			{ assignmentId: scope.id, commit: reference.commit, path: reference.path });
	}
	return references;
}

export async function recordAssignmentContentIntegration(store: Store, scope: Scope, result: AssignmentResult, references: Reference[]) {
	if (!references.length) return;
	await store.run(`INSERT INTO audit_events (id,actor_type,actor_id,event_type,target_type,target_id,data_json,created_at)
		SELECT ?, 'service', 'assignment-result-readback', 'assignment.content.integrated', 'capacity_provider_assignment', ?, ?, ?
		WHERE EXISTS (SELECT 1 FROM capacity_provider_assignments WHERE id=? AND team_id=? AND project_id=?
			AND status='completed' AND assignment_result_json::jsonb->>'id'=?) ON CONFLICT (id) DO NOTHING`,
	[`assignment-content-integrated:${scope.id}:${result.id}`, scope.id, JSON.stringify({ resultId: result.id,
		references, publication: false }), new Date().toISOString(), scope.id, scope.teamId, scope.projectId, result.id]);
}

/** Retry the same result read-back after a crash between canonical completion and its receipt. */
export async function reconcileAssignmentContent(store: Store, teamId: string, workdayId?: string) {
	const rows = await store.all(`SELECT assignment.id,assignment.project_id,assignment.assignment_result_json
		FROM capacity_provider_assignments assignment WHERE assignment.team_id=? AND assignment.status='completed'
		AND EXISTS (SELECT 1 FROM jsonb_array_elements(assignment.assignment_result_json::jsonb->'references') reference WHERE reference->>'kind'='treedx')
		${workdayId ? 'AND assignment.work_day_id=?' : `AND EXISTS (SELECT 1 FROM agent_invocation_requests invocation
			WHERE invocation.id=assignment.invocation_id AND invocation.team_id=assignment.team_id AND invocation.status IN ('admitted','running'))`}
		AND NOT EXISTS (SELECT 1 FROM audit_events audit WHERE audit.target_id=assignment.id
			AND audit.target_type='capacity_provider_assignment' AND audit.event_type='assignment.content.integrated')
		ORDER BY assignment.id LIMIT 100`, workdayId ? [teamId, workdayId] : [teamId]);
	for (const row of rows) {
		const value = typeof row.assignment_result_json === 'string' ? JSON.parse(row.assignment_result_json) : row.assignment_result_json;
		const result = assignmentResultSchema.parse(value);
		const scope = { id: String(row.id), teamId, projectId: String(row.project_id) };
		const references = await verifyAssignmentContent(store, scope, result);
		await recordAssignmentContentIntegration(store, scope, result, references);
	}
}
