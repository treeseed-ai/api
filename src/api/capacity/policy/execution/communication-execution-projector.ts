import { createHash } from 'node:crypto';
import { executionNodeSchema, type AgentDefinition, type ExecutionNode, type ExactEntityReference } from '@treeseed/sdk/agent-capacity';
import { modelTurnEstimate } from './model-turn-estimate.ts';

type Row = Record<string, unknown>;
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const stable = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
	if (value && typeof value === 'object') return `{${Object.entries(value as Row).sort(([a], [b]) => a.localeCompare(b))
		.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
	return JSON.stringify(value);
};
const digest = (value: unknown) => `sha256:${createHash('sha256').update(stable(value)).digest('hex')}`;

export interface CommunicationProjectionSource {
	id: string;
	teamId: string;
	projectId: string;
	workdayId: string;
	agentId: string;
	repository: string;
	commit: string;
	path: string;
	durationSeconds: number;
}

function definitionFor(profiles: Record<string, AgentDefinition>, source: CommunicationProjectionSource): AgentDefinition {
	const matches = Object.entries(profiles).filter(([key, definition]) => key.startsWith(`${source.projectId}:`)
		&& (definition.id === source.agentId || definition.id.endsWith(`/${source.agentId}`)));
	if (matches.length !== 1) throw Object.assign(new Error(`Communication agent ${source.agentId} is not uniquely defined.`), {
		code: 'communication_agent_profile_missing',
	});
	return matches[0]![1];
}

/** Project directly addressed messages as ordinary independently admitted graph work. */
export function projectCommunicationInvocations(input: {
	teamId: string;
	revision: number;
	sources: CommunicationProjectionSource[];
	profiles: Record<string, AgentDefinition>;
}): { nodes: ExecutionNode[]; changedSourceRefs: ExactEntityReference[] } {
	const nodes: ExecutionNode[] = [];
	const changedSourceRefs: ExactEntityReference[] = [];
	for (const source of [...input.sources].sort((left, right) => left.id.localeCompare(right.id))) {
		const definition = definitionFor(input.profiles, source);
		const profile = definition.activityProfiles.chat;
		if (!profile) throw Object.assign(new Error(`Agent ${definition.id} does not enable chat.`), {
			code: 'communication_agent_chat_profile_missing',
		});
		const sourceRef: ExactEntityReference = {
			store: 'treedx', model: 'discussion', id: source.id, repository: source.repository,
			commit: source.commit, path: source.path, digest: digest(source),
		};
		changedSourceRefs.push(sourceRef);
		nodes.push(executionNodeSchema.parse({
			schemaVersion: 'treeseed.execution-node/v1', id: `communication:${source.id}:${source.workdayId}`,
			teamId: source.teamId, projectId: source.projectId, workdayId: source.workdayId,
			kind: 'communication', pairRole: null, sourceRef, authorityRefs: [sourceRef],
			ruleRevision: 1, nodeRevision: 1, agentClass: definition.agentClass, status: 'ready',
			estimate: modelTurnEstimate(source.durationSeconds),
			requiredCapabilities: ['treeseed.coordination.conversation'], requestedPermissions: profile.permissions,
			workspace: 'treedx', acceptanceCriteria: ['Return one durable response to the addressed discussion message.'],
			graphRevisionCreated: input.revision, graphRevisionUpdated: input.revision,
		}));
	}
	return { nodes, changedSourceRefs };
}
