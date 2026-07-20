import { ENGINEERING_HANDLER_KINDS, type EngineeringHandlerKind } from '@treeseed/sdk/types/agents';
import { projectAgentActivityRefs, type ProjectAgentActivityRef } from './project-agent-activity-refs.ts';

type UnknownRecord = Record<string, unknown>;

export type CapacityWorkdayAgent = {
	slug: string;
	handler: EngineeringHandlerKind;
	projectAgentClassId: string;
	projectAgentClassSlug: string;
	purpose: string;
	promptTask: string;
	outputContract: UnknownRecord;
	planningIntent: UnknownRecord;
	planningPriority: number | null;
	planningAllocationPercent: number | null;
	activityType: 'planning' | 'estimating' | 'reviewing' | 'reporting';
};

export type CapacityWorkdayAssignmentIntent = {
	objective: string;
	artifactKind: string;
	subjectModel: string;
	subjectId: string | null;
	includeWorkdayArtifacts: boolean;
};

function record(value: unknown): UnknownRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {};
}

function array(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function text(value: unknown, fallback = '') {
	return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function handler(value: unknown): EngineeringHandlerKind | null {
	const candidate = text(value);
	return ENGINEERING_HANDLER_KINDS.includes(candidate as EngineeringHandlerKind)
		? candidate as EngineeringHandlerKind
		: null;
}

export function capacityWorkdayRuntimeHandler(agent: Pick<CapacityWorkdayAgent, 'handler'> | UnknownRecord) {
	return handler(agent.handler);
}

export function compileCapacityWorkdayAssignmentIntent(agent: CapacityWorkdayAgent): CapacityWorkdayAssignmentIntent {
	const configured = record(agent.planningIntent);
	const mutations = array(agent.outputContract.modelMutations).map((value) => text(value)).filter(Boolean);
	const requiredArtifacts = array(agent.outputContract.requiredArtifacts).map((value) => text(value)).filter(Boolean);
	const mutationModel = (mutations[0] ?? '').split(':')[0] ?? '';
	const derivedArtifactKind = mutationModel === 'proposal_feedback'
		? 'proposal_feedback_note'
		: mutationModel === 'question'
			? 'planning_question'
			: mutationModel === 'proposal'
				? 'planning_proposal'
				: mutationModel === 'knowledge'
					? 'knowledge_page'
					: mutationModel === 'workday_report'
						? 'workday_summary'
						: 'planning_note';
	const objective = text(
		configured.objective,
		!agent.promptTask || agent.promptTask.toLowerCase() === 'planning' ? agent.purpose : agent.promptTask,
	);
	const subjectModel = text(configured.subjectModel, mutationModel === 'proposal_feedback' ? 'proposal' : 'objective');
	return {
		objective,
		artifactKind: text(configured.artifactKind, requiredArtifacts[0] ?? derivedArtifactKind),
		subjectModel,
		subjectId: configured.subjectId === null ? null : text(configured.subjectId, subjectModel === 'objective' ? 'core' : '') || null,
		includeWorkdayArtifacts: configured.includeWorkdayArtifacts === true || mutationModel === 'workday_report',
	};
}

export function capacityWorkdayAgentsFromClasses(agentClasses: unknown[]): CapacityWorkdayAgent[] {
	const agents: CapacityWorkdayAgent[] = [];
	for (const value of agentClasses) {
		const agentClass = record(value);
		const allowedModes = array(agentClass.allowedModes ?? agentClass.allowed_modes).map((mode) => text(mode));
		if (text(agentClass.status, 'active') !== 'active' || (allowedModes.length > 0 && !allowedModes.includes('planning'))) continue;
		const metadata = record(agentClass.metadata);
		const allocation = Number(
			metadata.planningAllocationPercent
				?? metadata.planningPercent
				?? agentClass.planningAllocationPercent
				?? agentClass.planning_allocation_percent
				?? Number.NaN,
		);
		const handlerRefs = agentClass.handlerRefs ?? agentClass.handler_refs;
		const selectedByAgent = new Map<string, ProjectAgentActivityRef>();
		for (const activityType of ['planning', 'reporting', 'reviewing', 'estimating'] as const) {
			for (const ref of projectAgentActivityRefs(handlerRefs, activityType)) if (!selectedByAgent.has(ref.agentId)) selectedByAgent.set(ref.agentId, ref);
		}
		for (const selectedActivity of selectedByAgent.values()) {
			const slug = selectedActivity.agentId;
			const profile = selectedActivity.profile;
			const configuredHandler = handler(selectedActivity.handlerId);
			if (!configuredHandler) continue;
			const priority = Number(profile.planningPriority);
			agents.push({
				slug,
				handler: configuredHandler,
				projectAgentClassId: text(agentClass.id),
				projectAgentClassSlug: text(agentClass.slug, 'planning'),
				purpose: text(profile.purpose, `Perform configured planning work as ${slug}.`),
				promptTask: text(record(profile.prompt).task),
				outputContract: record(profile.outputs),
				planningIntent: record(profile.planningIntent),
				planningPriority: Number.isFinite(priority) ? priority : null,
				planningAllocationPercent: Number.isFinite(allocation) && allocation > 0 ? allocation : null,
				activityType: selectedActivity.activityType as CapacityWorkdayAgent['activityType'],
			});
		}
	}
	const ordered = agents.sort((left, right) =>
		Number(left.planningPriority ?? Number.MAX_SAFE_INTEGER) - Number(right.planningPriority ?? Number.MAX_SAFE_INTEGER)
		|| left.projectAgentClassSlug.localeCompare(right.projectAgentClassSlug)
		|| left.slug.localeCompare(right.slug),
	);
	const seen = new Set<string>();
	return ordered.filter((agent) => {
		if (seen.has(agent.slug)) return false;
		seen.add(agent.slug);
		return true;
	});
}
