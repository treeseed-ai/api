import type {DurableCapacityWorkdayRun} from '../../repositories/capacity/workdays/workday-run.ts';
const text=(value:unknown):string=>typeof value==='string'?value.trim():'';
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};

/** The same original selected graph scope applies to admission and historical reporting. Closing narrows only new admission. */
export function executionNodeWorkdayScope(run: Pick<DurableCapacityWorkdayRun, 'id' | 'executionKind' | 'parameters'>) {
	if (run.executionKind === 'conversation') {
		return { sql: `node.kind='communication' AND node.workday_id=?`, parameters: [run.id] };
	}
	const proposalIds = Array.isArray(run.parameters.proposalIds) ? run.parameters.proposalIds.map(text).filter(Boolean) : [];
	if (run.parameters.planningOnly === true) {
		return {
			sql: `node.workday_id=? AND node.kind IN ('planning','estimating','communication','reporting')`,
			parameters: [run.id],
		};
	}
	if (proposalIds.length) return {
		sql: `(node.workday_id=? OR (node.workday_id IS NULL
			AND node.source_ref_json::jsonb->>'model'='proposal' AND node.source_ref_json::jsonb->>'id' IN (${proposalIds.map(() => '?').join(',')})))`,
		parameters: [run.id, ...proposalIds],
	};
	return { sql: `(node.workday_id=? OR (node.workday_id IS NULL AND node.kind<>'communication'))`, parameters: [run.id] };
}

export function executionNodeRunScope(run: Pick<DurableCapacityWorkdayRun, 'id' | 'executionKind' | 'parameters'>) {
	if (run.executionKind !== 'conversation' && record(run.parameters.appliedPlan).state === 'closing')
		return { sql: `node.kind='reporting' AND node.workday_id=?`, parameters: [run.id] };
	return executionNodeWorkdayScope(run);
}
