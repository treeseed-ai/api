import {
	executionEdgeSchema,
	executionNodeSchema,
	type ExecutionEdge,
	type ExecutionNode,
} from '@treeseed/sdk/agent-capacity';
import { CapacityOperationError } from '../capacity-operation-error.ts';

type Row = Record<string, unknown>;
const record = (value: unknown): Row => {
	if (value && typeof value === 'object' && !Array.isArray(value)) return value as Row;
	if (typeof value === 'string') try { return record(JSON.parse(value)); } catch { return {}; }
	return {};
};
const array = (value: unknown): unknown[] => {
	if (Array.isArray(value)) return value;
	if (typeof value === 'string') try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
	return [];
};
const integer = (value: unknown): number => Number.isInteger(Number(value)) ? Number(value) : 0;

export function decodeGraphWatchCursor(value: unknown): number {
	if (value === undefined) return 0;
	if (typeof value !== 'string' || !/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value))) {
		throw new CapacityOperationError(400, 'execution_graph_cursor_invalid',
			'Graph watch cursor must be a nonnegative safe integer revision string.');
	}
	return Number(value);
}

export function decodeExecutionNode(row: Row): ExecutionNode {
	// PostgreSQL bigint transport may be a decimal string, never caller coercion.
	const priority = row.priority;
	if (priority != null && !(typeof priority === 'number' && Number.isSafeInteger(priority))
		&& !(typeof priority === 'string' && /^(?:0|-?[1-9][0-9]*)$/u.test(priority) && Number.isSafeInteger(Number(priority)))) {
		throw new Error('execution_node_priority_invalid: persisted priority must be a safe integer.');
	}
	return executionNodeSchema.parse({
		schemaVersion: 'treeseed.execution-node/v1',
		id: row.id, teamId: row.team_id, projectId: row.project_id,
		...(row.workday_id ? { workdayId: row.workday_id } : {}),
		...(row.work_item_id ? { workItemId: row.work_item_id } : {}),
		kind: row.kind, pairRole: row.pair_role ?? null,
		sourceRef: record(row.source_ref_json), authorityRefs: array(row.authority_refs_json),
		ruleRevision: integer(row.rule_revision), nodeRevision: integer(row.node_revision),
		...(row.agent_class ? { agentClass: row.agent_class } : {}),
		status: row.status,
		...(priority != null ? { priority: Number(priority) } : {}),
		...(row.estimate_json ? { estimate: record(row.estimate_json) } : {}),
		...(row.required_capabilities_json ? { requiredCapabilities: array(row.required_capabilities_json) } : {}),
		...(row.requested_permissions_json ? { requestedPermissions: record(row.requested_permissions_json) } : {}),
		...(row.workspace ? { workspace: row.workspace } : {}),
		...(row.acceptance_criteria_json ? { acceptanceCriteria: array(row.acceptance_criteria_json) } : {}),
		...(row.maximum_review_cycles ? { maximumReviewCycles: integer(row.maximum_review_cycles) } : {}),
		...(row.condition_json ? { condition: record(row.condition_json) } : {}),
		graphRevisionCreated: integer(row.graph_revision_created),
		graphRevisionUpdated: integer(row.graph_revision_updated),
	});
}

export function decodeExecutionEdge(row: Row): ExecutionEdge {
	return executionEdgeSchema.parse({
		schemaVersion: 'treeseed.execution-edge/v1',
		id: row.id, teamId: row.team_id, fromNodeId: row.from_node_id, toNodeId: row.to_node_id,
		provenance: row.provenance,
		...(row.source_ref_json ? { sourceRef: record(row.source_ref_json) } : {}),
		graphRevisionCreated: integer(row.graph_revision_created),
		...(row.graph_revision_removed ? { graphRevisionRemoved: integer(row.graph_revision_removed) } : {}),
	});
}
