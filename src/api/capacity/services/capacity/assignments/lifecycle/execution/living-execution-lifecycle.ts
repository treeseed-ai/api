import { createHash } from 'node:crypto';
import type { AssignmentResult, ExecutionEdge, ExecutionNode } from '@treeseed/sdk/agent-capacity';
import type { DurableProviderAssignment } from '../../../../../repositories/capacity/assignments/assignment.ts';
import type { CapacityGovernanceDatabase } from '../../../../../database.ts';
import { decodeExecutionEdge, decodeExecutionNode } from '../../../../../../control-plane/repositories/capacity/execution/execution-graph-storage.ts';

type Operation = { query: string; params?: unknown[] };

const stable = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
	if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
		.sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
	return JSON.stringify(value);
};
const digest = (value: unknown) => `sha256:${createHash('sha256').update(stable(value)).digest('hex')}`;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/**
 * Project one immutable AgentKernel result into normalized node state. Edges and
 * assignment rows remain their own authorities; no node JSON or graph event is
 * created. Content-driven review revision is handled by graph reconciliation.
 */
export async function livingExecutionLifecycleOperations(input: {
	store: CapacityGovernanceDatabase;
	assignment: DurableProviderAssignment;
	status: string;
	now: string;
	returnCode?: string;
	result?: AssignmentResult | null;
	reviewDisposition?: 'approved' | 'request-changes' | null;
}): Promise<Operation[]> {
	const { assignment, status, now } = input;
	if (!assignment.executionNodeId || !assignment.executionNodeRevision) return [];
	const attempt = Number(assignment.assignmentAttempt?.attempt ?? 1);
	const configuredAttempts = Number(record(record(assignment.capacityEnvelope).budget).maxAttempts ?? 1);
	const maxAttempts = Number.isFinite(configuredAttempts) ? Math.max(1, Math.min(20, Math.floor(configuredAttempts))) : 1;
	// A control-plane restart can interrupt the provider's response before a
	// governance review is committed. Give that exact review one bounded retry;
	// an ordinary return still obeys the immutable assignment attempt limit.
	const recoverableReviewReturn = status === 'returned'
		&& (input.returnCode === 'provider_runtime_recovery' || input.returnCode === 'provider_restart_recovery')
		&& attempt === 1 && !input.result;
	const nodeStatus = status === 'returned' ? attempt < maxAttempts || recoverableReviewReturn ? 'ready' : 'failed'
		: status === 'completed' ? 'completed'
			: status === 'cancelled' ? 'cancelled' : 'failed';
	const operations: Operation[] = [];
	if (input.result) operations.push({
		query: `UPDATE capacity_provider_assignments SET assignment_result_json=?,updated_at=?
			WHERE id=? AND team_id=? AND execution_node_id=? AND execution_node_revision=?`,
		params: [JSON.stringify(input.result), now, assignment.id, assignment.teamId,
			assignment.executionNodeId, assignment.executionNodeRevision],
	});
	const revisionRow = await input.store.first('SELECT revision FROM execution_graph_revisions WHERE team_id=? ORDER BY revision DESC LIMIT 1', [assignment.teamId]);
	const currentRevision = Number(revisionRow?.revision ?? 0), nextRevision = currentRevision + 1;
	const nodeRows = await input.store.all('SELECT * FROM execution_nodes WHERE team_id=? ORDER BY id', [assignment.teamId]);
	const edgeRows = await input.store.all('SELECT * FROM execution_edges WHERE team_id=? AND graph_revision_removed IS NULL ORDER BY id', [assignment.teamId]);
	const nodes = nodeRows.map(decodeExecutionNode), edges = edgeRows.map(decodeExecutionEdge);
	const target = nodes.find((node) => node.id === assignment.executionNodeId && node.nodeRevision === assignment.executionNodeRevision);
	if (!target) return operations;
	const revisionRequested = status === 'completed' && target.pairRole === 'reviewer'
		&& input.reviewDisposition === 'request-changes';
	const pairEdge = revisionRequested ? edges.find((candidate) => candidate.toNodeId === target.id
		&& candidate.provenance === 'review-pair') : undefined;
	const actor = pairEdge ? nodes.find((node) => node.id === pairEdge.fromNodeId && node.pairRole === 'actor') : undefined;
	const actorRevision = actor?.nodeRevision;
	const reviewScope = assignment.executionMode === 'simulation' && assignment.workDayId
		? 'AND history.work_day_id=?' : '';
	const reviewScopeParams = reviewScope ? [assignment.workDayId] : [];
	const priorReviewRow = revisionRequested ? await input.store.first(`SELECT COUNT(*) AS count
		FROM capacity_provider_assignments WHERE team_id=? AND execution_node_id=?
		AND status='completed' AND assignment_result_json IS NOT NULL
		AND lifecycle_output_json::jsonb #>> '{activityCompletion,reviewDisposition}'='request-changes'
		${reviewScope ? 'AND work_day_id=?' : ''}`,
		[assignment.teamId, target.id, ...reviewScopeParams]) : null;
	const reviewExhausted = revisionRequested
		&& Number(priorReviewRow?.count ?? 0) + 1 >= (target.maximumReviewCycles ?? 1);
	if (revisionRequested && !actor) throw new Error('review_actor_node_missing');
	target.status = recoverableReviewReturn && target.workItemId !== 'proposal-review' && attempt >= maxAttempts
		? 'failed' : nodeStatus as ExecutionNode['status'];
	target.graphRevisionUpdated = nextRevision;
	const changed = [target.id];
	if (revisionRequested && actor) {
		if (reviewExhausted) {
			target.status = 'failed';
			actor.status = 'blocked';
		} else {
			target.nodeRevision += 1; target.status = 'blocked';
			actor.nodeRevision += 1; actor.status = 'ready';
		}
		actor.graphRevisionUpdated = nextRevision;
		changed.push(actor.id);
	}
	if (status === 'completed' && !revisionRequested) for (const successor of nodes.filter((node) => node.status === 'blocked'
		|| (target.pairRole === 'actor' && node.pairRole === 'reviewer' && node.status === 'failed'
			&& node.workItemId === target.workItemId && node.nodeRevision <= target.nodeRevision))) {
		const predecessorIds = edges.filter((edge) => edge.toNodeId === successor.id).map((edge) => edge.fromNodeId);
		if (predecessorIds.includes(target.id) && predecessorIds.every((id) => nodes.find((node) => node.id === id)?.status === 'completed')) {
			if (target.pairRole === 'actor' && successor.pairRole === 'reviewer') {
				successor.nodeRevision = Math.max(successor.nodeRevision, target.nodeRevision);
			}
			successor.status = 'ready'; successor.graphRevisionUpdated = nextRevision; changed.push(successor.id);
		}
	}
	if (revisionRequested && actor) operations.push({
		query: `UPDATE execution_nodes SET
			node_revision=node_revision+1,status=CASE WHEN 1+(
				SELECT COUNT(*) FROM capacity_provider_assignments history
				WHERE history.team_id=? AND history.execution_node_id=? AND history.status='completed'
				AND history.id<>?
				AND history.assignment_result_json IS NOT NULL
				AND history.lifecycle_output_json::jsonb #>> '{activityCompletion,reviewDisposition}'='request-changes'
				${reviewScope}
			)>=? THEN 'failed' ELSE 'blocked' END,
			graph_revision_updated=?,updated_at=?
			WHERE team_id=? AND id=? AND node_revision=? AND status IN ('assigned','running')`,
		params: [assignment.teamId, target.id, assignment.id, ...reviewScopeParams, target.maximumReviewCycles ?? 1,
			nextRevision, now, assignment.teamId, target.id, assignment.executionNodeRevision],
	});
	if (revisionRequested && actor) operations.push({
		query: `UPDATE execution_nodes SET
			node_revision=node_revision+1,status=CASE WHEN 1+(
				SELECT COUNT(*) FROM capacity_provider_assignments history
				WHERE history.team_id=? AND history.execution_node_id=? AND history.status='completed'
				AND history.id<>?
				AND history.assignment_result_json IS NOT NULL
				AND history.lifecycle_output_json::jsonb #>> '{activityCompletion,reviewDisposition}'='request-changes'
				${reviewScope}
			)>=? THEN 'blocked' ELSE 'ready' END,
			graph_revision_updated=?,updated_at=?
			WHERE team_id=? AND id=? AND node_revision=? AND pair_role='actor' AND status='completed'`,
		params: [assignment.teamId, target.id, assignment.id, ...reviewScopeParams, target.maximumReviewCycles ?? 1,
			nextRevision, now, assignment.teamId, actor.id, actorRevision],
	});
	if (!revisionRequested) operations.push({
		query: `UPDATE execution_nodes SET status=?,graph_revision_updated=?,updated_at=?
			WHERE team_id=? AND id=? AND node_revision=? AND status IN ('assigned','running')
			AND EXISTS (SELECT 1 FROM capacity_provider_assignments WHERE id=? AND team_id=? AND execution_node_id=? AND execution_node_revision=?)`,
		params: [nodeStatus, nextRevision, now, assignment.teamId, assignment.executionNodeId,
			assignment.executionNodeRevision, assignment.id, assignment.teamId,
			assignment.executionNodeId, assignment.executionNodeRevision],
	});
	if (status === 'completed' && !revisionRequested) operations.push({
		query: `UPDATE execution_nodes target SET
			node_revision=CASE WHEN ?='actor' AND target.pair_role='reviewer'
				THEN GREATEST(target.node_revision,?) ELSE target.node_revision END,
			status='ready',graph_revision_updated=?,updated_at=?
			WHERE target.team_id=? AND (target.status='blocked' OR (?='actor' AND target.pair_role='reviewer'
				AND target.work_item_id=? AND target.node_revision<=? AND target.status='failed'))
			AND EXISTS (SELECT 1 FROM execution_edges edge WHERE edge.team_id=target.team_id
				AND edge.to_node_id=target.id AND edge.from_node_id=? AND edge.graph_revision_removed IS NULL)
			AND NOT EXISTS (
				SELECT 1 FROM execution_edges edge
				JOIN execution_nodes predecessor ON predecessor.team_id=edge.team_id AND predecessor.id=edge.from_node_id
				WHERE edge.team_id=target.team_id AND edge.to_node_id=target.id
				AND edge.graph_revision_removed IS NULL AND predecessor.status<>'completed'
			)`,
		params: [target.pairRole, target.nodeRevision, nextRevision, now, assignment.teamId,
			target.pairRole, target.workItemId, target.nodeRevision, assignment.executionNodeId],
	});
	const assignmentAttempt = assignment.assignmentAttempt;
	if (assignmentAttempt) operations.push({
		query: `INSERT INTO execution_graph_revisions
			(team_id,revision,rule_revision,changed_source_refs_json,graph_digest,changes_json,created_at)
			SELECT ?,?,?,?,?,?,? WHERE (SELECT COALESCE(MAX(revision),0) FROM execution_graph_revisions WHERE team_id=?)=?`,
		params: [assignment.teamId,nextRevision,Math.max(...nodes.map((node) => node.ruleRevision), 1),
			JSON.stringify([assignmentAttempt.sourceRef]),digest({ teamId: assignment.teamId, nodes, edges: edges as ExecutionEdge[] }),
			JSON.stringify({ added: [], changed, completed: status === 'completed' && !revisionRequested ? [target.id] : [],
				blocked: reviewExhausted && actor ? [target.id, actor.id] : nodeStatus === 'failed' ? [target.id] : [],
				stale: [], removedEdges: [], addedEdges: [] }),
			now,assignment.teamId,currentRevision],
	});
	return operations;
}
