import { createHash } from 'node:crypto';
import { appliedWorkdaySchema, executionEdgeSchema, executionNodeSchema, validateAgentDefinitionModel,
	type AgentDefinition, type ExecutionEdge, type ExecutionNode, type ExactEntityReference } from '@treeseed/sdk/agent-capacity';
import { workdayParticipants, declaredWorkdayParticipants, selectWorkdayReportingAgents, type WorkdayParticipant } from './workday-participants.ts';
import { modelTurnEstimate } from './model-turn-estimate.ts';
import { agentProfileReference } from './agent-profile-reference.ts';

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
	decisionNodes?: ExecutionNode[]; retainedNodes?: readonly ExecutionNode[]; retainedEdges?: readonly ExecutionEdge[]; issuedNodeIds?: readonly string[] }) {
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
		const declaredIds = new Set(workday.planningRounds.flatMap(round => round.assignmentIds.map(id => {
			const prefix = `planning:${workday.id}:${round.round}:`;
			if (!id.startsWith(prefix)) throw new Error('Frozen planning identity differs from its Workday round');
			return id.slice(prefix.length);
		})));
		const plannedParticipants = workday.state === 'closing'
			? declaredWorkdayParticipants(participation, declaredIds) : participants;
		changedSourceRefs.push(reference);
		const projectIds = array(source.parameters.scheduledProjectIds).map(text).filter(Boolean).sort();
		const roundNodes = new Map<number, ExecutionNode[]>();
		for (const { round } of workday.planningRounds) {
			const plannedIds = new Set(workday.planningRounds.find((candidate) => candidate.round === round)?.assignmentIds ?? []);
			const current: ExecutionNode[] = [];
			for (const id of plannedIds) if (issuedIds.has(id)) {
				const retained = retainedById.get(id)!;
				if (retained.teamId !== input.teamId || retained.workdayId !== workday.id
					|| !['planning', 'estimating'].includes(retained.kind)) throw new Error('Original issued planning node custody differs.');
				current.push(retained); nodes.push(retained);
			}
			for (const participant of plannedParticipants.filter((candidate) => projectIds.includes(candidate.projectId))) {
				const { projectId, definition, activity } = participant;
				const planningSource = record(planningSources[participant.proposalId ?? '']);
					const nodeSource = participant.proposalId && planningSource.store === 'treedx'
					&& planningSource.model === 'proposal' ? planningSource as ExactEntityReference : reference;
				const plannedId = `planning:${workday.id}:${round}:${participant.id}`;
				if (!plannedIds.has(plannedId)) continue;
				if (issuedIds.has(plannedId)) continue;
				const obsolete = workday.state === 'closing';
				if (activity === 'estimating' && (planningSource.store !== 'treedx' || planningSource.model !== 'proposal'
					|| planningSource.id !== participant.proposalId)) throw new Error('Exact original estimating proposal authority required.');
				if (obsolete && retainedById.has(plannedId)) {
					const retained = retainedById.get(plannedId)!;
					if (retained.teamId !== input.teamId || retained.workdayId !== workday.id || retained.kind !== activity
						|| retained.projectId !== projectId) throw new Error('Original planned node custody differs.');
					if (['assigned', 'running'].includes(retained.status)) throw new Error('Active planned node lacks issued authority');
					const closed = ['completed', 'failed', 'cancelled', 'stale'].includes(retained.status) ? retained
						: { ...retained, status: 'cancelled' as const, graphRevisionUpdated: input.revision };
					current.push(closed); nodes.push(closed); continue;
				}
				const profile = definition.activityProfiles[activity]!;
				const proposal = Object.values(source.proposalsByProjectId ?? {}).flat().find(candidate => text(candidate.id) === participant.proposalId);
				const estimatingCriteria = obsolete ? ['Original planned estimating turn cancelled before assignment.'] : [text(proposal?.request)];
				const proposalStatus = source.proposalStatusesByProposalId?.[participant.proposalId ?? ''];
				const node = executionNodeSchema.parse({ schemaVersion: 'treeseed.execution-node/v1', id: plannedId,
					teamId: input.teamId, projectId, workdayId: workday.id, kind: activity, pairRole: null,
					sourceRef: nodeSource, authorityRefs: [reference, agentProfileReference(definition)], ruleRevision: 1, nodeRevision: 1,
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
			for (const estimator of current.filter(node => node.kind === 'estimating' && !issuedIds.has(node.id))) {
				// Estimate after this agent's own contribution. Other agents' planning
				// turns are independent; their explicit profile dependencies still apply.
				const participant = participants.find(value => value.activity === 'estimating'
					&& estimator.id === `planning:${workday.id}:${round}:${value.id}`);
					const contribution = participant && participants.find(value => value.activity === 'planning'
						&& value.projectId === participant.projectId && value.definition.id === participant.definition.id
						&& (value.proposalId === participant.proposalId || value.proposalId === undefined));
					const ownContribution = contribution && current.find(node => node.id === `planning:${workday.id}:${round}:${contribution.id}`);
				if (ownContribution) edges.push(edge(input.teamId, ownContribution.id, estimator.id, 'work-item', reference, input.revision));

			}
			for (const node of current.filter(node => !issuedIds.has(node.id))) for (const predecessor of roundNodes.get(round - 1) ?? []) {
				edges.push(edge(input.teamId, predecessor.id, node.id, 'work-item', reference, input.revision));
			}
			for (const participant of participants) {
				const node = current.find((candidate) => candidate.id === `planning:${workday.id}:${round}:${participant.id}`);
				if (!node || issuedIds.has(node.id)) continue;
				for (const dependency of participant.definition.activityProfiles[participant.activity]?.dependsOn?.agents ?? []) {
					const upstream = participants.filter(candidate => candidate.projectId === participant.projectId
						&& candidate.activity === participant.activity && candidate.proposalId === participant.proposalId
						&& [candidate.definition.id, candidate.definition.id.split('/').at(-1), candidate.definition.name].includes(dependency));
					if (!upstream.length) throw new Error(`Planning dependency ${dependency} is not selected for ${participant.id}.`);
					for (const predecessor of current.filter((candidate) => upstream.some((agent) =>
						candidate.id === `planning:${workday.id}:${round}:${agent.id}`))) {
						edges.push(edge(input.teamId, predecessor.id, node.id, 'profile-agent', reference, input.revision));
					}
				}
			}
		}
		const reportingAgents = selectWorkdayReportingAgents(projectIds.flatMap(projectId =>
			array(record(record(source.parameters.agentProfilesByProjectId)[projectId]).agents).flatMap(entry => {
				const checked = validateAgentDefinitionModel(record(entry).definition);
				if (!checked.ok || !checked.data) throw new Error('The frozen reporting profile is invalid.');
				if (!checked.data.activityProfiles.reporting) return [];
				const definition = checked.data;
				const current = Object.entries(input.profiles).filter(([key, candidate]) => key.startsWith(`${projectId}:`) && candidate.id === definition.id);
				if (current.length !== 1 || stable(current[0]![1]) !== stable(definition)) throw new Error('The reporting profile differs from its frozen Workday authority.');
				return [{ projectId, definition }];
			})), workday.reportingAgentId);
		for (const { projectId, definition: reporter } of reportingAgents) {
			const reporting = reporter.activityProfiles.reporting!;
			const reporterId = `reporting:${workday.id}:${projectId}/${reporter.id}`;
			const report = executionNodeSchema.parse({ schemaVersion: 'treeseed.execution-node/v1', id: reporterId,
				teamId: input.teamId, projectId, workdayId: workday.id, kind: 'reporting', pairRole: null,
				sourceRef: reference, authorityRefs: [reference, agentProfileReference(reporter)], ruleRevision: 1, nodeRevision: 1, agentClass: reporter.agentClass,
				status: 'blocked', estimate: { expectedSeconds: 5, maximumSeconds: 30 },
				// Reporting is deterministic, but admission still requires a provider that
				// explicitly offers the standard reporting execution capability.
				requiredCapabilities: ['treeseed.coordination.reporting'], requestedPermissions: reporting.permissions,
				workspace: 'treedx', acceptanceCriteria: ['Commit one deterministic workday report note.'],
				graphRevisionCreated: input.revision, graphRevisionUpdated: input.revision });
			lifecycleDependencies(report, reporting.dependsOn?.events); nodes.push(report);
		}
		const preserved = new Set([...issuedIds].filter(id => declaredPlanningIds.has(id))), queue = [...preserved];
		for (let index = 0; index < queue.length; index++) for (const prior of input.retainedEdges ?? []) {
			if (prior.toNodeId !== queue[index]) continue;
			if (prior.teamId !== input.teamId) throw new Error('Original issued planning predecessor custody differs.');
			const ancestor = retainedById.get(prior.fromNodeId);
			if (!ancestor || ancestor.teamId !== input.teamId || ancestor.workdayId !== workday.id)
				throw new Error('Original issued planning predecessor custody differs.');
			if (!preserved.has(ancestor.id)) { preserved.add(ancestor.id); queue.push(ancestor.id); }
		}
		for (const id of preserved) {
			const prior = retainedById.get(id)!;
			if (!issuedIds.has(id) && prior.kind !== 'condition' && !['completed', 'failed', 'cancelled', 'stale'].includes(prior.status))
				throw new Error('Original issued predecessor has no terminal or issued authority');
			const currentIndex = nodes.findIndex(node => node.id === id);
			if (currentIndex < 0) nodes.push(prior);
			else if (prior.kind !== 'condition') nodes[currentIndex] = prior;
		}
		edges.push(...(input.retainedEdges ?? []).filter(prior => preserved.has(prior.fromNodeId) && preserved.has(prior.toNodeId)));

	}
	return { nodes, edges: [...new Map(edges.map((candidate) => [candidate.id, candidate])).values()], changedSourceRefs };
}
