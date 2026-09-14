import { createHash } from 'node:crypto';
import {
	assignmentResultSchema,
	effectiveActivityProfileSchema,
	validateAgentDefinitionModel,
	type AssignmentResult,
	type EffectiveActivityProfile,
	type ExecutionNode,
	type ExactEntityReference,
} from '@treeseed/sdk/agent-capacity';
import { validatePortableContentData } from '@treeseed/sdk/content-validation';
import type { DurableCapacityWorkdayRun } from '../../repositories/capacity/workdays/workday-run.ts';
import type { WorkdayProject } from '../capacity/workdays/policy/workday-project-policy.ts';
import { decodeExecutionNode } from '../../../control-plane/repositories/capacity/execution/execution-graph-storage.ts';
import { CapacityGovernanceError } from '../../database.ts';
import { resolveKnowledgeGatewayConnection } from '../../../knowledge/gateway-treedx-connection.ts';
import { selectAssignmentSourceRepository } from '../capacity/assignments/context/source-repository.ts';

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
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const stable = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
	if (value && typeof value === 'object') return `{${Object.entries(value as Row).sort(([a], [b]) => a.localeCompare(b))
		.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
	return JSON.stringify(value);
};
const sha256 = (value: unknown) => `sha256:${createHash('sha256').update(stable(value)).digest('hex')}`;

export interface ReadyExecutionNode {
	node: ExecutionNode;
	graphRevision: number;
	projectAgentClassId: string;
	effectiveProfile: EffectiveActivityProfile;
	contextRefs: ExactEntityReference[];
	sourceRepositories: string[];
	predecessorResults: AssignmentResult[];
	readyAt: string;
}

export function executionNodeRunScope(run: Pick<DurableCapacityWorkdayRun, 'id' | 'executionKind'>) {
	return run.executionKind === 'conversation'
		? { sql: `node.kind='communication' AND node.workday_id=?`, parameters: [run.id] }
		: { sql: `node.kind<>'communication' AND (node.workday_id IS NULL OR node.workday_id=?)`, parameters: [run.id] };
}

async function workItemContext(store: any, node: ExecutionNode): Promise<ExactEntityReference[]> {
	const source = node.sourceRef;
	if (node.kind === 'communication' && source.store === 'treedx' && source.repository && source.commit) {
		const row = await store.first('SELECT content_refs_json FROM agent_invocation_requests WHERE team_id=? AND id=? LIMIT 1',
			[node.teamId,source.id]);
		return array(row?.content_refs_json).map(text).filter(Boolean).map((path, index) => ({
			store: 'treedx' as const, model: path === source.path ? 'discussion' : 'knowledge',
			id: `${source.id}:context:${index + 1}`, repository: source.repository, commit: source.commit, path,
		}));
	}
	if (node.workdayId && source.store === 'postgresql' && source.model === 'workday') {
		const row = await store.first('SELECT parameters_json FROM capacity_workday_runs WHERE team_id=? AND id=? LIMIT 1',
			[node.teamId,node.workdayId]);
		const context = record(record(row?.parameters_json).workdayContextByProjectId)[node.projectId];
		if (!context) throw new CapacityGovernanceError('execution_node_workday_context_missing',
			`Node ${node.id} lacks an exact project context reference.`, 409);
		return [context as ExactEntityReference];
	}
	if (source.store !== 'treedx' || !source.repository || !source.commit || !source.path || !node.workItemId) {
		throw new CapacityGovernanceError('execution_node_source_invalid', `Node ${node.id} lacks exact proposal provenance.`, 409);
	}
	const connection = await resolveKnowledgeGatewayConnection(store, {
		projectId: node.projectId, write: false, relationPaths: true, readRefs: [source.commit],
	});
	if (!connection || connection.repositoryId !== source.repository) throw new CapacityGovernanceError(
		'execution_node_source_repository_changed', `Node ${node.id} proposal repository changed.`, 409);
	const response = record(await connection.client.readRepositoryFile({
		repoId: source.repository, ref: source.commit, path: source.path,
		encoding: 'utf8', parseFrontmatter: true, allowProtected: true,
	}));
	if (text(response.resolvedRef) !== source.commit) throw new CapacityGovernanceError(
		'execution_node_source_moved', `Node ${node.id} proposal source moved.`, 409);
	const file = record(response.file ?? (Array.isArray(response.files) ? response.files[0] : null));
	const validation = validatePortableContentData('proposal', record(file.frontmatter));
	if (!validation.ok) throw new CapacityGovernanceError('execution_node_source_invalid', `Node ${node.id} proposal is no longer valid.`, 409);
	if (node.kind === 'reviewing' && node.pairRole === null) {
		const proposal = record(validation.data);
		return [
			...array(proposal.objectiveRefs),
			...array(proposal.evidenceRefs),
			...(proposal.discussionRef ? [proposal.discussionRef] : []),
		] as ExactEntityReference[];
	}
	const workItems = array(record(record(validation.data).executionPlan).workItems).map(record);
	const workItem = workItems.find((candidate) => text(candidate.id) === node.workItemId);
	if (!workItem) throw new CapacityGovernanceError('execution_node_work_item_missing', `Node ${node.id} work item is missing.`, 409);
	return array(workItem.contextRefs) as ExactEntityReference[];
}

async function effectiveProfile(store: any, node: ExecutionNode): Promise<{ projectAgentClassId: string; profile: EffectiveActivityProfile }> {
	const rows = await store.all(`SELECT id,handler_refs_json FROM project_agent_classes
		WHERE project_id=? AND status='active' ORDER BY id`, [node.projectId]);
	for (const row of rows) for (const candidate of array(record(row.handler_refs_json).agents)) {
		const validation = validateAgentDefinitionModel(candidate);
		if (!validation.ok || !validation.data || validation.data.agentClass !== node.agentClass) continue;
		const activity = node.kind === 'communication' ? 'chat' : node.kind;
		if (!['planning','estimating','acting','reviewing','reporting','chat'].includes(activity)) continue;
		const selected = validation.data.activityProfiles[activity as keyof typeof validation.data.activityProfiles];
		if (!selected) continue;
		return {
			projectAgentClassId: text(row.id),
			profile: effectiveActivityProfileSchema.parse({
				handler: selected.handler,
				prompt: selected.prompt,
				...(selected.additionalContext ? { additionalContext: selected.additionalContext } : {}),
				...(selected.parameters ? { parameters: selected.parameters } : {}),
				profileRef: {
					store: 'treedx', model: 'agent', id: validation.data.id,
					revision: 1, digest: sha256(validation.data),
				},
				activity,
				handlerOrigin: selected.handler.includes('/') ? 'project-runtime' : 'agent-package',
				permissionCeiling: selected.permissions,
			}),
		};
	}
	throw new CapacityGovernanceError('execution_node_agent_profile_missing',
		`Ready node ${node.id} has no exact active ${node.agentClass} ${node.kind} profile.`, 409);
}

async function predecessorResults(store: any, node: ExecutionNode): Promise<AssignmentResult[]> {
	const rows = await store.all(`SELECT result.assignment_result_json
		FROM execution_edges edge
		JOIN execution_nodes predecessor ON predecessor.team_id=edge.team_id AND predecessor.id=edge.from_node_id
		JOIN capacity_provider_assignments result ON result.team_id=edge.team_id
			AND result.execution_node_id=predecessor.id
			AND result.execution_node_revision=predecessor.node_revision
			AND result.status='completed'
		WHERE edge.team_id=? AND edge.to_node_id=? AND edge.graph_revision_removed IS NULL
		ORDER BY edge.id,result.completed_at DESC`, [node.teamId,node.id]);
	if (node.pairRole === 'actor' && node.nodeRevision > 1 && node.workItemId) rows.push(...await store.all(
		`SELECT result.assignment_result_json FROM capacity_provider_assignments result
		WHERE result.team_id=? AND result.execution_node_id=?
		AND result.execution_node_revision<? AND result.status='completed'
		ORDER BY result.execution_node_revision DESC,result.completed_at DESC LIMIT 1`,
		[node.teamId,node.id,node.nodeRevision],
	), ...await store.all(
		`SELECT result.assignment_result_json FROM execution_nodes reviewer
		JOIN capacity_provider_assignments result ON result.team_id=reviewer.team_id
			AND result.execution_node_id=reviewer.id AND result.status='completed'
		WHERE reviewer.team_id=? AND reviewer.project_id=? AND reviewer.work_item_id=? AND reviewer.pair_role='reviewer'
		ORDER BY result.completed_at DESC LIMIT 1`,
		[node.teamId,node.projectId,node.workItemId],
	));
	const results = rows.flatMap((row: Row) => {
		if (!row.assignment_result_json) return [];
		const parsed = assignmentResultSchema.safeParse(record(row.assignment_result_json));
		return parsed.success ? [parsed.data] : [];
	});
	return [...new Map(results.map((result) => [result.id, result])).values()];
}

async function teamCoreContext(store: any, teamId: string): Promise<ExactEntityReference[]> {
	const project = await store.getProjectByTeamAndSlug(teamId, 'team');
	if (!project) throw new CapacityGovernanceError('capacity_team_library_missing', 'The managed Team Library project is unavailable.', 409, { teamId });
	const binding = await store.getProjectTreeDxLibrary(text(project.id));
	const repository = text(binding?.repositoryId, record(record(record(binding?.topology).contentRepository).treeDx).repositoryId);
	const commit = text(record(binding?.metadata).resolvedRef, binding?.contentRepositoryRef);
	if (!repository || !/^[a-f0-9]{40}$/u.test(commit)) throw new CapacityGovernanceError(
		'capacity_team_library_not_ready', 'The managed Team Library has no verified immutable TreeDX view.', 409,
		{ teamId, projectId: project.id },
	);
	return [
		{ store: 'treedx', model: 'knowledge', id: `${text(project.id)}:team-readme`, repository, commit, path: 'README.md' },
		{ store: 'treedx', model: 'objective', id: `${text(project.id)}:team-objective`, repository, commit, path: 'objectives/core' },
	];
}

/** Read ready nodes directly. No capacity-plan or demand record is materialized. */
export async function listReadyExecutionNodes(store: any, run: DurableCapacityWorkdayRun, project: WorkdayProject,
	loadContext: (store: any, node: ExecutionNode) => Promise<ExactEntityReference[]> = workItemContext): Promise<ReadyExecutionNode[]> {
	const runScope = executionNodeRunScope(run);
	const rows = await store.all(`SELECT node.*,revision.revision AS current_graph_revision
		FROM execution_nodes node
		JOIN LATERAL (
			SELECT revision FROM execution_graph_revisions
			WHERE team_id=node.team_id ORDER BY revision DESC LIMIT 1
		) revision ON true
		WHERE node.team_id=? AND node.project_id=? AND node.status='ready' AND node.kind<>'condition'
		AND ${runScope.sql}
		ORDER BY node.updated_at,node.id LIMIT 100`, [run.teamId,project.id,...runScope.parameters]);
	const selectedDecisionIds = new Set(Array.isArray(run.parameters.decisionIds)
		? run.parameters.decisionIds.map(text).filter(Boolean) : []);
	const teamContext = await teamCoreContext(store, run.teamId);
	const ready: ReadyExecutionNode[] = [];
	for (const row of rows) {
		const node = decodeExecutionNode(row);
		const decisionIds = (node.authorityRefs ?? []).filter((reference) => reference.model === 'decision').map((reference) => reference.id);
		if (selectedDecisionIds.size && !decisionIds.some((id) => selectedDecisionIds.has(id))) continue;
		const selected = await effectiveProfile(store, node);
		const sourceRepositories = node.requestedPermissions?.tools.includes('source.read')
			? [selectAssignmentSourceRepository(await store.listHubRepositories(node.projectId)).id]
			: [];
		const loadedContext = await loadContext(store, node);
		const predecessors = await predecessorResults(store, node);
		const candidateRefs = predecessors.flatMap((result) => result.references).flatMap((reference) => {
			if (reference.kind !== 'git') return [];
			const declared = loadedContext.find((item) => item.store === 'git' && item.repository === reference.repository);
			return [{ store: 'git' as const, model: 'repository', id: `${node.id}:candidate`,
				repository: reference.repository, commit: reference.commit, ...(declared?.path ? { path: declared.path } : {}) }];
		});
		ready.push({
			node, graphRevision: Number(row.current_graph_revision),
			projectAgentClassId: selected.projectAgentClassId,
			effectiveProfile: selected.profile,
			sourceRepositories,
			contextRefs: [...new Map([node.sourceRef, ...(node.authorityRefs ?? []), ...teamContext, ...candidateRefs, ...loadedContext]
				.filter((reference) => reference.store === 'git'
					? Boolean(reference.repository && reference.commit)
					: reference.store === 'treedx' && Boolean(reference.repository && reference.commit && reference.path))
				.map((reference) => [stable(reference), reference])).values()],
			predecessorResults: predecessors,
			readyAt: text(row.updated_at),
		});
	}
	return ready;
}
