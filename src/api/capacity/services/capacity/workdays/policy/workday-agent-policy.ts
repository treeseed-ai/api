import { ENGINEERING_HANDLER_KINDS,type EngineeringHandlerKind } from '@treeseed/sdk/types/agents';
import { selectWorkdayAgents } from '@treeseed/sdk/agent-capacity';
import { projectAgentActivityRefs,type ProjectAgentActivityRef } from '../../../projects/projects-core/project-agent-activity-refs.ts';

type UnknownRecord = Record<string, unknown>;

export type CapacityWorkdayAgent = {
	nodeId: string;
	slug: string;
	contentPath: string | null;
	handler: EngineeringHandlerKind;
	projectAgentClassId: string;
	projectAgentClassSlug: string;
	purpose: string;
	promptTask: string;
	outputContract: UnknownRecord;
	signalPolicy: UnknownRecord;
	planningIntent: UnknownRecord;
	branchPolicy: UnknownRecord;
	contentAccess: UnknownRecord;
	execution: UnknownRecord;
	planningPriority: number | null;
	planningAllocationPercent: number | null;
	activityType: 'planning' | 'estimating' | 'reviewing' | 'reporting' | 'chat';
};

export type CapacityWorkdayAssignmentIntent = {
	objective: string;
	artifactKind: string;
	subjectModel: string;
	subjectId: string | null;
	includeWorkdayArtifacts: boolean;
};

export type CapacityWorkdayPlanningStage = 'discovery' | 'synthesis' | 'deliberation' | 'evaluation' | 'revision' | 'closeout';
const PLANNING_STAGES = new Set<CapacityWorkdayPlanningStage>(['discovery', 'synthesis', 'deliberation', 'evaluation', 'revision', 'closeout']);

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

export function capacityWorkdayPlanningStage(agent: CapacityWorkdayAgent): CapacityWorkdayPlanningStage {
	const configured = text(record(agent.planningIntent).stage) as CapacityWorkdayPlanningStage;
	if (PLANNING_STAGES.has(configured)) return configured;
	if (agent.activityType === 'reporting') return 'closeout';
	if (agent.activityType === 'estimating' || agent.activityType === 'reviewing') return 'evaluation';
	return 'discovery';
}

function planningStageVariants(profile: UnknownRecord) {
	const intent = record(profile.planningIntent);
	const configured = array(intent.stages).map(record).filter((value) => PLANNING_STAGES.has(text(value.stage) as CapacityWorkdayPlanningStage));
	return configured.length ? configured : [{ stage: text(intent.stage) || null }];
}

export function capacityWorkdayRequiredSignals(agent: CapacityWorkdayAgent): string[] {
	return [...new Set(array(record(agent.signalPolicy).subscribesTo).map((value) => text(record(value).contract)).filter(Boolean))];
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
	const configuredSubjectId = text(configured.subjectId);
	return {
		objective,
		artifactKind: text(configured.artifactKind, requiredArtifacts[0] ?? derivedArtifactKind),
		subjectModel,
		subjectId: configured.subjectId === null || configuredSubjectId.toLowerCase() === 'null'
			? null
			: configuredSubjectId || (subjectModel === 'objective' ? 'core' : null),
		includeWorkdayArtifacts: configured.includeWorkdayArtifacts === true || mutationModel === 'workday_report' || agent.activityType === 'reviewing',
	};
}

export function capacityWorkdayAgentsFromClasses(agentClasses: unknown[], selection?: unknown): CapacityWorkdayAgent[] {
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
		const selectedProfiles = new Map<string, ProjectAgentActivityRef>();
		for (const activityType of ['planning', 'reporting', 'reviewing', 'estimating', 'chat'] as const) {
			for (const ref of projectAgentActivityRefs(handlerRefs, activityType)) selectedProfiles.set(`${ref.agentId}:${ref.activityType}`, ref);
		}
		for (const selectedActivity of selectedProfiles.values()) {
			const slug = selectedActivity.agentId;
			const profile = selectedActivity.profile;
			const configuredHandler = handler(selectedActivity.handlerId);
			if (!configuredHandler) continue;
			const priority = Number(profile.planningPriority);
			for (const stage of planningStageVariants(profile)) agents.push({
				nodeId: `${slug}:${selectedActivity.activityType}:${text(stage.stage, 'discovery')}`,
				slug,
				contentPath: selectedActivity.contentPath,
				handler: configuredHandler,
				projectAgentClassId: text(agentClass.id),
				projectAgentClassSlug: text(agentClass.slug, 'planning'),
				purpose: text(profile.purpose, `Perform configured planning work as ${slug}.`),
				promptTask: text(stage.promptTask, text(record(profile.prompt).task)),
				outputContract: record(profile.outputs),
				signalPolicy: Object.keys(record(stage.signals)).length ? record(stage.signals) : record(profile.signals),
				planningIntent: { ...record(profile.planningIntent), stage: stage.stage },
				branchPolicy: record(profile.branchPolicy),
				contentAccess: record(profile.contentAccess),
				execution: record(profile.execution),
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
	const unique = ordered.filter((agent) => {
		const key = agent.nodeId;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	return selectWorkdayAgents(unique, selection);
}
