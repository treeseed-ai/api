import { createHash } from 'node:crypto';
import { appliedWorkdaySchema, executionEdgeSchema, executionNodeSchema,
	type AgentDefinition, type ExecutionEdge, type ExecutionNode, type ExactEntityReference } from '@treeseed/sdk/agent-capacity';
import { workdayParticipants, type WorkdayParticipant } from './workday-participants.ts';
import { modelTurnEstimate } from './model-turn-estimate.ts';

type Row = Record<string, unknown>;
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const stable = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
	if (value && typeof value === 'object') return `{${Object.entries(value as Row).sort(([a], [b]) => a.localeCompare(b))
		.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
	return JSON.stringify(value);
};
const digest = (value: unknown) => `sha256:${createHash('sha256').update(stable(value)).digest('hex')}`;
const edgeId = (values: unknown[]) => `edge_${createHash('sha256').update(stable(values)).digest('base64url').slice(0, 32)}`;

const capability = (activity: WorkdayParticipant['activity']): string => ({
	planning: 'treeseed.coordination.planning',
	estimating: 'treeseed.coordination.estimation',
	reviewing: 'treeseed.coordination.review',
	reporting: 'treeseed.coordination.reporting',
	chat: 'treeseed.coordination.conversation',
})[activity];

export interface ActiveWorkdayProjectionSource {
	id: string;
	teamId: string;
	parameters: Row;
	proposalsByProjectId?: Record<string, Row>;
	proposalStatusesByProjectId?: Record<string, string>;
}

function sourceRef(workday: ReturnType<typeof appliedWorkdaySchema.parse>): ExactEntityReference {
	const { schemaVersion, id, teamId, executionMode, policyId, policyRevision, policySnapshot, startsAt, endsAt } = workday;
	return { store: 'postgresql', model: 'workday', id, revision: policyRevision,
		digest: digest({ schemaVersion, id, teamId, executionMode, policyId, policyRevision, policySnapshot, startsAt, endsAt }) };
}

function edge(teamId: string, fromNodeId: string, toNodeId: string, provenance: ExecutionEdge['provenance'],
	reference: ExactEntityReference, revision: number): ExecutionEdge {
	return executionEdgeSchema.parse({ schemaVersion: 'treeseed.execution-edge/v1',
		id: edgeId([teamId,fromNodeId,toNodeId,provenance,reference]), teamId, fromNodeId, toNodeId,
		provenance, sourceRef: reference, graphRevisionCreated: revision });
}

/** Project the applied workday plan into ordinary living-graph nodes. */
export function projectActiveWorkdays(input: { teamId: string; revision: number;
	sources: ActiveWorkdayProjectionSource[]; profiles: Record<string, AgentDefinition>;
	decisionNodes?: ExecutionNode[] }) {
	const nodes: ExecutionNode[] = [], edges: ExecutionEdge[] = [], changedSourceRefs: ExactEntityReference[] = [];
	for (const source of [...input.sources].sort((left, right) => left.id.localeCompare(right.id))) {
		const workday = appliedWorkdaySchema.parse(record(source.parameters.appliedPlan));
		const reference = sourceRef(workday);
		const planningSources = record(source.parameters.planningSourceByProjectId);
		const participants = workdayParticipants({ ...source.parameters, proposalsByProjectId: source.proposalsByProjectId });
		changedSourceRefs.push(reference);
		const projectIds = array(source.parameters.scheduledProjectIds).map(text).filter(Boolean).sort();
		const roundNodes = new Map<number, ExecutionNode[]>();
		for (const { round } of workday.planningRounds) {
			const plannedIds = new Set(workday.planningRounds.find((candidate) => candidate.round === round)?.assignmentIds ?? []);
			const current: ExecutionNode[] = [];
			for (const participant of participants.filter((candidate) => projectIds.includes(candidate.projectId))) {
				const { projectId, definition, activity } = participant;
				const planningSource = record(planningSources[projectId]);
				const nodeSource = ['planning','estimating'].includes(activity) && planningSource.store === 'treedx'
					&& planningSource.model === 'proposal' ? planningSource as ExactEntityReference : reference;
				const plannedId = `planning:${workday.id}:${round}:${participant.id}`;
				if (!plannedIds.has(plannedId)) continue;
				const profile = definition.activityProfiles[activity]!;
				const workItems = array(record(source.proposalsByProjectId?.[projectId]?.executionPlan).workItems).map(record);
				const workItem = activity === 'estimating' && definition.agentClass !== 'reviewer'
					? workItems.filter((item) => text(item.agentClass) === definition.agentClass
						&& Object.keys(record(item.estimate)).length === 0) : [];
				if (activity === 'estimating' && (!workItems.length
					|| (definition.agentClass !== 'reviewer' && !workItem.length))) throw new Error(
					`Estimating ${definition.agentClass} requires proposal work items owned by that class.`);
				const estimatingCriteria = definition.agentClass === 'reviewer'
					? workItems.filter((item) => item.review === 'required'
						&& Object.keys(record(item.reviewEstimate)).length === 0).map((item) =>
						`Estimate the generated review of work item ${text(item.id)} independently: minimumSeconds, expectedSeconds, maximumSeconds, and rationale.`)
					: workItem.flatMap((item) => [`Estimate work item ${text(item.id)}: minimumSeconds, expectedSeconds, maximumSeconds, and rationale.`,
						...array(item.acceptanceCriteria).map(text)]);
				const proposalStatus = source.proposalStatusesByProjectId?.[projectId];
				const node = executionNodeSchema.parse({ schemaVersion: 'treeseed.execution-node/v1', id: plannedId,
					teamId: input.teamId, projectId, workdayId: workday.id, kind: activity, pairRole: null,
					...(activity === 'estimating' && definition.agentClass !== 'reviewer' && workItem.length === 1
						? { workItemId: text(workItem[0]?.id) } : {}),
					sourceRef: nodeSource, authorityRefs: [reference], ruleRevision: 1, nodeRevision: 1,
						agentClass: definition.agentClass,
					status: activity === 'estimating' && proposalStatus
						&& !['draft', 'submitted', 'open'].includes(proposalStatus)
						? 'cancelled' : 'blocked',
					estimate: modelTurnEstimate(workday.policySnapshot.planningTurnMaximumSeconds),
					requiredCapabilities: [capability(activity)], requestedPermissions: profile.permissions,
					workspace: 'treedx', acceptanceCriteria: activity === 'estimating' ? estimatingCriteria
						: [`Return the governed ${activity} contribution within the assigned round.`],
					graphRevisionCreated: input.revision, graphRevisionUpdated: input.revision });
				current.push(node); nodes.push(node);
			}
			roundNodes.set(round, current);
		}
		for (const [round, current] of roundNodes) {
			for (const estimator of current.filter(node => node.kind === 'estimating')) {
				for (const contribution of current.filter(node => node.kind === 'planning')) {
					edges.push(edge(input.teamId, contribution.id, estimator.id, 'work-item', reference, input.revision));
				}
				if (estimator.agentClass === 'reviewer') for (const owner of current.filter(node => node.kind === 'estimating'
					&& node.projectId === estimator.projectId && node.agentClass !== 'reviewer')) {
					edges.push(edge(input.teamId, owner.id, estimator.id, 'work-item', reference, input.revision));
				}
			}
			for (const node of current) for (const predecessor of roundNodes.get(round - 1) ?? []) {
				edges.push(edge(input.teamId, predecessor.id, node.id, 'work-item', reference, input.revision));
			}
			for (const participant of participants) {
				const node = current.find((candidate) => candidate.id === `planning:${workday.id}:${round}:${participant.id}`);
				if (!node) continue;
				for (const dependency of participant.definition.activityProfiles[participant.activity]?.dependsOn?.agents ?? []) {
					const upstream = participants.filter((candidate) => candidate.projectId === participant.projectId
						&& candidate.activity === participant.activity
						&& (candidate.definition.id === dependency || candidate.definition.agentClass === dependency));
					if (!upstream.length) {
						const frozenAgents = array(record(record(source.parameters.agentProfilesByProjectId)[participant.projectId]).agents)
							.map((entry) => record(record(entry).definition));
						const dependencyDefinition = frozenAgents.find((definition) => text(definition.id) === dependency
							|| text(definition.agentClass) === dependency);
						const dependencyClass = text(dependencyDefinition?.agentClass);
						const proposalItems = array(record(source.proposalsByProjectId?.[participant.projectId]?.executionPlan).workItems).map(record);
						const ownedItems = dependencyClass === 'reviewer'
							? proposalItems.filter((item) => item.review === 'required')
							: proposalItems.filter((item) => text(item.agentClass) === dependencyClass);
						const alreadyEstimated = participant.activity === 'estimating' && ownedItems.length > 0
							&& ownedItems.every((item) => Object.keys(record(dependencyClass === 'reviewer'
								? item.reviewEstimate : item.estimate)).length > 0);
						if (alreadyEstimated) continue;
						throw new Error(`Planning dependency ${dependency} is not selected for ${participant.id}.`);
					}
					for (const predecessor of current.filter((candidate) => upstream.some((agent) =>
						candidate.id === `planning:${workday.id}:${round}:${agent.id}`))) {
						edges.push(edge(input.teamId, predecessor.id, node.id, 'profile-agent', reference, input.revision));
					}
				}
			}
		}
		for (const projectId of projectIds) {
			const reporter = input.profiles[`${projectId}:reporter`];
			const reporting = reporter?.activityProfiles.reporting;
			if (!reporter || !reporting) continue;
			const conditionId = `condition:${workday.id}:${projectId}:workday-closing`;
			const condition = executionNodeSchema.parse({ schemaVersion: 'treeseed.execution-node/v1', id: conditionId,
				teamId: input.teamId, projectId, workdayId: workday.id, kind: 'condition', pairRole: null,
				sourceRef: reference, ruleRevision: 1, nodeRevision: 1,
				status: ['closing','ended'].includes(workday.state) ? 'completed' : 'blocked',
				condition: { conditionType: 'lifecycle', subjectRef: reference, expectedState: 'closing' },
				graphRevisionCreated: input.revision, graphRevisionUpdated: input.revision });
			const reporterId = `reporting:${workday.id}:${projectId}/${reporter.id}`;
			const report = executionNodeSchema.parse({ schemaVersion: 'treeseed.execution-node/v1', id: reporterId,
				teamId: input.teamId, projectId, workdayId: workday.id, kind: 'reporting', pairRole: null,
				sourceRef: reference, authorityRefs: [reference], ruleRevision: 1, nodeRevision: 1, agentClass: reporter.agentClass,
				status: 'blocked', estimate: { minimumSeconds: 1, expectedSeconds: 5, maximumSeconds: 30 },
				// Reporter is deterministic, but admission still requires a provider that
				// explicitly offers the standard reporting execution capability.
				requiredCapabilities: ['treeseed.coordination.reporting'], requestedPermissions: reporting.permissions,
				workspace: 'treedx', acceptanceCriteria: ['Commit one deterministic workday report note.'],
				graphRevisionCreated: input.revision, graphRevisionUpdated: input.revision });
			nodes.push(condition, report);
			edges.push(edge(input.teamId, condition.id, report.id, 'profile-event', reference, input.revision));
			const selectedDecisions = new Set(array(source.parameters.decisionIds).map(text).filter(Boolean));
			const selected = (input.decisionNodes ?? []).filter((node) => node.projectId === projectId
				&& node.authorityRefs?.some((authority) => authority.model === 'decision' && selectedDecisions.has(authority.id)));
			const terminalByWorkItem = new Map<string, ExecutionNode>();
			for (const node of selected) {
				const key = node.workItemId ?? node.id;
				const current = terminalByWorkItem.get(key);
				if (!current || node.pairRole === 'reviewer') terminalByWorkItem.set(key, node);
			}
			for (const terminal of terminalByWorkItem.values()) {
				edges.push(edge(input.teamId, terminal.id, condition.id, 'work-item', reference, input.revision));
			}
		}
	}
	return { nodes, edges: [...new Map(edges.map((candidate) => [candidate.id, candidate])).values()], changedSourceRefs };
}
