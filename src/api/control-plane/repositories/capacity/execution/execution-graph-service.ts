import { createHash } from 'node:crypto';
import {
	graphRevisionSchema,
	validateAgentDefinitionModel,
	validateExecutionGraph,
	type AgentDefinition,
	type ExecutionEdge,
	type ExecutionNode,
	type GraphRevision,
} from '@treeseed/sdk/agent-capacity';
import { projectTeamExecutionGraph } from '../../../../capacity/policy/execution/execution-graph-projector.ts';
import { projectActiveWorkdays } from '../../../../capacity/policy/execution/workday-execution-projector.ts';
import { projectCommunicationInvocations } from '../../../../capacity/policy/execution/communication-execution-projector.ts';
import { loadTeamExecutableProposalSources } from '../../../../capacity/services/capacity/execution/executable-proposal-source.ts';
import { readExactProposal } from '../../../../governance/executable-proposal.ts';
import { authorizeCapacityTeam, type CapacityPrincipal } from '../capacity-authorization.ts';
import { CapacityOperationError } from '../capacity-operation-error.ts';
import { decodeExecutionEdge, decodeExecutionNode } from './execution-graph-storage.ts';

type Row = Record<string, unknown>;
type TeamGraph = { teamId: string; revision: number; digest: string; nodes: ExecutionNode[]; edges: ExecutionEdge[] };
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
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const integer = (value: unknown): number => Number.isInteger(Number(value)) ? Number(value) : 0;
const stable = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
	if (value && typeof value === 'object') return `{${Object.entries(value as Row).sort(([a], [b]) => a.localeCompare(b))
		.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
	return JSON.stringify(value);
};
const digest = (value: unknown): string => `sha256:${createHash('sha256').update(stable(value)).digest('hex')}`;

async function loadGraphSource<T>(source: string, loader: () => Promise<T>): Promise<T> {
	try {
		return await loader();
	} catch (error) {
		if (error instanceof CapacityOperationError) throw error;
		throw new CapacityOperationError(500, `execution_graph_${source}_unavailable`,
			`The execution graph ${source} source could not be loaded.`);
	}
}

async function readGraph(store: any, teamId: string): Promise<TeamGraph> {
	const [revisionRow, nodeRows, edgeRows] = await Promise.all([
		store.first('SELECT * FROM execution_graph_revisions WHERE team_id = ? ORDER BY revision DESC LIMIT 1', [teamId]),
		store.all('SELECT * FROM execution_nodes WHERE team_id = ? ORDER BY id', [teamId]),
		store.all('SELECT * FROM execution_edges WHERE team_id = ? AND graph_revision_removed IS NULL ORDER BY id', [teamId]),
	]);
	return {
		teamId, revision: integer(revisionRow?.revision), digest: text(revisionRow?.graph_digest),
		nodes: nodeRows.map(decodeExecutionNode), edges: edgeRows.map(decodeExecutionEdge),
	};
}

async function loadProfiles(store: any, teamId: string): Promise<Record<string, AgentDefinition>> {
	const rows = await store.all(`SELECT project_id,handler_refs_json FROM project_agent_classes
		WHERE team_id = ? AND status = 'active' ORDER BY project_id,id`, [teamId]);
	const profiles: Record<string, AgentDefinition> = {};
	for (const row of rows) for (const candidate of array(record(row.handler_refs_json).agents)) {
		const validation = validateAgentDefinitionModel(candidate);
		if (!validation.ok || !validation.data) throw Object.assign(
			new CapacityOperationError(409, 'agent_profile_invalid', 'An active project agent class does not contain a valid minimal agent definition.'),
			{ diagnostics: validation.diagnostics },
		);
		const key = `${text(row.project_id)}:${validation.data.agentClass}`;
		if (profiles[key] && stable(profiles[key]) !== stable(validation.data)) {
			throw new CapacityOperationError(409, 'agent_profile_conflict', `Project ${row.project_id} has conflicting ${validation.data.agentClass} definitions.`);
		}
		profiles[key] = validation.data;
	}
	return profiles;
}

async function loadActiveWorkdays(store: any, teamId: string) {
	const rows = await store.all(`SELECT id,team_id,parameters_json FROM capacity_workday_runs
		WHERE team_id=? AND execution_kind='workday' AND status='running' ORDER BY id`, [teamId]);
	const sources = rows.flatMap((row: Row) => {
		const parameters = record(row.parameters_json);
		return parameters.appliedPlan ? [{ id: text(row.id), teamId: text(row.team_id), parameters }] : [];
	});
	return Promise.all(sources.map(async (source: { id: string; teamId: string; parameters: Row }) => {
		if (!Object.keys(record(source.parameters.planningSourceByProjectId)).length) return source;
		const proposalsByProjectId: Record<string, Row> = {};
		for (const [projectId, value] of Object.entries(record(source.parameters.planningSourceByProjectId))) {
			const reference = record(value);
			const proposal = await store.getGovernanceProposal(text(reference.id));
			if (!proposal || text(proposal.teamId ?? proposal.team_id) !== teamId
				|| text(proposal.projectId ?? proposal.project_id) !== projectId) throw new CapacityOperationError(
				409, 'estimating_proposal_scope_invalid', 'Estimating requires the selected team and project proposal.');
			const exact = await readExactProposal(store, proposal, reference as import('@treeseed/sdk/agent-capacity').ExactEntityReference);
			if (stable(exact.ref) !== stable(reference)) throw new CapacityOperationError(
				409, 'estimating_proposal_source_moved', 'The frozen estimating proposal revision changed.');
			proposalsByProjectId[projectId] = exact.definition;
		}
		// Transient exact TreeDX reads, never another persisted plan authority.
		return { ...source, proposalsByProjectId };
	}));
}

async function loadCommunicationInvocations(store: any, teamId: string) {
	const rows = await store.all(`SELECT invocation.id,invocation.team_id,invocation.project_id,invocation.agent_id,
		invocation.execution_id,invocation.metadata_json,invocation.content_refs_json,library.repository_id
		FROM agent_invocation_requests invocation
		JOIN treedx_project_libraries library ON library.project_id=invocation.project_id
		WHERE invocation.team_id=? AND invocation.execution_kind='conversation'
		AND invocation.status IN ('admitted','running') AND invocation.execution_id IS NOT NULL
		ORDER BY invocation.id`, [teamId]);
	return rows.flatMap((row: Row) => {
		const metadata = record(row.metadata_json);
		const path = text(metadata.sourceMessagePath)
			|| text(array(row.content_refs_json)[0]);
		const commit = text(metadata.sourceCommit);
		const repository = text(row.repository_id);
		if (!path || !/^[a-f0-9]{40}$/u.test(commit) || !repository) return [];
		return [{ id: text(row.id), teamId: text(row.team_id), projectId: text(row.project_id),
			workdayId: text(row.execution_id), agentId: text(row.agent_id), repository, commit, path,
			durationSeconds: Math.max(1, integer(metadata.productiveSeconds) || 900) }];
	});
}

export function applyOperationalState(current: TeamGraph, projected: TeamGraph, revision: number): TeamGraph {
	const priorById = new Map(current.nodes.map((node) => [node.id, node]));
	const activeIds = new Set(projected.nodes.map((node) => node.id));
	const nodes = projected.nodes.map((node) => {
		const prior = priorById.get(node.id);
		const operational = prior && ['assigned', 'running', 'completed', 'failed', 'cancelled'].includes(prior.status);
		if (operational) return { ...prior, graphRevisionUpdated: revision };
		const semantic = (value: ExecutionNode) => {
			const { status: _status, nodeRevision: _nodeRevision, graphRevisionCreated: _created,
				graphRevisionUpdated: _updated, ...rest } = value;
			return rest;
		};
		const changed = prior && stable(semantic(prior)) !== stable(semantic(node));
		const nodeRevision = prior
			? prior.status === 'stale' || changed ? prior.nodeRevision + 1 : Math.max(prior.nodeRevision, node.nodeRevision)
			: node.nodeRevision;
		return { ...node, nodeRevision,
			graphRevisionCreated: prior?.graphRevisionCreated ?? node.graphRevisionCreated, graphRevisionUpdated: revision };
	});
	for (const prior of current.nodes) {
		if (activeIds.has(prior.id)) continue;
		nodes.push(prior.status === 'stale'
			? prior
			: !prior.workdayId && prior.kind !== 'communication' && ['assigned', 'running'].includes(prior.status)
			? { ...prior, graphRevisionUpdated: revision }
			: { ...prior, status: 'stale', nodeRevision: prior.nodeRevision + 1, graphRevisionUpdated: revision });
	}
	const activeNodes = new Map(nodes.map((node) => [node.id, node]));
	for (const node of nodes) {
		if (node.status === 'proposed' || node.status === 'stale'
			|| ['assigned', 'running', 'completed', 'failed', 'cancelled'].includes(node.status)) continue;
		if (node.kind === 'condition') continue;
		const predecessors = projected.edges.filter((edge) => edge.toNodeId === node.id).map((edge) => activeNodes.get(edge.fromNodeId));
		node.status = predecessors.every((candidate) => candidate?.status === 'completed') ? 'ready' : 'blocked';
	}
	const withoutGraphRevision = (node: ExecutionNode) => {
		const { graphRevisionCreated: _created, graphRevisionUpdated: _updated, ...value } = node;
		return value;
	};
	const normalizedNodes = nodes.map((node) => {
		const prior = priorById.get(node.id);
		return prior && activeIds.has(node.id) && stable(withoutGraphRevision(prior)) === stable(withoutGraphRevision(node))
			? { ...node, graphRevisionCreated: prior.graphRevisionCreated, graphRevisionUpdated: prior.graphRevisionUpdated }
			: node;
	}).sort((left, right) => left.id.localeCompare(right.id));
	const priorEdges = new Map(current.edges.map((candidate) => [candidate.id, candidate]));
	const edges = projected.edges.map((candidate) => ({ ...candidate,
		graphRevisionCreated: priorEdges.get(candidate.id)?.graphRevisionCreated ?? candidate.graphRevisionCreated }));
	const checked = validateExecutionGraph(normalizedNodes, edges);
	if (!checked.ok) throw Object.assign(new CapacityOperationError(422, 'execution_graph_invalid', 'The reconciled execution graph is invalid.'), { diagnostics: checked.diagnostics });
	return { teamId: projected.teamId, revision, nodes: normalizedNodes, edges,
		digest: digest({ teamId: projected.teamId, nodes: normalizedNodes, edges }) };
}

/** Reconcile a committed request-changes result whose paired node update was interrupted. */
export function recoverIncompleteReviewCycles(graph: TeamGraph, completedReviews: ReadonlyMap<string, number>, revision: number): TeamGraph {
	for (const reviewer of graph.nodes) {
		const completed = completedReviews.get(reviewer.id) ?? 0;
		if (reviewer.pairRole !== 'reviewer' || reviewer.status !== 'failed' || completed < 1
			|| completed >= (reviewer.maximumReviewCycles ?? 1)) continue;
		const actor = graph.nodes.find((node) => node.projectId === reviewer.projectId
			&& node.workItemId === reviewer.workItemId && node.pairRole === 'actor'
			&& (node.status === 'blocked' || node.status === 'completed'));
		if (!actor) continue;
		reviewer.nodeRevision += 1; reviewer.status = 'blocked'; reviewer.graphRevisionUpdated = revision;
		actor.nodeRevision += 1; actor.status = 'ready'; actor.graphRevisionUpdated = revision;
	}
	graph.digest = digest({ teamId: graph.teamId, nodes: graph.nodes, edges: graph.edges });
	return graph;
}

function graphChanges(current: TeamGraph, desired: TeamGraph) {
	const beforeNodes = new Map(current.nodes.map((node) => [node.id, node]));
	const afterNodes = new Map(desired.nodes.map((node) => [node.id, node]));
	const beforeEdges = new Set(current.edges.map((edge) => edge.id));
	const afterEdges = new Set(desired.edges.map((edge) => edge.id));
	return {
		added: desired.nodes.filter((node) => !beforeNodes.has(node.id)).map((node) => node.id),
		changed: desired.nodes.filter((node) => beforeNodes.has(node.id) && stable(beforeNodes.get(node.id)) !== stable(node)).map((node) => node.id),
		completed: desired.nodes.filter((node) => node.status === 'completed' && beforeNodes.get(node.id)?.status !== 'completed').map((node) => node.id),
		blocked: desired.nodes.filter((node) => node.status === 'blocked' && beforeNodes.get(node.id)?.status !== 'blocked').map((node) => node.id),
		stale: desired.nodes.filter((node) => node.status === 'stale' && beforeNodes.get(node.id)?.status !== 'stale').map((node) => node.id),
		removedEdges: current.edges.filter((edge) => !afterEdges.has(edge.id)).map((edge) => edge.id),
		addedEdges: desired.edges.filter((edge) => !beforeEdges.has(edge.id)).map((edge) => edge.id),
	};
}

function hasChanges(changes: ReturnType<typeof graphChanges>): boolean {
	return Object.values(changes).some((ids) => ids.length > 0);
}

function visibleGraph(graph: TeamGraph, query: Row): TeamGraph {
	const projectId = text(query.projectId);
	const decisionId = text(query.decisionId);
	if (!projectId && !decisionId) return graph;
	const nodes = graph.nodes.filter((node) => (!projectId || node.projectId === projectId)
		&& (!decisionId || node.authorityRefs?.some((reference) => reference.model === 'decision' && reference.id === decisionId)));
	const ids = new Set(nodes.map((node) => node.id));
	return { ...graph, nodes, edges: graph.edges.filter((edge) => ids.has(edge.fromNodeId) && ids.has(edge.toNodeId)) };
}

export async function persistExecutionGraph(store: any, graph: TeamGraph, current: TeamGraph, revisionRecord: GraphRevision) {
	const now = revisionRecord.createdAt;
	const operations: Array<{ query: string; params: unknown[] }> = [{
		query: 'SELECT id FROM execution_nodes WHERE team_id=? ORDER BY id FOR UPDATE', params: [graph.teamId],
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
		WHERE team_id=? AND revision=? AND created_at=?)`;
	for (const node of graph.nodes) operations.push({
		query: `INSERT INTO execution_nodes (
			id,team_id,project_id,workday_id,work_item_id,kind,pair_role,source_ref_json,authority_refs_json,
			rule_revision,node_revision,agent_class,status,estimate_json,required_capabilities_json,
			requested_permissions_json,workspace,acceptance_criteria_json,maximum_review_cycles,condition_json,
			graph_revision_created,graph_revision_updated,created_at,updated_at
		) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${revisionGuard}
		ON CONFLICT (id) DO UPDATE SET
			project_id=excluded.project_id,workday_id=excluded.workday_id,work_item_id=excluded.work_item_id,
			kind=excluded.kind,pair_role=excluded.pair_role,source_ref_json=excluded.source_ref_json,
			authority_refs_json=excluded.authority_refs_json,rule_revision=excluded.rule_revision,
			node_revision=excluded.node_revision,agent_class=excluded.agent_class,status=excluded.status,
			estimate_json=excluded.estimate_json,required_capabilities_json=excluded.required_capabilities_json,
			requested_permissions_json=excluded.requested_permissions_json,workspace=excluded.workspace,
			acceptance_criteria_json=excluded.acceptance_criteria_json,maximum_review_cycles=excluded.maximum_review_cycles,
			condition_json=excluded.condition_json,
			graph_revision_updated=excluded.graph_revision_updated,updated_at=excluded.updated_at`,
		params: [node.id,node.teamId,node.projectId,node.workdayId ?? null,node.workItemId ?? null,node.kind,node.pairRole,
			JSON.stringify(node.sourceRef),JSON.stringify(node.authorityRefs ?? []),node.ruleRevision,node.nodeRevision,
			node.agentClass ?? null,node.status,node.estimate ? JSON.stringify(node.estimate) : null,
			node.requiredCapabilities ? JSON.stringify(node.requiredCapabilities) : null,
			node.requestedPermissions ? JSON.stringify(node.requestedPermissions) : null,node.workspace ?? null,
			node.acceptanceCriteria ? JSON.stringify(node.acceptanceCriteria) : null,node.maximumReviewCycles ?? null,
			node.condition ? JSON.stringify(node.condition) : null,node.graphRevisionCreated,node.graphRevisionUpdated,now,now,
			revisionRecord.teamId,revisionRecord.revision,revisionRecord.createdAt],
	});
	const desiredEdges = new Set(graph.edges.map((edge) => edge.id));
	for (const prior of current.edges) if (!desiredEdges.has(prior.id)) operations.push({
		query: `UPDATE execution_edges SET graph_revision_removed = ?
			WHERE team_id = ? AND id = ? AND graph_revision_removed IS NULL AND ${revisionGuard}`,
		params: [graph.revision, graph.teamId, prior.id,
			revisionRecord.teamId,revisionRecord.revision,revisionRecord.createdAt],
	});
	for (const edge of graph.edges) operations.push({
		query: `INSERT INTO execution_edges (id,team_id,from_node_id,to_node_id,provenance,source_ref_json,graph_revision_created,graph_revision_removed,created_at)
			SELECT ?,?,?,?,?,?,?,?,? WHERE ${revisionGuard}
			ON CONFLICT (id) DO UPDATE SET graph_revision_removed=NULL`,
		params: [edge.id,edge.teamId,edge.fromNodeId,edge.toNodeId,edge.provenance,
			edge.sourceRef ? JSON.stringify(edge.sourceRef) : null,edge.graphRevisionCreated,null,now,
			revisionRecord.teamId,revisionRecord.revision,revisionRecord.createdAt],
	});
	await store.batch(operations);
	const committed = await store.first('SELECT revision,graph_digest FROM execution_graph_revisions WHERE team_id=? ORDER BY revision DESC LIMIT 1', [graph.teamId]);
	if (integer(committed?.revision) !== graph.revision || text(committed?.graph_digest) !== graph.digest) {
		throw new CapacityOperationError(409, 'execution_graph_revision_conflict', 'The execution graph changed concurrently; reconcile again.');
	}
	return revisionRecord;
}

async function reconcileExecutionGraphOnce(store: any, teamId: string, body: Row = {}) {
	const current = await loadGraphSource('projection', () => readGraph(store, teamId));
	const selectedProjectId = text(body.projectId);
	const [sources, profiles, workdays, communications] = await Promise.all([
		loadGraphSource('governance', () => loadTeamExecutableProposalSources(store, teamId, selectedProjectId || undefined)),
		loadGraphSource('agent_profiles', () => loadProfiles(store, teamId)),
		loadGraphSource('workdays', () => loadActiveWorkdays(store, teamId)),
		loadGraphSource('communications', () => loadCommunicationInvocations(store, teamId)),
	]);
	if (!sources.length && !workdays.length && !communications.length && !current.nodes.length) return body.plan === true
		? { teamId, baseRevision: current.revision, desiredRevision: current.revision, desiredDigest: current.digest, changes: { added: [], changed: [], completed: [], blocked: [], stale: [], removedEdges: [], addedEdges: [] } }
		: current;
	const revision = current.revision + 1;
	const proposalProjection = sources.length ? projectTeamExecutionGraph({ teamId, revision, sources, profiles }) : null;
	const workdayProjection = projectActiveWorkdays({ teamId, revision, sources: workdays, profiles });
	const communicationProjection = projectCommunicationInvocations({ teamId, revision, sources: communications, profiles });
	const retainedProposalNodes = selectedProjectId
		? current.nodes.filter((node) => node.sourceRef.model === 'proposal' && node.projectId !== selectedProjectId)
		: [];
	const retainedProposalIds = new Set(retainedProposalNodes.map((node) => node.id));
	const retainedProposalEdges = selectedProjectId
		? current.edges.filter((edge) => retainedProposalIds.has(edge.fromNodeId) && retainedProposalIds.has(edge.toNodeId))
		: [];
	const nodes = [...retainedProposalNodes, ...(proposalProjection?.nodes ?? []), ...workdayProjection.nodes, ...communicationProjection.nodes];
	const edges = [...retainedProposalEdges, ...(proposalProjection?.edges ?? []), ...workdayProjection.edges];
	const changedSourceRefs = [...new Map([...(proposalProjection?.revision.changedSourceRefs ?? []),
		...workdayProjection.changedSourceRefs, ...communicationProjection.changedSourceRefs,
		...(!sources.length && !workdays.length && !communications.length ? current.nodes.map((node) => node.sourceRef) : [])]
		.map((reference) => [stable(reference), reference])).values()];
	const base: TeamGraph = { teamId, revision, digest: digest({ teamId, nodes, edges }), nodes, edges };
	const desired = applyOperationalState(current, base, current.revision + 1);
	const recoverableReviewers = desired.nodes.filter((node) => node.pairRole === 'reviewer' && node.status === 'failed');
	if (recoverableReviewers.length) {
		const rows = await store.all(`SELECT execution_node_id,COUNT(*) AS count FROM capacity_provider_assignments
			WHERE team_id=? AND status='completed' AND assignment_result_json IS NOT NULL
			AND execution_node_id IS NOT NULL GROUP BY execution_node_id`, [teamId]);
		recoverIncompleteReviewCycles(desired, new Map(rows.map((row: Row) => [text(row.execution_node_id), integer(row.count)])), revision);
	}
	const changes = graphChanges(current, desired);
	if (body.plan === true) return { teamId, baseRevision: current.revision, desiredRevision: desired.revision, desiredDigest: desired.digest, changes };
	if (!hasChanges(changes)) return current.revision
		? graphRevisionSchema.parse(await store.first('SELECT team_id,revision,rule_revision,changed_source_refs_json,graph_digest,changes_json,created_at FROM execution_graph_revisions WHERE team_id=? ORDER BY revision DESC LIMIT 1', [teamId]).then((row: Row) => ({
			schemaVersion: 'treeseed.graph-revision/v1', teamId: row.team_id, revision: row.revision,
			ruleRevision: row.rule_revision, changedSourceRefs: array(row.changed_source_refs_json),
			graphDigest: row.graph_digest, changes: record(row.changes_json), createdAt: row.created_at,
		}))) : graphRevisionSchema.parse({ schemaVersion: 'treeseed.graph-revision/v1', teamId, revision,
			ruleRevision: 1, changedSourceRefs, graphDigest: desired.digest, changes, createdAt: new Date().toISOString() });
	const revisionRecord = graphRevisionSchema.parse({
		schemaVersion: 'treeseed.graph-revision/v1', teamId, revision, ruleRevision: 1,
		changedSourceRefs, graphDigest: desired.digest, changes, createdAt: new Date().toISOString(),
	});
	return persistExecutionGraph(store, desired, current, revisionRecord);
}

/** Concurrent source changes converge by rereading the winning graph revision. */
export async function reconcileExecutionGraph(store: any, teamId: string, body: Row = {}, ..._trace: unknown[]) {
	for (let attempt = 1; attempt <= 4; attempt += 1) {
		try {
			return await reconcileExecutionGraphOnce(store, teamId, body);
		} catch (error) {
			if (!(error instanceof CapacityOperationError) || error.code !== 'execution_graph_revision_conflict' || attempt === 4) throw error;
		}
	}
	throw new CapacityOperationError(409, 'execution_graph_revision_conflict', 'The execution graph changed concurrently; reconcile again.');
}

export function createExecutionGraphService(store: any) {
	return {
		async show(principal: CapacityPrincipal, teamId: string, query: Row) {
			await authorizeCapacityTeam(store, principal, teamId, 'projects:read:team');
			return visibleGraph(await readGraph(store, teamId), query);
		},
		async watch(principal: CapacityPrincipal, teamId: string, query: Row) {
			await authorizeCapacityTeam(store, principal, teamId, 'projects:read:team');
			const cursor = Math.max(integer(query.cursor), 0);
			const limit = Math.min(Math.max(integer(query.limit) || 100, 1), 500);
			const rows = await store.all(`SELECT * FROM execution_graph_revisions
				WHERE team_id=? AND revision>? ORDER BY revision LIMIT ?`, [teamId,cursor,limit]);
			return {
				items: rows.map((row: Row) => graphRevisionSchema.parse({
					schemaVersion: 'treeseed.graph-revision/v1', teamId: row.team_id, revision: row.revision,
					ruleRevision: row.rule_revision, changedSourceRefs: array(row.changed_source_refs_json),
					graphDigest: row.graph_digest, changes: record(row.changes_json), createdAt: row.created_at,
				})),
				nextCursor: rows.length ? String(rows.at(-1)?.revision) : String(cursor),
			};
		},
		async node(principal: CapacityPrincipal, teamId: string, nodeId: string) {
			await authorizeCapacityTeam(store, principal, teamId, 'projects:read:team');
			const row = await store.first('SELECT * FROM execution_nodes WHERE team_id=? AND id=? LIMIT 1', [teamId,nodeId]);
			if (!row) throw new CapacityOperationError(404, 'execution_node_not_found', 'Execution node not found.');
			return decodeExecutionNode(row);
		},
		async explain(principal: CapacityPrincipal, teamId: string, nodeId: string) {
			const node = await this.node(principal, teamId, nodeId);
			const graph = await readGraph(store, teamId);
			const predecessors = graph.edges.filter((edge) => edge.toNodeId === node.id).map((edge) => {
				const predecessor = graph.nodes.find((candidate) => candidate.id === edge.fromNodeId);
				return { edge, node: predecessor, satisfied: predecessor?.status === 'completed' };
			});
			const blockingReasons = [
				...(node.status === 'proposed' ? ['decision-authority-missing'] : []),
				...predecessors.filter((item) => !item.satisfied).map((item) => `predecessor-incomplete:${item.edge.fromNodeId}`),
			];
			return { node, graphRevision: graph.revision, predecessors, blockingReasons,
				admission: { eligible: node.status === 'ready' && !blockingReasons.length, reasons: blockingReasons } };
		},
		async reconcile(principal: CapacityPrincipal, teamId: string, body: Row) {
			await authorizeCapacityTeam(store, principal, teamId, 'teams:manage:team');
			return reconcileExecutionGraph(store, teamId, body);
		},
		async assignments(principal: CapacityPrincipal, teamId: string, query: Row) {
			await authorizeCapacityTeam(store, principal, teamId, 'projects:read:team');
			return store.listProviderAssignmentsPage(teamId, { limit: Math.min(Math.max(integer(query.limit) || 100, 1), 500), cursor: query.cursor ?? null });
		},
	};
}
