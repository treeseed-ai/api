import { createHash } from 'node:crypto';
import { appliedWorkdaySchema, executionEdgeSchema, executionNodeSchema,
	type AgentDefinition, type ExecutionEdge, type ExecutionNode, type ExactEntityReference } from '@treeseed/sdk/agent-capacity';
import { workdayParticipants, type WorkdayParticipant } from './workday-participants.ts';

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

const nodeKind = (activity: WorkdayParticipant['activity']): ExecutionNode['kind'] => activity === 'chat' ? 'communication' : activity;
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
}

function sourceRef(workday: ReturnType<typeof appliedWorkdaySchema.parse>): ExactEntityReference {
	return { store: 'postgresql', model: 'workday', id: workday.id, revision: workday.policyRevision, digest: digest(workday) };
}

function edge(teamId: string, fromNodeId: string, toNodeId: string, provenance: ExecutionEdge['provenance'],
	reference: ExactEntityReference, revision: number): ExecutionEdge {
	return executionEdgeSchema.parse({ schemaVersion: 'treeseed.execution-edge/v1',
		id: edgeId([teamId,fromNodeId,toNodeId,provenance,reference]), teamId, fromNodeId, toNodeId,
		provenance, sourceRef: reference, graphRevisionCreated: revision });
}

/** Project the applied workday plan into ordinary living-graph nodes. */
export function projectActiveWorkdays(input: { teamId: string; revision: number;
	sources: ActiveWorkdayProjectionSource[]; profiles: Record<string, AgentDefinition> }) {
	const nodes: ExecutionNode[] = [], edges: ExecutionEdge[] = [], changedSourceRefs: ExactEntityReference[] = [];
	for (const source of [...input.sources].sort((left, right) => left.id.localeCompare(right.id))) {
		const workday = appliedWorkdaySchema.parse(record(source.parameters.appliedPlan));
		const reference = sourceRef(workday);
		const participants = workdayParticipants(source.parameters);
		changedSourceRefs.push(reference);
		const projectIds = array(source.parameters.scheduledProjectIds).map(text).filter(Boolean).sort();
		const roundNodes = new Map<number, ExecutionNode[]>();
		for (const round of [1, 2] as const) {
			const plannedIds = new Set(workday.planningRounds.find((candidate) => candidate.round === round)?.assignmentIds ?? []);
			const current: ExecutionNode[] = [];
			for (const participant of participants.filter((candidate) => projectIds.includes(candidate.projectId))) {
				const { projectId, definition, activity } = participant;
				const plannedId = `planning:${workday.id}:${round}:${participant.id}`;
				if (!plannedIds.has(plannedId)) continue;
				const profile = definition.activityProfiles[activity]!;
				const node = executionNodeSchema.parse({ schemaVersion: 'treeseed.execution-node/v1', id: plannedId,
					teamId: input.teamId, projectId, workdayId: workday.id, kind: nodeKind(activity), pairRole: null,
					sourceRef: reference, authorityRefs: [reference], ruleRevision: 1, nodeRevision: 1,
					agentClass: definition.agentClass, status: 'blocked',
					estimate: { minimumSeconds: 1, expectedSeconds: workday.policySnapshot.planningSecondsPerAgent,
						maximumSeconds: workday.policySnapshot.planningSecondsPerAgent },
					requiredCapabilities: [capability(activity)], requestedPermissions: profile.permissions,
					workspace: 'treedx', acceptanceCriteria: [`Return the governed ${activity} contribution within the assigned round.`],
					graphRevisionCreated: input.revision, graphRevisionUpdated: input.revision });
				current.push(node); nodes.push(node);
			}
			roundNodes.set(round, current);
		}
		for (const node of roundNodes.get(2) ?? []) for (const predecessor of roundNodes.get(1) ?? []) {
			edges.push(edge(input.teamId, predecessor.id, node.id, 'work-item', reference, input.revision));
		}
		for (const round of [1, 2] as const) for (const node of roundNodes.get(round) ?? []) {
			const participant = participants.find((candidate) => node.id === `planning:${workday.id}:${round}:${candidate.id}`);
			const profile = participant?.definition.activityProfiles[participant.activity];
			for (const dependencyClass of profile?.dependsOn?.agents ?? []) for (const predecessor of roundNodes.get(round) ?? []) {
				if (predecessor.projectId === node.projectId && predecessor.agentClass === dependencyClass) {
					edges.push(edge(input.teamId, predecessor.id, node.id, 'profile-agent', reference, input.revision));
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
		}
	}
	return { nodes, edges: [...new Map(edges.map((candidate) => [candidate.id, candidate])).values()], changedSourceRefs };
}
