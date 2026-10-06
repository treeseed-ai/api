import { CapacityGovernanceError } from '../../../../database.ts';
import { canonicalJson } from '../../../../security.ts';
import type { ExecutionNode } from '@treeseed/sdk/agent-capacity';

type Row = Record<string, unknown>;
type Store = { first(sql: string, values: unknown[]): Promise<Row | null>; all(sql: string, values: unknown[]): Promise<Row[]> };
const record = (value: unknown): Row => {
	if (typeof value === 'string') try { return record(JSON.parse(value)); } catch { return {}; }
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
};

function continuationParameters(value: unknown): Row {
	let parsed = value;
	try { if (typeof parsed === 'string') parsed = JSON.parse(parsed); } catch {
		throw new CapacityGovernanceError('workday_continuation_scope_invalid', 'Continuation parameters must retain readable original object bytes.', 409);
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.keys(parsed).length) throw new CapacityGovernanceError(
		'workday_continuation_scope_invalid', 'Continuation parameters must retain a nonempty original object.', 409);
	const parameters = parsed as Row;
	if (Object.hasOwn(parameters, 'continueFromWorkdayId')) {
		const parent = parameters.continueFromWorkdayId;
		if (typeof parent !== 'string' || !parent || parent !== parent.trim()) throw new CapacityGovernanceError(
			'workday_continuation_scope_invalid', 'A supplied continuation parent must be one exact nonempty identifier.', 409);
	}
	return parameters;
}

export function assignmentBelongsToRun(row: Row, node: ExecutionNode | undefined,
	runId: string, history: ReadonlySet<string>): boolean {
	if (!node?.workdayId || !runId) return true;
	if (row.work_day_id === node.workdayId) return true;
	if (!history.has(String(row.work_day_id))) return false;
	const attempt = record(row.assignment_attempt_json);
	const refs = Array.isArray(attempt.authorityRefs) ? attempt.authorityRefs : [];
	return canonicalJson(attempt.sourceRef) === canonicalJson(node.sourceRef)
		&& canonicalJson(refs.filter(ref => record(ref).model === 'decision'))
			=== canonicalJson((node.authorityRefs ?? []).filter(ref => ref.model === 'decision'));
}

/** Derive history from ordinary workday records; no copied campaign/result authority. */
export async function workdayContinuationHistory(store: Store, teamId: string, parentId: string,
	mode: string, providerId?: string): Promise<Row[]> {
	const history: Row[] = [], seen = new Set<string>();
	for (let id = parentId; id;) {
		if (seen.has(id) || seen.size >= 64) throw new CapacityGovernanceError(
			'workday_continuation_cycle', 'Workday continuation must be a bounded acyclic lineage.', 409);
		seen.add(id);
		const row = await store.first('SELECT * FROM capacity_workday_runs WHERE team_id=? AND id=?', [teamId, id]);
		if (!row || row.execution_kind !== 'workday' || row.execution_mode !== mode
			|| providerId && row.capacity_provider_id !== providerId
			|| !['completed','degraded','cancelled','failed'].includes(String(row.status))) throw new CapacityGovernanceError(
			'workday_continuation_scope_invalid', 'Continuation requires settled work in the same team, mode and provider custody.', 409);
		const parameters = continuationParameters(row.parameters_json);
		const active = await store.first(`SELECT id FROM capacity_provider_assignments WHERE team_id=? AND work_day_id=?
			AND (status IN ('pending','leased','running') OR lease_state='leased' OR lease_token IS NOT NULL
				OR (status='returned' AND lease_state IS DISTINCT FROM 'released')) LIMIT 1`, [teamId, id]);
		const reserved = await store.first(`SELECT id FROM capacity_reservations WHERE team_id=? AND work_day_id=?
			AND state IN ('reserved','consuming') LIMIT 1`, [teamId, id]);
		if (active || reserved) throw new CapacityGovernanceError('workday_continuation_unsettled',
			'Previous assignments and reservations must settle before continuation.', 409);
		history.push(row);
		id = typeof parameters.continueFromWorkdayId === 'string' ? parameters.continueFromWorkdayId : '';
	}
	return history;
}

export async function validateWorkdayContinuation(store: Store, teamId: string, parentId: string,
	mode: string, providerId: string, projects: string[], decisionIds: string[]): Promise<void> {
	const history = await workdayContinuationHistory(store, teamId, parentId, mode, providerId);
	const parent = history[0]!;
	const parameters = record(parent.parameters_json);
	const priorProjects = parameters.scheduledProjectIds;
	if (!Array.isArray(priorProjects) || projects.some(id => !priorProjects.includes(id))) throw new CapacityGovernanceError(
		'workday_continuation_projects_invalid', 'Continuation cannot add projects outside the previous workday.', 409);
	const attempts = await store.all(`SELECT DISTINCT decision_id,assignment_attempt_json FROM capacity_provider_assignments
		WHERE team_id=? AND work_day_id IN (${history.map(() => '?').join(',')}) AND decision_id IS NOT NULL`,
		[teamId, ...history.map(row => row.id)]);
	for (const id of decisionIds) if (!attempts.some(row => row.decision_id === id)) throw new CapacityGovernanceError(
		'workday_continuation_decision_invalid', 'Continuation requires decisions already executed in the previous lineage.', 409);
}

/** A single lineage predicate is shared by predecessor custody and the atomic review fence. */
export function workdayLineageSql(workdayExpression: string, teamExpression: string): string {
	return `(WITH RECURSIVE lineage AS (
		SELECT id,parameters_json FROM capacity_workday_runs WHERE team_id=${teamExpression} AND id=${workdayExpression}
		UNION
		SELECT parent.id,parent.parameters_json FROM capacity_workday_runs parent JOIN lineage child
			ON parent.id=child.parameters_json::jsonb->>'continueFromWorkdayId'
			WHERE parent.team_id=${teamExpression}
	) SELECT id FROM lineage)`;
}
