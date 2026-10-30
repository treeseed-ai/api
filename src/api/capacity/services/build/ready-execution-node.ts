import {executionNodeRunScope} from './execution-node-scope.ts';
export {executionNodeRunScope} from './execution-node-scope.ts';
import {
	assignmentResultSchema,
	assignmentAttemptSchema,
	appliedWorkdaySchema,
	workdayPlanningEndsAt,
	workdayPhase,
	type AssignmentResult,
	type EffectiveActivityProfile,
	type ExecutionNode,
	type ExactEntityReference,
} from '@treeseed/sdk/agent-capacity';
import type { DurableCapacityWorkdayRun } from '../../repositories/capacity/workdays/workday-run.ts';
import type { WorkdayProject } from '../capacity/workdays/policy/workday-project-policy.ts';
import { decodeExecutionNode } from '../../../control-plane/repositories/capacity/execution/execution-graph-storage.ts';
import { CapacityGovernanceError } from '../../database.ts';
import { selectAssignmentSourceRepository } from '../capacity/assignments/context/source-repository.ts';
import { readExactProposal } from '../../../governance/executable-proposal.ts';
import { workdayLineageSql } from '../capacity/workdays/scheduling/workday-continuation.ts';
import { resolveGitHubSourceAuthority } from '../../../../security/provider-credential-authority.ts';
import { resolveAuthorizedSourceCommit } from '../../../control-plane/repositories/providers/source/source-pin.ts';
import { effectiveProfile } from './execution-node-profile.ts';
import { ContextQueryCheckService, type AssignmentQueryContext } from '../capacity/agents/context-query-check-service.ts';
import { workdayObjectiveContext } from '../capacity/assignments/context/workday-objective-context.ts';
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
const text = (...values: unknown[]): string => values.map((value) => typeof value === 'string' ? value.trim() : '').find(Boolean) ?? '';
const exactCommit = (...values: unknown[]): string => values.map(text).find((value) => /^[a-f0-9]{40}$/u.test(value)) ?? '';
const sharedProposalContextRefs = (proposal: Row) => [
	...array(proposal.objectiveRefs), ...array(proposal.evidenceRefs),
	...(proposal.discussionRef ? [proposal.discussionRef] : []),
];
const proposalContextRefs = (proposal: Row) => [
	...sharedProposalContextRefs(proposal),
	...array(record(proposal.executionPlan).workItems).flatMap(item => array(record(item).contextRefs)),
];
const stable = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
	if (value && typeof value === 'object') return `{${Object.entries(value as Row).sort(([a], [b]) => a.localeCompare(b))
		.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
	return JSON.stringify(value);
};
function repositorySlug(value: unknown): string {
	const candidate = text(value).replace(/\.git$/u, '');
	const match = candidate.match(/(?:github\.com[/:])([^/]+\/[^/]+)$/u);
	return match?.[1] ?? candidate;
}
async function canonicalProposalContextRefs(store: any, node: ExecutionNode, values: unknown[]): Promise<ExactEntityReference[]> {
	const binding = await store.getProjectTreeDxLibrary(node.projectId);
	const repositoryId = text(binding?.repositoryId,
		record(record(record(binding?.topology).contentRepository).treeDx).repositoryId);
	const aliases = new Set([
		repositoryId,
		repositorySlug(binding?.contentRepositoryUrl),
		repositorySlug(record(record(binding?.topology).contentRepository).githubUrl),
	].filter(Boolean));
	return values.map((value) => {
		const reference = record(value) as ExactEntityReference;
		if (reference.store !== 'treedx' || !repositoryId || !aliases.has(repositorySlug(reference.repository))) return reference;
		return { ...reference, repository: repositoryId };
	});
}
export interface ReadyExecutionNode {
	node: ExecutionNode;
	graphRevision: number;
	projectAgentClassId: string;
	effectiveProfile: EffectiveActivityProfile;
	projectContentRepositoryId: string;
	contextRefs: ExactEntityReference[];
	queryContext?: AssignmentQueryContext;
	sourceRepositories: string[];
	predecessorResults: AssignmentResult[];
	lineageSourceCommit?: string;
	directPredecessorSourceCommit?: string;
	readyAt: string;
}

export function linearPredecessorSourceCommit(entries: Array<{ resultId: string; commit: string; predecessorResultIds: string[] }>) {
	const distinct = new Map<string, (typeof entries)[number]>();
	for (const entry of entries) {
		if (!entry.resultId || !/^[a-f0-9]{40}$/u.test(entry.commit)
			|| entry.predecessorResultIds.some(id => !id || id === entry.resultId)
			|| new Set(entry.predecessorResultIds).size !== entry.predecessorResultIds.length) return undefined;
		const prior = distinct.get(entry.resultId);
		if (prior && (prior.commit !== entry.commit || prior.predecessorResultIds.length !== entry.predecessorResultIds.length
			|| prior.predecessorResultIds.some(id => !entry.predecessorResultIds.includes(id)))) return undefined;
		distinct.set(entry.resultId, entry);
	}
	const ancestors = new Map<string, Set<string>>(), visiting = new Set<string>();
	const lineage = (id: string): Set<string> | undefined => {
		if (visiting.has(id)) return undefined;
		const cached = ancestors.get(id); if (cached) return cached;
		visiting.add(id); const found = new Set<string>();
		for (const predecessor of distinct.get(id)!.predecessorResultIds) {
			// Read-only results need not contribute a source commit to this inventory.
			if (!distinct.has(predecessor)) continue;
			const earlier = lineage(predecessor); if (!earlier) return undefined;
			found.add(predecessor); for (const ancestor of earlier) found.add(ancestor);
		}
		visiting.delete(id); ancestors.set(id, found); return found;
	};
	for (const id of distinct.keys()) if (!lineage(id)) return undefined;
	const terminal = [...distinct.values()].filter(entry => ancestors.get(entry.resultId)!.size === distinct.size - 1);
	return terminal.length === 1 ? terminal[0]!.commit : undefined;
}


/** The phase is derived from current approved graph work, never persisted as a second scheduler state. */
export async function runtimeWorkdayPhase(store: any, run: DurableCapacityWorkdayRun, now: string) {
	const plan = appliedWorkdaySchema.parse(run.parameters.appliedPlan);
	if (Date.parse(now) < Date.parse(workdayPlanningEndsAt(plan)) || Date.parse(now) >= Date.parse(plan.endsAt))
		return workdayPhase(plan, now, false);
	const projectIds = array(run.parameters.scheduledProjectIds).map(text).filter(Boolean);
	if (!projectIds.length || run.parameters.planningOnly === true) return workdayPhase(plan, now, false);
	const scope = executionNodeRunScope(run);
	const ready = await store.first(`SELECT node.id FROM execution_nodes node
		WHERE node.team_id=? AND ${scope.sql} AND node.status IN ('ready','assigned','running')
		AND node.kind IN ('acting','reviewing') AND node.pair_role IS NOT NULL
		AND node.project_id IN (${projectIds.map(() => '?').join(',')})
		AND (node.status IN ('assigned','running') OR NOT EXISTS (SELECT 1 FROM capacity_provider_assignments assignment
			WHERE assignment.team_id=node.team_id AND assignment.execution_node_id=node.id
			AND assignment.execution_node_revision=node.node_revision AND assignment.status<>'returned'))
		LIMIT 1`, [run.teamId, ...scope.parameters, ...projectIds]);
	return workdayPhase(plan, now, Boolean(ready));
}

async function projectSourceContext(store: any, node: ExecutionNode, resolved: ExactEntityReference[]) {
	if (!node.requestedPermissions?.tools.includes('source.read')) return resolved;
	const repository = selectAssignmentSourceRepository(await store.listHubRepositories(node.projectId));
	const slug = `${repository.owner}/${repository.name}`;
	if (!resolved.some(reference => reference.store === 'git' && [repository.id, slug].includes(reference.repository ?? ''))) {
		const fetchImpl: typeof fetch | undefined = store.config?.fetchImpl;
		const credential = await resolveGitHubSourceAuthority({ store, teamId: node.teamId, owner: repository.owner,
			repository: repository.name, required: false, fetchImpl });
		const commit = await resolveAuthorizedSourceCommit(repository, credential?.token, fetchImpl);
		resolved.push({ store: 'git', model: 'repository', id: repository.id, repository: slug, commit });
	}
	return resolved;
}

async function readExecutionProposal(store: any, owner: Row, source: ExactEntityReference) {
	const exact = await readExactProposal(store, owner, source);
	if (exact.definition.schemaVersion !== 'treeseed.proposal/v2') throw new CapacityGovernanceError(
		'execution_node_source_version_unsupported', 'Fresh proposal work requires subscriber-owned group contributions; issued legacy attempts retain their original authority.', 409);
	return exact;
}

export async function workItemContext(store: any, node: ExecutionNode): Promise<ExactEntityReference[]> {
	const source = node.sourceRef;
	if (node.kind === 'communication' && source.store === 'treedx' && source.repository && source.commit) {
		const row = await store.first('SELECT content_refs_json,requested_at,metadata_json FROM agent_invocation_requests WHERE team_id=? AND id=? LIMIT 1',
			[node.teamId,source.id]);
		const resolved: ExactEntityReference[] = [];
		for (const [index, value] of array(row?.content_refs_json).entries()) {
			const path = text(value);
			if (path) {
				resolved.push({ store: 'treedx', model: path === source.path ? 'discussion' : 'knowledge',
					id: `${source.id}:context:${index + 1}`, repository: source.repository, commit: source.commit, path });
				continue;
			}
			const reference = record(value);
			if (reference.kind !== 'proposal' || !text(reference.projectId) || !text(reference.id)) {
				throw new CapacityGovernanceError('communication_context_reference_invalid', `Communication node ${node.id} contains an unsupported context reference.`, 409);
			}
			const proposal = await store.getGovernanceProposal(text(reference.id));
			if (!proposal || text(proposal.teamId ?? proposal.team_id) !== node.teamId
				|| text(proposal.projectId ?? proposal.project_id) !== text(reference.projectId)) {
				throw new CapacityGovernanceError('communication_proposal_context_stale', `Communication node ${node.id} references an unavailable proposal.`, 409);
			}
			const digest = text(reference.digest).replace(/^sha256:/u, '');
			const version = await store.first(`SELECT version FROM governance_proposal_versions
				WHERE proposal_id=? AND content_hash=? AND created_at<=? ORDER BY version DESC LIMIT 1`,
				[text(reference.id), digest, text(row?.requested_at)]);
			if (!version) throw new CapacityGovernanceError('communication_proposal_context_stale',
				`Communication node ${node.id} has no governed version for its sent proposal context.`, 409);
			// Discussion is bound to the immutable proposal version at send time.
			// Later genuine estimates may advance the active proposal without
			// invalidating already-admitted planning conversation.
			const exact = await readExactProposal(store, proposal, {
				store: 'treedx', model: 'proposal', id: text(reference.id), revision: Number(version.version),
				repository: text(record(record(proposal.metadata ?? proposal.metadata_json).contentProvenance).repositoryId, source.repository), commit: text(reference.immutableRef),
				path: text(reference.path), digest: text(reference.digest),
			});
			resolved.push(exact.ref, ...await canonicalProposalContextRefs(store,
				{ ...node, projectId: text(reference.projectId) }, proposalContextRefs(exact.definition)));
		}

		const history = record(record(record(row?.metadata_json).communication).historySnapshot);
		const prefix = source.path?.slice(0, source.path.lastIndexOf('/') + 1);
		for (const [index, value] of array(history.messages).entries()) {
			const message = record(value), path = text(message.path), commit = text(message.immutableRef);
			if (history.kind !== 'prior-discussion-messages' || !prefix || !path.startsWith(prefix)
				|| path === source.path || path.split('/').some(part => part === '..' || part === '.' || !part)
				|| !/^[a-f0-9]{40}$/u.test(commit)) throw new CapacityGovernanceError(
				'communication_history_reference_invalid', 'Prior discussion history requires exact commits and paths in the original discussion.', 409);
			resolved.push({ store: 'treedx', model: 'discussion', id: `${source.id}:history:${index + 1}`,
				repository: source.repository, commit, path });
		}
		return projectSourceContext(store, node, resolved);
	}
	if (node.workdayId && source.store === 'postgresql' && source.model === 'workday') {
		const row = await store.first('SELECT parameters_json FROM capacity_workday_runs WHERE team_id=? AND id=? LIMIT 1',
			[node.teamId,node.workdayId]);
		const parameters = record(row?.parameters_json);
		const context = record(parameters.workdayContextByProjectId)[node.projectId];
		if (!context) throw new CapacityGovernanceError('execution_node_workday_context_missing',
			`Node ${node.id} lacks an exact project context reference.`, 409);
		const resolved: ExactEntityReference[] = [context as ExactEntityReference];
		resolved.push(...await workdayObjectiveContext(store, node.projectId, parameters.objectiveRefs,
			context as ExactEntityReference));
		for (const [id, reference] of Object.entries(record(parameters.planningSourceByProposalId))) {
			const proposal = await store.getGovernanceProposal(id);
			if (!proposal || text(proposal.teamId ?? proposal.team_id) !== node.teamId) throw new CapacityGovernanceError(
				'execution_node_workday_source_missing', `Node ${node.id} selected proposal is unavailable.`, 409);
			if (text(proposal.projectId ?? proposal.project_id) !== node.projectId) continue;
			const exact = await readExecutionProposal(store, proposal, reference as ExactEntityReference);
			const workItemRefs = array(record(exact.definition.executionPlan).workItems)
				.flatMap(item => array(record(item).contextRefs));
			resolved.push(exact.ref, ...await canonicalProposalContextRefs(store, node, workItemRefs));
		}
		return projectSourceContext(store, node, resolved);
	}
	if (source.store !== 'treedx' || !source.repository || !source.commit || !source.path) {
		throw new CapacityGovernanceError('execution_node_source_invalid', `Node ${node.id} lacks exact proposal provenance.`, 409);
	}
	const owner = await store.getGovernanceProposal(source.id);
	if (!owner || text(owner.teamId, owner.team_id) !== node.teamId) throw new CapacityGovernanceError(
		'execution_node_source_invalid', `Node ${node.id} proposal is unavailable to this team.`, 409);
	const sourceProjectId = text(owner.projectId, owner.project_id);
	const exact = await readExecutionProposal(store, owner, source);
	if (!node.workItemId && (node.kind === 'planning' || node.kind === 'estimating')) {
		const proposal = exact.definition;
		const refs = [source, ...await canonicalProposalContextRefs(store,
			{ ...node, projectId: sourceProjectId }, proposalContextRefs(proposal))];
		return sourceProjectId !== node.projectId ? projectSourceContext(store, node, refs) : refs;
	}
	const workItems = array(record(exact.definition.executionPlan).workItems).map(record);
	const workItem = workItems.find((candidate) => text(candidate.id) === node.workItemId);
	if (!workItem) throw new CapacityGovernanceError('execution_node_work_item_missing', `Node ${node.id} work item is missing.`, 409);
	return canonicalProposalContextRefs(store, { ...node, projectId: sourceProjectId }, [
		...array(workItem.contextRefs), ...sharedProposalContextRefs(exact.definition),
	]);
}


async function predecessorContext(store: any, node: ExecutionNode, sourceRepository?: string): Promise<{ results: AssignmentResult[]; contentRefs: ExactEntityReference[]; lineageSourceCommit?: string; directPredecessorSourceCommit?: string }> {
	const decisionId = (node.authorityRefs ?? []).find((reference) => reference.model === 'decision')?.id;
	const decisionFilter = (alias: string) => decisionId ? `AND ${alias}.decision_id=?` : '';
	const runFilter = (alias: string) => node.workdayId ? `AND ${alias}.work_day_id IN ${workdayLineageSql('?', `${alias}.team_id`)}` : '';
	const candidateParameters = () => [...(decisionId ? [decisionId] : []), ...(node.workdayId ? [node.workdayId] : [])];
	const predecessorParameters = () => node.workdayId ? [node.workdayId] : [];
	const rows: Row[] = node.kind === 'reporting' ? await store.all(`SELECT assignment_result_json,assignment_attempt_json
		FROM capacity_provider_assignments WHERE team_id=? AND work_day_id=?
			AND status IN ('completed','failed','cancelled','expired','returned') AND assignment_result_json IS NOT NULL
		ORDER BY created_at,id`, [node.teamId, node.workdayId]) : await store.all(`SELECT predecessor.id AS predecessor_node_id,result.assignment_result_json,result.assignment_attempt_json
		FROM execution_edges edge
		JOIN execution_nodes predecessor ON predecessor.team_id=edge.team_id AND predecessor.id=edge.from_node_id
		LEFT JOIN LATERAL (
			SELECT assignment_result_json,assignment_attempt_json FROM capacity_provider_assignments candidate
			WHERE candidate.team_id=edge.team_id AND candidate.execution_node_id=predecessor.id
				AND candidate.status='completed' AND candidate.assignment_result_json IS NOT NULL
				AND candidate.execution_node_revision=predecessor.node_revision
				AND candidate.decision_id IS NOT DISTINCT FROM (
					SELECT authority->>'id' FROM jsonb_array_elements(predecessor.authority_refs_json::jsonb) authority
					WHERE authority->>'model'='decision' LIMIT 1)
				${runFilter('candidate')}
			ORDER BY candidate.execution_node_revision DESC,candidate.completed_at DESC,candidate.id DESC LIMIT 1
		) result ON true
		WHERE edge.team_id=? AND edge.to_node_id=? AND edge.graph_revision_removed IS NULL AND predecessor.kind<>'condition'
		UNION ALL
		SELECT actor.id AS predecessor_node_id,actor_result.assignment_result_json,actor_result.assignment_attempt_json
		FROM execution_edges downstream
		JOIN execution_nodes reviewer ON reviewer.team_id=downstream.team_id AND reviewer.id=downstream.from_node_id
			AND reviewer.kind='reviewing' AND reviewer.pair_role='reviewer' AND reviewer.status='completed'
		JOIN execution_edges pair ON pair.team_id=reviewer.team_id AND pair.to_node_id=reviewer.id
			AND pair.provenance='review-pair' AND pair.graph_revision_removed IS NULL
		JOIN execution_nodes actor ON actor.team_id=pair.team_id AND actor.id=pair.from_node_id
			AND actor.pair_role='actor' AND actor.work_item_id=reviewer.work_item_id
		LEFT JOIN LATERAL (
			SELECT assignment_result_json,assignment_attempt_json FROM capacity_provider_assignments candidate
			WHERE candidate.team_id=actor.team_id AND candidate.execution_node_id=actor.id
				AND candidate.status='completed' AND candidate.assignment_result_json IS NOT NULL
				AND candidate.execution_node_revision=actor.node_revision
				AND candidate.decision_id IS NOT DISTINCT FROM (
					SELECT authority->>'id' FROM jsonb_array_elements(actor.authority_refs_json::jsonb) authority
					WHERE authority->>'model'='decision' LIMIT 1)
				${runFilter('candidate')}
			ORDER BY candidate.execution_node_revision DESC,candidate.completed_at DESC,candidate.id DESC LIMIT 1
		) actor_result ON true
		WHERE downstream.team_id=? AND downstream.to_node_id=? AND downstream.graph_revision_removed IS NULL`,
		[...predecessorParameters(),node.teamId,node.id,...predecessorParameters(),node.teamId,node.id]);
	if (rows.some(row => {
		const result = assignmentResultSchema.safeParse(record(row.assignment_result_json));
		return text(row.predecessor_node_id) && (!result.success || result.data.status !== 'completed');
	})) {
		throw new CapacityGovernanceError('execution_node_predecessor_result_missing',
			'Every required predecessor must retain a canonical result from its own current Decision and node revision.', 409);
	}
	const directCommits = [...new Set(rows.flatMap((row: Row) => {
		const result = assignmentResultSchema.safeParse(record(row.assignment_result_json));
		return result.success ? result.data.references.filter((reference): reference is Extract<typeof reference, { kind: 'git' }> => reference.kind === 'git'
			&& (!sourceRepository || reference.repository === sourceRepository))
			.map((reference) => reference.commit) : [];
	}))];
	const directPredecessorSourceCommit = directCommits.length === 1 ? directCommits[0] : undefined;
	const priorActorRows = node.pairRole === 'actor' && node.nodeRevision > 1 && node.workItemId ? await store.all(
		`SELECT result.assignment_result_json,result.assignment_attempt_json FROM capacity_provider_assignments result
		WHERE result.team_id=? AND result.execution_node_id=?
		AND result.execution_node_revision<? AND result.status='completed'
		${decisionFilter('result')}
		${runFilter('result')}
		ORDER BY result.execution_node_revision DESC,result.completed_at DESC LIMIT 1`,
		[node.teamId,node.id,node.nodeRevision,...candidateParameters()],
	) : [];
	if (node.pairRole === 'actor' && node.nodeRevision > 1 && node.workItemId) rows.push(...priorActorRows, ...await store.all(
		`SELECT result.assignment_result_json,result.assignment_attempt_json FROM execution_nodes reviewer
		JOIN capacity_provider_assignments result ON result.team_id=reviewer.team_id
			AND result.execution_node_id=reviewer.id AND result.status='completed'
		WHERE reviewer.team_id=? AND reviewer.project_id=? AND reviewer.work_item_id=? AND reviewer.pair_role='reviewer'
		${decisionFilter('result')}
		${runFilter('result')}
		ORDER BY result.completed_at DESC LIMIT 1`,
		[node.teamId,node.projectId,node.workItemId,...candidateParameters()],
	));
	const results: AssignmentResult[] = rows.flatMap((row: Row) => {
		if (!row.assignment_result_json) return [];
		const parsed = assignmentResultSchema.safeParse(record(row.assignment_result_json));
		return parsed.success ? [parsed.data] : [];
	});
	const contentRefs: ExactEntityReference[] = rows.flatMap((row: Row) => {
		const parsed = assignmentResultSchema.safeParse(record(row.assignment_result_json));
		if (!parsed.success) return [];
		const grants = array(record(record(row.assignment_attempt_json).grant).contentWrite).map(record);
		return parsed.data.references.flatMap((reference) => {
			if (reference.kind !== 'treedx') return [];
			const target = grants.find(grant => grant.store === 'treedx' && grant.repository === reference.repository && grant.path === reference.path);
			if (!target || !text(target.model) || !text(target.id)) return [];
			return [{ store: 'treedx' as const, model: text(target.model), id: text(target.id),
				repository: reference.repository, commit: reference.commit, path: reference.path }];
		});
	});
	const gitResults = rows.flatMap((row: Row) => {
		const result = assignmentResultSchema.safeParse(record(row.assignment_result_json));
		const attempt = assignmentAttemptSchema.safeParse(record(row.assignment_attempt_json));
		if (!result.success || !attempt.success) return [];
		return result.data.references.filter((reference): reference is Extract<typeof reference, { kind: 'git' }> => reference.kind === 'git'
			&& (!sourceRepository || reference.repository === sourceRepository))
			.map((reference) => ({ resultId: result.data.id, commit: reference.commit,
				predecessorResultIds: attempt.data.predecessorResultIds }));
	});
	const lineageSourceCommit = linearPredecessorSourceCommit(gitResults);
	return { results: [...new Map(results.map((result) => [result.id, result])).values()],
		...(lineageSourceCommit ? { lineageSourceCommit } : {}),
		...(directPredecessorSourceCommit ? { directPredecessorSourceCommit } : {}),
		contentRefs: [...new Map(contentRefs.map(reference => [stable(reference), reference])).values()] };
}

async function teamCoreContext(store: any, teamId: string): Promise<ExactEntityReference[]> {
	const project = await store.getProjectByTeamAndSlug(teamId, 'team');
	if (!project) throw new CapacityGovernanceError('capacity_team_library_missing', 'The managed Team Library project is unavailable.', 409, { teamId });
	const binding = await store.getProjectTreeDxLibrary(text(project.id));
	const repository = text(binding?.repositoryId, record(record(record(binding?.topology).contentRepository).treeDx).repositoryId);
	const commit = exactCommit(binding?.contentRepositoryRef,
		record(record(record(binding?.topology).contentRepository)).ref,
		record(binding?.metadata).resolvedRef);
	if (!repository || !/^[a-f0-9]{40}$/u.test(commit)) throw new CapacityGovernanceError(
		'capacity_team_library_not_ready', 'The managed Team Library has no verified immutable TreeDX view.', 409,
		{ teamId, projectId: project.id },
	);
	return [
		{ store: 'treedx', model: 'knowledge', id: `${text(project.id)}:team-readme`, repository, commit, path: 'README.md' },
		{ store: 'treedx', model: 'objective', id: `${text(project.id)}:team-objective`, repository, commit, path: 'objectives/core' },
	];
}

async function projectCoreContext(store: any, project: WorkdayProject): Promise<ExactEntityReference[]> {
	const binding = await store.getProjectTreeDxLibrary(text(project.id));
	const repository = text(binding?.repositoryId, record(record(record(binding?.topology).contentRepository).treeDx).repositoryId);
	const commit = exactCommit(binding?.contentRepositoryRef,
		record(record(record(binding?.topology).contentRepository)).ref,
		record(binding?.metadata).resolvedRef);
	if (!repository || !/^[a-f0-9]{40}$/u.test(commit)) throw new CapacityGovernanceError(
		'capacity_project_library_not_ready', 'The project library has no verified immutable TreeDX view.', 409,
		{ projectId: project.id },
	);
	return [{ store: 'treedx', model: 'objective', id: `${text(project.id)}:project-objective`, repository, commit, path: 'objectives/core' }];
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
		AND NOT EXISTS (
			SELECT 1 FROM capacity_provider_assignments assignment
			WHERE assignment.team_id=node.team_id
			AND assignment.execution_node_id=node.id
			AND assignment.execution_node_revision=node.node_revision
			AND assignment.status<>'returned'
		)
		ORDER BY node.updated_at,node.id LIMIT 100`, [run.teamId,project.id,...runScope.parameters]);
	const selectedDecisionIds = new Set(Array.isArray(run.parameters.decisionIds)
		? run.parameters.decisionIds.map(text).filter(Boolean) : []);
	const teamContext = await teamCoreContext(store, run.teamId);
	const projectContext = await projectCoreContext(store, project);
	const ready: ReadyExecutionNode[] = [];
	for (const row of rows) {
		const node = decodeExecutionNode(row);
		const decisionIds = (node.authorityRefs ?? []).filter((reference) => reference.model === 'decision').map((reference) => reference.id);
		// A workday's decision selection constrains only nodes whose authority is a
		// decision. Cooperative planning and lifecycle reporting are authorized by
		// the workday itself and must remain eligible in that same run.
		if (selectedDecisionIds.size && decisionIds.length && !decisionIds.some((id) => selectedDecisionIds.has(id))) continue;
		const selected = await effectiveProfile(store, node);
		const queries = Object.values(selected.contextQueryLayers).some(layer => layer.queryRefs.length || layer.querySetRefs.length)
			? await new ContextQueryCheckService(store).resolveForAssignment({ teamId: node.teamId, projectId: node.projectId,
				definitionRef: selected.profile.profileRef.commit!, dataRef: projectContext[0]!.commit!,
				allowedModels: selected.profile.permissionCeiling.content.read, layers: selected.contextQueryLayers }) : undefined;
		const sourceRepository = node.requestedPermissions?.tools.includes('source.read')
			? selectAssignmentSourceRepository(await store.listHubRepositories(node.projectId)) : undefined;
		const sourceRepositories = sourceRepository ? [`${sourceRepository.owner}/${sourceRepository.name}`] : [];
		const loadedContext = await loadContext(store, node);
		const predecessor = await predecessorContext(store, node,
			sourceRepositories[0] ?? loadedContext.find((item) => item.store === 'git')?.repository);
		const predecessors = predecessor.results;
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
			...(queries ? { queryContext: queries } : {}),
			projectContentRepositoryId: projectContext[0]!.repository!,
			sourceRepositories,
			contextRefs: [...new Map([node.sourceRef, ...(node.authorityRefs ?? []), ...teamContext, ...projectContext, ...candidateRefs, ...predecessor.contentRefs, ...loadedContext, ...queries?.references ?? []]
				.filter((reference) => reference.store === 'git'
					? Boolean(reference.repository && reference.commit)
					: reference.store === 'treedx' && Boolean(reference.repository && reference.commit && reference.path))
				.map((reference) => [stable(reference), reference])).values()],
			predecessorResults: predecessors,
			...(predecessor.lineageSourceCommit ? { lineageSourceCommit: predecessor.lineageSourceCommit } : {}),
			...(predecessor.directPredecessorSourceCommit
				? { directPredecessorSourceCommit: predecessor.directPredecessorSourceCommit } : {}),
			readyAt: text(row.updated_at),
		});
	}
	return ready;
}
