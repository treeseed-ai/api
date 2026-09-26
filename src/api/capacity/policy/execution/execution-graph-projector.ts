import { createHash } from 'node:crypto';
import {
	executionNodeSchema,
	graphRevisionSchema,
	validateExecutionGraph,
	type AgentDefinition,
	type ExecutionEdge,
	type ExecutionNode,
	type ExactEntityReference,
	type GraphRevision,
} from '@treeseed/sdk/agent-capacity';
import { validatePortableContentData } from '@treeseed/sdk/content-validation';

type Row = Record<string, unknown>;

export interface ExecutableProposalSource {
	teamId: string;
	projectId: string;
	repository: string;
	path: string;
	commit: string;
	digest: string;
	proposalRevision: number;
	frontmatter: Row;
	feedback?: Array<{ id: string; kind: 'concern' | 'question'; resolved: boolean; sourceRef: ExactEntityReference }>;
	decision: { id: string; revision: number; digest: string; current: boolean } | null;
}

export interface ExecutionGraphProjection {
	nodes: ExecutionNode[];
	edges: ExecutionEdge[];
	revision: GraphRevision;
}

export interface VerifiedDependencyLink {
	from: ExactEntityReference;
	to: ExactEntityReference;
	sourceRef: ExactEntityReference;
}

const RULE_REVISION = 3;
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(record) : [];

function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
	if (value && typeof value === 'object') return `{${Object.entries(value as Row)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
	return JSON.stringify(value);
}

function sha256(value: unknown): string {
	return `sha256:${createHash('sha256').update(stable(value)).digest('hex')}`;
}

function deterministicId(kind: 'node' | 'edge', values: unknown[]): string {
	return `${kind}_${createHash('sha256').update(stable(values)).digest('base64url').slice(0, 32)}`;
}

function proposalRef(source: ExecutableProposalSource): ExactEntityReference {
	return {
		store: 'treedx', model: 'proposal', id: text(source.frontmatter.id),
		revision: source.proposalRevision, digest: source.digest,
		repository: source.repository, commit: source.commit, path: source.path,
	};
}

function decisionRef(source: ExecutableProposalSource): ExactEntityReference | null {
	if (!source.decision?.current) return null;
	return {
		store: 'postgresql', model: 'decision', id: source.decision.id,
		revision: source.decision.revision, digest: source.decision.digest,
	};
}

function profileFor(profiles: Record<string, AgentDefinition>, projectId: string, agentClass: string, activity: 'acting' | 'reviewing') {
	const profile = profiles[`${projectId}:${agentClass}`]?.activityProfiles[activity];
	if (!profile) throw Object.assign(new Error(`Agent class ${agentClass} has no ${activity} profile.`), {
		code: 'execution_profile_missing', agentClass, activity,
	});
	return profile;
}

function requestedPermissions(workItem: Row, profile: ReturnType<typeof profileFor>, pairRole: 'actor' | 'reviewer') {
	if (pairRole === 'reviewer') return profile.permissions;
	const requested = record(workItem.requestedPermissions);
	const content = record(requested.content);
	const checks = [
		['content.read', content.read, profile.permissions.content.read],
		['content.write', content.write, profile.permissions.content.write],
		['tools', requested.tools, profile.permissions.tools],
	] as const;
	for (const [field, value, ceiling] of checks) {
		const denied = (Array.isArray(value) ? value.map(text) : []).filter((candidate) => !ceiling.includes(candidate as never));
		if (denied.length) throw Object.assign(new Error(`Work item ${workItem.id} requests ${field} outside the activity-profile ceiling.`), {
			code: 'execution_permission_ceiling_exceeded', field, denied,
		});
	}
	return requested;
}

function edge(input: Omit<ExecutionEdge, 'schemaVersion' | 'id' | 'graphRevisionCreated'>, revision: number): ExecutionEdge {
	return {
		schemaVersion: 'treeseed.execution-edge/v1',
		id: deterministicId('edge', [input.teamId, input.fromNodeId, input.toNodeId, input.provenance, input.sourceRef]),
		...input,
		graphRevisionCreated: revision,
	};
}

function workNode(input: {
	source: ExecutableProposalSource;
	workItem: Row;
	profile: ReturnType<typeof profileFor>;
	revision: number;
	pairRole: 'actor' | 'reviewer';
}): ExecutionNode {
	const sourceRef = proposalRef(input.source);
	const itemId = text(input.workItem.id);
	const reviewed = text(input.workItem.review) === 'required';
	const agentClass = input.pairRole === 'reviewer' ? 'reviewer' : text(input.workItem.agentClass);
	const estimate = record(input.pairRole === 'reviewer' ? input.workItem.reviewEstimate : input.workItem.estimate);
	const kind = input.pairRole === 'reviewer' ? 'reviewing' : 'acting';
	const authority = decisionRef(input.source);
	const id = deterministicId('node', [
		input.source.teamId, input.source.projectId, sourceRef.id, sourceRef.revision, sourceRef.digest,
		RULE_REVISION, itemId, kind, agentClass, input.pairRole,
	]);
	return executionNodeSchema.parse({
		schemaVersion: 'treeseed.execution-node/v1', id,
		teamId: input.source.teamId, projectId: input.source.projectId,
		workItemId: itemId, kind, pairRole: input.pairRole, sourceRef,
		authorityRefs: authority ? [authority] : [],
		ruleRevision: RULE_REVISION, nodeRevision: 1, agentClass,
		status: authority ? 'blocked' : 'proposed',
		estimate, requiredCapabilities: input.pairRole === 'reviewer'
			? ['treeseed.engineering.review']
			: Array.isArray(input.workItem.requiredCapabilities) ? input.workItem.requiredCapabilities : [],
		requestedPermissions: requestedPermissions(input.workItem, input.profile, input.pairRole),
		...(input.pairRole === 'actor' && input.workItem.output ? { output: input.workItem.output } : {}),
		workspace: input.pairRole === 'reviewer' ? 'treedx' : input.workItem.workspace,
		acceptanceCriteria: input.workItem.acceptanceCriteria,
		maximumReviewCycles: reviewed ? Number(input.workItem.maximumReviewCycles) : 1,
		graphRevisionCreated: input.revision, graphRevisionUpdated: input.revision,
	});
}

function proposalReviewEstimate(proposal: Row) {
	const items = rows(record(proposal.executionPlan).workItems);
	const estimates = items.map((item) => record(item.reviewEstimate)).filter((estimate) => Number(estimate.expectedSeconds) > 0);
	const selected = estimates.length ? estimates : items.map((item) => record(item.estimate));
	// This is one governance pass over the proposal, not the serial execution
	// of every future Actor/Reviewer pair. The largest bounded review is the
	// conservative existing estimate; summing all pairs exhausts planning before
	// a single proposal can be reviewed.
	return {
		minimumSeconds: Math.max(...selected.map((estimate) => Number(estimate.minimumSeconds))),
		expectedSeconds: Math.max(...selected.map((estimate) => Number(estimate.expectedSeconds))),
		maximumSeconds: Math.max(...selected.map((estimate) => Number(estimate.maximumSeconds))),
	};
}

function proposalReviewNode(source: ExecutableProposalSource, profile: ReturnType<typeof profileFor>, revision: number): ExecutionNode {
	const sourceRef = proposalRef(source);
	return executionNodeSchema.parse({
		schemaVersion: 'treeseed.execution-node/v1',
		id: deterministicId('node', [source.teamId, source.projectId, sourceRef.id, sourceRef.revision,
			sourceRef.digest, RULE_REVISION, 'proposal-review', 'reviewer']),
		teamId: source.teamId, projectId: source.projectId, workItemId: 'proposal-review',
		kind: 'reviewing', pairRole: null, sourceRef, authorityRefs: [sourceRef],
		ruleRevision: RULE_REVISION, nodeRevision: 1, agentClass: 'reviewer',
		status: source.decision?.current ? 'completed' : 'ready',
		estimate: proposalReviewEstimate(source.frontmatter), requiredCapabilities: ['treeseed.engineering.review'],
		requestedPermissions: profile.permissions, workspace: 'treedx',
		acceptanceCriteria: [
			'Validate the exact proposal and its executable work against current project authority.',
			'Return one proposal decision bound to the exact proposal reference.',
		],
		graphRevisionCreated: revision, graphRevisionUpdated: revision,
	});
}

function decisionConditionNode(source: ExecutableProposalSource, revision: number): ExecutionNode {
	const sourceRef = proposalRef(source);
	const authorityRef = decisionRef(source);
	return executionNodeSchema.parse({ schemaVersion: 'treeseed.execution-node/v1',
		id: deterministicId('node', [source.teamId, source.projectId, sourceRef.id, sourceRef.revision,
			sourceRef.digest, RULE_REVISION, 'accepted-decision']),
		teamId: source.teamId, projectId: source.projectId, kind: 'condition', pairRole: null,
		sourceRef, authorityRefs: authorityRef ? [authorityRef] : [],
		ruleRevision: RULE_REVISION, nodeRevision: 1,
		status: source.decision?.current && (source.feedback ?? []).every((feedback) => feedback.resolved) ? 'completed' : 'blocked',
		condition: { conditionType: 'authority', subjectRef: sourceRef, expectedState: 'accepted' },
		graphRevisionCreated: revision, graphRevisionUpdated: revision,
	});
}

function feedbackConditionNode(source: ExecutableProposalSource, feedback: NonNullable<ExecutableProposalSource['feedback']>[number], revision: number): ExecutionNode {
	const sourceRef = proposalRef(source);
	return executionNodeSchema.parse({ schemaVersion: 'treeseed.execution-node/v1',
		id: deterministicId('node', [source.teamId, source.projectId, sourceRef.id, sourceRef.revision,
			sourceRef.digest, RULE_REVISION, 'blocking-feedback', feedback.id]),
		teamId: source.teamId, projectId: source.projectId, kind: 'condition', pairRole: null,
		sourceRef, authorityRefs: [], ruleRevision: RULE_REVISION, nodeRevision: 1,
		status: feedback.resolved ? 'completed' : 'blocked',
		condition: { conditionType: 'question', subjectRef: feedback.sourceRef, expectedState: `feedback:${feedback.id}:resolved` },
		graphRevisionCreated: revision, graphRevisionUpdated: revision,
	});
}

/**
 * Compile exact accepted proposal revisions into the one team execution graph.
 * Estimates define executable units and dependency intent. Provider selection is
 * deliberately absent: admission decides where work runs without changing this DAG.
 */
export function projectTeamExecutionGraph(input: {
	teamId: string;
	revision: number;
	sources: ExecutableProposalSource[];
	profiles: Record<string, AgentDefinition>;
	dependencyLinks?: VerifiedDependencyLink[];
	createdAt?: string;
}): ExecutionGraphProjection {
	const nodes: ExecutionNode[] = [];
	const edges: ExecutionEdge[] = [];
	const changedSourceRefs: ExactEntityReference[] = [];

	for (const source of [...input.sources].sort((left, right) =>
		left.projectId.localeCompare(right.projectId) || left.path.localeCompare(right.path))) {
		const validation = validatePortableContentData('proposal', source.frontmatter);
		if (!validation.ok) throw Object.assign(new Error(`Proposal ${source.path} is invalid.`), {
			code: 'proposal_execution_plan_invalid', diagnostics: validation.diagnostics,
		});
		const proposal = record(validation.data);
		const exactSource = { ...source, frontmatter: proposal };
		const sourceRef = proposalRef(exactSource);
		changedSourceRefs.push(sourceRef);
		const review = proposalReviewNode(exactSource,
			profileFor(input.profiles, source.projectId, 'reviewer', 'reviewing'), input.revision);
		const authority = decisionConditionNode(exactSource, input.revision);
		nodes.push(review, authority);
		edges.push(edge({ teamId: source.teamId, fromNodeId: review.id, toNodeId: authority.id,
			provenance: 'governance', sourceRef }, input.revision));
		for (const feedback of source.feedback ?? []) {
			const condition = feedbackConditionNode(exactSource, feedback, input.revision);
			nodes.push(condition);
			edges.push(edge({ teamId: source.teamId, fromNodeId: condition.id, toNodeId: authority.id,
				provenance: 'governance', sourceRef }, input.revision));
		}
		const workItems = rows(record(proposal.executionPlan).workItems);
		const actorByItem = new Map<string, ExecutionNode>();
		const completionByItem = new Map<string, ExecutionNode>();

		for (const workItem of workItems) {
			const actor = workNode({ source: exactSource, workItem,
				profile: profileFor(input.profiles, source.projectId, text(workItem.agentClass), 'acting'),
				revision: input.revision, pairRole: 'actor' });
			nodes.push(actor);
			edges.push(edge({ teamId: source.teamId, fromNodeId: authority.id, toNodeId: actor.id,
				provenance: 'governance', sourceRef }, input.revision));
			actorByItem.set(text(workItem.id), actor);
			if (text(workItem.review) === 'required') {
				const reviewer = workNode({ source: exactSource, workItem,
					profile: profileFor(input.profiles, source.projectId, 'reviewer', 'reviewing'),
					revision: input.revision, pairRole: 'reviewer' });
				nodes.push(reviewer);
				completionByItem.set(text(workItem.id), reviewer);
				edges.push(edge({ teamId: source.teamId, fromNodeId: actor.id, toNodeId: reviewer.id,
					provenance: 'review-pair', sourceRef }, input.revision));
			} else completionByItem.set(text(workItem.id), actor);
		}

		for (const workItem of workItems) {
			const actor = actorByItem.get(text(workItem.id));
			if (!actor) continue;
			for (const dependency of Array.isArray(workItem.dependsOn) ? workItem.dependsOn.map(text) : []) {
				const predecessor = completionByItem.get(dependency);
				if (!predecessor) throw Object.assign(new Error(`Work item ${workItem.id} depends on missing work item ${dependency}.`), {
					code: 'execution_work_item_dependency_missing',
				});
				edges.push(edge({ teamId: source.teamId, fromNodeId: predecessor.id, toNodeId: actor.id,
					provenance: 'work-item', sourceRef }, input.revision));
			}
			const profile = profileFor(input.profiles, source.projectId, text(workItem.agentClass), 'acting');
			for (const dependencyClass of profile.dependsOn?.agents ?? []) {
				const dependencyItems = workItems.filter((candidate) => text(candidate.agentClass) === dependencyClass);
				for (const dependencyItem of dependencyItems) {
					const predecessor = completionByItem.get(text(dependencyItem.id));
					if (predecessor && predecessor.id !== actor.id) edges.push(edge({ teamId: source.teamId,
						fromNodeId: predecessor.id, toNodeId: actor.id, provenance: 'profile-agent', sourceRef }, input.revision));
				}
				if (!dependencyItems.length) {
					const conditionId = deterministicId('node', [source.teamId,source.projectId,sourceRef.id,
						sourceRef.revision,text(workItem.id),'missing-agent',dependencyClass]);
					if (!nodes.some((candidate) => candidate.id === conditionId)) nodes.push(executionNodeSchema.parse({
						schemaVersion: 'treeseed.execution-node/v1', id: conditionId, teamId: source.teamId,
						projectId: source.projectId, kind: 'condition', pairRole: null, sourceRef, authorityRefs: [],
						ruleRevision: RULE_REVISION, nodeRevision: 1, status: 'blocked',
						condition: { conditionType: 'external', subjectRef: sourceRef,
							expectedState: `agent-class:${dependencyClass}` },
						graphRevisionCreated: input.revision, graphRevisionUpdated: input.revision,
					}));
					edges.push(edge({ teamId: source.teamId, fromNodeId: conditionId, toNodeId: actor.id,
						provenance: 'profile-agent', sourceRef }, input.revision));
				}
			}
		}
	}

	for (const link of input.dependencyLinks ?? []) {
		const endpoint = (ref: ExactEntityReference, role: 'predecessor' | 'dependent') => {
			const item = ref.anchor?.match(/^work-item\/([a-z0-9]+(?:-[a-z0-9]+)*)$/u)?.[1];
			const candidates = nodes.filter((node) => node.sourceRef.store === 'treedx'
				&& node.sourceRef.model === 'proposal' && node.sourceRef.id === ref.id
				&& node.sourceRef.repository === ref.repository && node.sourceRef.commit === ref.commit
				&& node.sourceRef.path === ref.path && node.sourceRef.digest === ref.digest
				&& node.sourceRef.revision === ref.revision && node.workItemId === item);
			return role === 'predecessor'
				? candidates.find((node) => node.pairRole === 'reviewer') ?? candidates.find((node) => node.pairRole === 'actor')
				: candidates.find((node) => node.pairRole === 'actor');
		};
		const predecessor = endpoint(link.from, 'predecessor');
		const dependent = endpoint(link.to, 'dependent');
		if (!predecessor || !dependent) throw Object.assign(new Error('An exact TreeDX dependency endpoint is absent from the selected graph.'), {
			code: 'execution_dependency_endpoint_missing', sourceRef: link.sourceRef,
		});
		edges.push(edge({ teamId: input.teamId, fromNodeId: predecessor.id, toNodeId: dependent.id,
			provenance: 'treedx-link', sourceRef: link.sourceRef }, input.revision));
	}

	const uniqueEdges = [...new Map(edges.map((candidate) => [candidate.id, candidate])).values()];
	const incoming = new Set(uniqueEdges.map((candidate) => candidate.toNodeId));
	for (const node of nodes) {
		if (node.kind !== 'condition' && node.status === 'blocked' && !incoming.has(node.id)) node.status = 'ready';
	}
	nodes.sort((left, right) => left.id.localeCompare(right.id));
	uniqueEdges.sort((left, right) => left.id.localeCompare(right.id));
	const checked = validateExecutionGraph(nodes, uniqueEdges);
	if (!checked.ok) throw Object.assign(new Error('Projected execution graph is invalid.'), {
		code: 'execution_graph_invalid', diagnostics: checked.diagnostics,
	});
	const graphDigest = sha256({ teamId: input.teamId, nodes, edges: uniqueEdges });
	const revision = graphRevisionSchema.parse({
		schemaVersion: 'treeseed.graph-revision/v1', teamId: input.teamId, revision: input.revision,
		ruleRevision: RULE_REVISION, changedSourceRefs, graphDigest,
		changes: { added: nodes.map((node) => node.id), changed: [], completed: [],
			blocked: nodes.filter((node) => node.status === 'blocked').map((node) => node.id),
			stale: [], removedEdges: [], addedEdges: uniqueEdges.map((candidate) => candidate.id) },
		createdAt: input.createdAt ?? new Date().toISOString(),
	});
	return { nodes, edges: uniqueEdges, revision };
}
