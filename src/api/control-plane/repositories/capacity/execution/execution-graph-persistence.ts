import{validateExecutionGraph,type GraphRevision}from'@treeseed/sdk/agent-capacity';
import{stable,text,type TeamGraph}from'./execution-graph-state.ts';
import{CapacityOperationError}from'../capacity-operation-error.ts';
import{capacityTransaction}from'../../../../capacity/transaction.ts';
import{recordExecutionNodeObservations}from'./execution-node-observations.ts';

export async function persistExecutionGraph(store: any, graph: TeamGraph, current: TeamGraph, revisionRecord: GraphRevision) {
	if (!validateExecutionGraph(graph.nodes, graph.edges).ok) throw new CapacityOperationError(422, 'execution_graph_invalid', 'Only canonical execution graphs can be persisted.');
	return capacityTransaction(store,async database=>{
	const now = revisionRecord.createdAt;
	const operations: Array<{ query: string; params: unknown[] }> = [{
		query: 'SELECT id FROM teams WHERE id=? FOR NO KEY UPDATE', params: [graph.teamId],
	}, { query: 'SELECT id FROM execution_nodes WHERE team_id=? ORDER BY id FOR UPDATE', params: [graph.teamId],
	}, {
		query: `INSERT INTO execution_graph_revisions
			(team_id,revision,rule_revision,changed_source_refs_json,graph_digest,changes_json,created_at)
			SELECT ?,?,?,?,?,?,? WHERE (SELECT COALESCE(MAX(revision),0) FROM execution_graph_revisions WHERE team_id=?)=?
			AND NOT EXISTS (
				SELECT 1 FROM jsonb_to_recordset(?::jsonb) AS expected(id text,node_revision integer,status text)
				LEFT JOIN execution_nodes actual ON actual.id=expected.id AND actual.team_id=?
				WHERE actual.id IS NULL OR actual.node_revision<>expected.node_revision OR actual.status<>expected.status
			)
			ON CONFLICT (team_id,revision) DO NOTHING`,
		params: [revisionRecord.teamId,revisionRecord.revision,revisionRecord.ruleRevision,
			JSON.stringify(revisionRecord.changedSourceRefs),revisionRecord.graphDigest,
			JSON.stringify(revisionRecord.changes),revisionRecord.createdAt,revisionRecord.teamId,current.revision,
			JSON.stringify(current.nodes.map(node => ({ id: node.id, node_revision: node.nodeRevision, status: node.status }))),graph.teamId],
	}];
	const revisionGuard = `EXISTS (SELECT 1 FROM execution_graph_revisions
		WHERE team_id=? AND revision=? AND created_at=? AND graph_digest=?)`;
	const currentNodes = new Map(current.nodes.map((node) => [node.id, node]));
	for (const node of graph.nodes.filter((candidate) => stable(currentNodes.get(candidate.id)) !== stable(candidate))) operations.push({
		query: `INSERT INTO execution_nodes (
			id,team_id,project_id,workday_id,work_item_id,kind,pair_role,source_ref_json,authority_refs_json,
			rule_revision,node_revision,agent_class,status,estimate_json,required_capabilities_json,
			requested_permissions_json,workspace,acceptance_criteria_json,maximum_review_cycles,condition_json,
			graph_revision_created,graph_revision_updated,created_at,updated_at,priority
		) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${revisionGuard}
		ON CONFLICT (id) DO UPDATE SET
			project_id=excluded.project_id,workday_id=excluded.workday_id,work_item_id=excluded.work_item_id,
			kind=excluded.kind,pair_role=excluded.pair_role,source_ref_json=excluded.source_ref_json,
			authority_refs_json=excluded.authority_refs_json,rule_revision=excluded.rule_revision,
			node_revision=excluded.node_revision,agent_class=excluded.agent_class,status=excluded.status,
			estimate_json=excluded.estimate_json,required_capabilities_json=excluded.required_capabilities_json,
			requested_permissions_json=excluded.requested_permissions_json,workspace=excluded.workspace,
			acceptance_criteria_json=excluded.acceptance_criteria_json,maximum_review_cycles=excluded.maximum_review_cycles,
			condition_json=excluded.condition_json,priority=excluded.priority,
			graph_revision_updated=excluded.graph_revision_updated,updated_at=excluded.updated_at`,
		params: [node.id,node.teamId,node.projectId,node.workdayId ?? null,node.workItemId ?? null,node.kind,node.pairRole,
			JSON.stringify(node.sourceRef),JSON.stringify(node.authorityRefs ?? []),node.ruleRevision,node.nodeRevision,
			node.agentClass ?? null,node.status,node.estimate ? JSON.stringify(node.estimate) : null,
			node.requiredCapabilities ? JSON.stringify(node.requiredCapabilities) : null,
			node.requestedPermissions ? JSON.stringify(node.requestedPermissions) : null,node.workspace ?? null,
			node.acceptanceCriteria ? JSON.stringify(node.acceptanceCriteria) : null,node.maximumReviewCycles ?? null,
			node.condition ? JSON.stringify(node.condition) : null,node.graphRevisionCreated,node.graphRevisionUpdated,now,now,node.priority ?? null,
			revisionRecord.teamId,revisionRecord.revision,revisionRecord.createdAt,revisionRecord.graphDigest],
	});
	const currentEdges = new Map(current.edges.map((edge) => [edge.id, edge]));
	const desiredEdges = new Set(graph.edges.map((edge) => edge.id));
	for (const prior of current.edges) if (!desiredEdges.has(prior.id)) operations.push({
		query: `UPDATE execution_edges SET graph_revision_removed = ?
			WHERE team_id = ? AND id = ? AND graph_revision_removed IS NULL AND ${revisionGuard}`,
		params: [graph.revision, graph.teamId, prior.id,
			revisionRecord.teamId,revisionRecord.revision,revisionRecord.createdAt,revisionRecord.graphDigest],
	});
	for (const edge of graph.edges.filter((candidate) => stable(currentEdges.get(candidate.id)) !== stable(candidate))) operations.push({
		query: `INSERT INTO execution_edges (id,team_id,from_node_id,to_node_id,provenance,source_ref_json,graph_revision_created,graph_revision_removed,created_at)
			SELECT ?,?,?,?,?,?,?,?,? WHERE ${revisionGuard}
			ON CONFLICT (id) DO UPDATE SET graph_revision_removed=NULL`,
		params: [edge.id,edge.teamId,edge.fromNodeId,edge.toNodeId,edge.provenance,
			edge.sourceRef ? JSON.stringify(edge.sourceRef) : null,edge.graphRevisionCreated,null,now,
			revisionRecord.teamId,revisionRecord.revision,revisionRecord.createdAt,revisionRecord.graphDigest],
	});
	await database.batch(operations);
	const committed = await database.first('SELECT revision,graph_digest FROM execution_graph_revisions WHERE team_id=? ORDER BY revision DESC LIMIT 1', [graph.teamId]);
	if (Number(committed?.revision) !== graph.revision || text(committed?.graph_digest) !== graph.digest) {
		throw new CapacityOperationError(409, 'execution_graph_revision_conflict', 'The execution graph changed concurrently; reconcile again.');
	}
	await recordExecutionNodeObservations(database,current.nodes,graph.nodes,'graph:'+graph.teamId+':'+graph.revision,now);
	return revisionRecord;
	});
}
