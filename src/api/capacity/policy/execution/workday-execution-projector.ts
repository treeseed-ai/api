import { createHash } from 'node:crypto';
import { appliedWorkdaySchema, executionEdgeSchema, executionNodeSchema,
	type AgentDefinition, type ExecutionEdge, type ExecutionNode, type ExactEntityReference } from '@treeseed/sdk/agent-capacity';
import { workdayParticipants, selectWorkdayReportingAgent, type WorkdayParticipant } from './workday-participants.ts';
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
	proposalsByProjectId?: Record<string, Row[]>;
	proposalStatusesByProposalId?: Record<string, string>;
}

function sourceRef(workday: ReturnType<typeof appliedWorkdaySchema.parse>): ExactEntityReference {
	const { schemaVersion, id, teamId, executionMode, policyId, policyRevision, policySnapshot, startsAt, endsAt, reportingAgentId } = workday;
	return { store: 'postgresql', model: 'workday', id, revision: policyRevision,
		digest: digest({ schemaVersion, id, teamId, executionMode, policyId, policyRevision, policySnapshot, startsAt, endsAt,
			...(reportingAgentId === undefined ? {} : { reportingAgentId }) }) };
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
	decisionNodes?: ExecutionNode[]; retainedNodes?: readonly ExecutionNode[]; issuedNodeIds?: readonly string[] }) {
	const nodes: ExecutionNode[] = [], edges: ExecutionEdge[] = [], changedSourceRefs: ExactEntityReference[] = [];
	const retainedById = new Map((input.retainedNodes ?? []).map(node => [node.id, node]));
	const issuedIds = new Set(input.issuedNodeIds ?? []);
	for (const source of [...input.sources].sort((left, right) => left.id.localeCompare(right.id))) {
		const workday = appliedWorkdaySchema.parse(record(source.parameters.appliedPlan));
		const declaredPlanningIds = new Set(workday.planningRounds.flatMap(round => round.assignmentIds));
		for (const id of issuedIds) if (id.startsWith(`planning:${workday.id}:`)) {
			if (!declaredPlanningIds.has(id)) throw new Error('Issued planning turn is absent from its frozen Workday round');
			if (!retainedById.has(id)) throw new Error('Missing original node for an issued planning turn');
		}

		const reference = sourceRef(workday);
		const lifecycleConditions = new Map<string, ExecutionNode>();
		const lifecycleDependencies = (node: ExecutionNode, events: string[] = []) => {
			for (const event of events) {
				if (event !== 'workday-closing') throw new Error(`Unsupported lifecycle dependency ${event}.`);
				const conditionId = `condition:${workday.id}:${node.projectId}:${event}`;
				let condition = lifecycleConditions.get(conditionId);
				if (!condition) {
					condition = executionNodeSchema.parse({ schemaVersion: 'treeseed.execution-node/v1', id: conditionId,
						teamId: input.teamId, projectId: node.projectId, workdayId: workday.id, kind: 'condition', pairRole: null,
						sourceRef: reference, ruleRevision: 1, nodeRevision: 1,
						status: ['closing','ended'].includes(workday.state) ? 'completed' : 'blocked',
						condition: { conditionType: 'lifecycle', subjectRef: reference, expectedState: 'closing' },
						graphRevisionCreated: input.revision, graphRevisionUpdated: input.revision });
					lifecycleConditions.set(conditionId, condition); nodes.push(condition);
				}
				edges.push(edge(input.teamId, condition.id, node.id, 'profile-event', reference, input.revision));
			}
		};
		const planningSources = record(source.parameters.planningSourceByProposalId);
		const participation = { ...source.parameters, proposalsByProjectId: source.proposalsByProjectId };
		const participants = workdayParticipants(participation);
		const requiredIds = new Set(participants.map(participant => participant.id));
		// Closing keeps every original planned identity. Exact completed estimates
		// can cancel a never-admitted obsolete turn, never an issued attempt.
		const plannedParticipants = workday.state === 'closing'
			? [...new Map([
				...workdayParticipants(participation, { includeEstimated: true }),
				// The first group candidate compiled unqualified planning IDs. Close
				// those original unissued turns through the graph; never rewrite its
				// frozen plan or manufacture an assignment/result to finish a round.
				...workdayParticipants({ ...participation, groupIds: [] }, { includeEstimated: true }),
			].map(participant => [participant.id, participant])).values()] : participants;
		changedSourceRefs.push(reference);
		const projectIds = array(source.parameters.scheduledProjectIds).map(text).filter(Boolean).sort();
		const roundNodes = new Map<number, ExecutionNode[]>();
		for (const { round } of workday.planningRounds) {
			const plannedIds = new Set(workday.planningRounds.find((candidate) => candidate.round === round)?.assignmentIds ?? []);
			const current: ExecutionNode[] = [];
			for (const participant of plannedParticipants.filter((candidate) => projectIds.includes(candidate.projectId))) {
				const { projectId, definition, activity } = participant;
				const planningSource = record(planningSources[participant.proposalId ?? '']);
					const nodeSource = participant.proposalId && planningSource.store === 'treedx'
					&& planningSource.model === 'proposal' ? planningSource as ExactEntityReference : reference;
				const plannedId = `planning:${workday.id}:${round}:${participant.id}`;
				if (!plannedIds.has(plannedId)) continue;
				const obsolete = activity === 'estimating' && !requiredIds.has(participant.id);
				if (obsolete) {
					const retained = retainedById.get(plannedId);
					if (retained) {
						if (retained.teamId !== input.teamId || retained.projectId !== projectId || retained.workdayId !== workday.id
							|| retained.kind !== 'estimating' || retained.agentClass !== definition.agentClass) throw new Error('Original planned node custody differs.');
						current.push(retained); nodes.push(retained); continue;
					}
					if (issuedIds.has(plannedId)) throw new Error('Missing original node for an issued planning turn');
					if (planningSource.store !== 'treedx' || planningSource.model !== 'proposal' || planningSource.id !== participant.proposalId)
						throw new Error('Exact original estimating proposal authority required.');
				}
				const profile = definition.activityProfiles[activity]!;
				const proposal = source.proposalsByProjectId?.[projectId]?.find((candidate) => text(candidate.id) === participant.proposalId);
				const workItems = array(record(proposal?.executionPlan).workItems).map(record);
				const workItem = activity === 'estimating' && definition.agentClass !== 'reviewer'
					? workItems.filter((item) => text(item.agentClass) === definition.agentClass
						&& (obsolete || Object.keys(record(item.estimate)).length === 0)) : [];
				if (activity === 'estimating' && (!workItems.length
					|| (definition.agentClass !== 'reviewer' && !workItem.length))) throw new Error(
					`Estimating ${definition.agentClass} requires proposal work items owned by that class.`);
				const estimatingCriteria = definition.agentClass === 'reviewer'
					? workItems.filter((item) => item.review === 'required'
						&& (obsolete || Object.keys(record(item.reviewEstimate)).length === 0)).map((item) =>
						`Estimate the generated review of work item ${text(item.id)} independently: expectedSeconds, maximumSeconds, and rationale.`)
					: workItem.flatMap((item) => [`Estimate work item ${text(item.id)}: expectedSeconds, maximumSeconds, and rationale.`,
						...array(item.acceptanceCriteria).map(text)]);
				const proposalStatus = source.proposalStatusesByProposalId?.[participant.proposalId ?? ''];
				const node = executionNodeSchema.parse({ schemaVersion: 'treeseed.execution-node/v1', id: plannedId,
					teamId: input.teamId, projectId, workdayId: workday.id, kind: activity, pairRole: null,
					...(activity === 'estimating' && definition.agentClass !== 'reviewer' && workItem.length === 1
						? { workItemId: text(workItem[0]?.id) } : {}),
					sourceRef: nodeSource, authorityRefs: [reference], ruleRevision: 1, nodeRevision: 1,
						agentClass: definition.agentClass,
					status: obsolete ? 'cancelled' : activity === 'estimating' && proposalStatus
						&& !['draft', 'submitted', 'open'].includes(proposalStatus)
						? 'cancelled' : 'blocked',
					estimate: modelTurnEstimate(workday.policySnapshot.planningTurnMaximumSeconds),
					requiredCapabilities: [capability(activity)], requestedPermissions: profile.permissions,
						workspace: 'treedx', acceptanceCriteria: activity === 'estimating' ? estimatingCriteria
							: [`Return a useful governed ${activity} contribution${participant.proposalId ? ` to proposal ${participant.proposalId}` : ''} within the assigned round.`],
					graphRevisionCreated: input.revision, graphRevisionUpdated: input.revision });
				lifecycleDependencies(node, profile.dependsOn?.events);
				current.push(node); nodes.push(node);
			}
			roundNodes.set(round, current);
		}
		for (const [round, current] of roundNodes) {
			for (const estimator of current.filter(node => node.kind === 'estimating')) {
				// Estimate after this agent's own contribution. Other agents' planning
				// turns are independent; their explicit profile dependencies still apply.
				const participant = participants.find(value => value.activity === 'estimating'
					&& estimator.id === `planning:${workday.id}:${round}:${value.id}`);
					const contribution = participant && participants.find(value => value.activity === 'planning'
						&& value.projectId === participant.projectId && value.definition.id === participant.definition.id
						&& (value.proposalId === participant.proposalId || value.proposalId === undefined));
					const ownContribution = contribution && current.find(node => node.id === `planning:${workday.id}:${round}:${contribution.id}`);
				if (ownContribution) edges.push(edge(input.teamId, ownContribution.id, estimator.id, 'work-item', reference, input.revision));
				if (estimator.agentClass === 'reviewer') for (const owner of current.filter(node => node.kind === 'estimating'
					&& node.projectId === estimator.projectId && node.sourceRef.id === estimator.sourceRef.id
					&& node.agentClass !== 'reviewer')) {
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
						&& candidate.proposalId === participant.proposalId
						&& (candidate.definition.id === dependency || candidate.definition.agentClass === dependency));
					if (!upstream.length) {
						const frozenAgents = array(record(record(source.parameters.agentProfilesByProjectId)[participant.projectId]).agents)
							.map((entry) => record(record(entry).definition));
						const dependencyDefinition = frozenAgents.find((definition) => text(definition.id) === dependency
							|| text(definition.agentClass) === dependency);
						const dependencyClass = text(dependencyDefinition?.agentClass);
						const selectedProposal = source.proposalsByProjectId?.[participant.projectId]?.find((proposal) => text(proposal.id) === participant.proposalId);
						const proposalItems = array(record(selectedProposal?.executionPlan).workItems).map(record);
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
		const selectedReporter = selectWorkdayReportingAgent(Object.entries(input.profiles).flatMap(([key, definition]) =>
			projectIds.filter(projectId => key.startsWith(`${projectId}:`)).map(projectId => ({ projectId, definition }))), workday.reportingAgentId);
		if (selectedReporter) {
			const { projectId, definition: reporter } = selectedReporter;
			if (workday.reportingAgentId !== undefined) {
				const frozen = array(record(record(source.parameters.agentProfilesByProjectId)[projectId]).agents)
					.map(entry => record(entry).definition).filter(definition => text(record(definition).id) === workday.reportingAgentId);
				if (frozen.length !== 1 || stable(frozen[0]) !== stable(reporter)) throw new Error('The selected reporting profile differs from its frozen Workday authority.');
			}
			const reporting = reporter.activityProfiles.reporting!;
			const reporterId = `reporting:${workday.id}:${projectId}/${reporter.id}`;
			const report = executionNodeSchema.parse({ schemaVersion: 'treeseed.execution-node/v1', id: reporterId,
				teamId: input.teamId, projectId, workdayId: workday.id, kind: 'reporting', pairRole: null,
				sourceRef: reference, authorityRefs: [reference], ruleRevision: 1, nodeRevision: 1, agentClass: reporter.agentClass,
				status: 'blocked', estimate: { expectedSeconds: 5, maximumSeconds: 30 },
				// Reporting is deterministic, but admission still requires a provider that
				// explicitly offers the standard reporting execution capability.
				requiredCapabilities: ['treeseed.coordination.reporting'], requestedPermissions: reporting.permissions,
				workspace: 'treedx', acceptanceCriteria: ['Commit one deterministic workday report note.'],
				graphRevisionCreated: input.revision, graphRevisionUpdated: input.revision });
			lifecycleDependencies(report, reporting.dependsOn?.events); nodes.push(report);
		}
	}
	return { nodes, edges: [...new Map(edges.map((candidate) => [candidate.id, candidate])).values()], changedSourceRefs };
}
