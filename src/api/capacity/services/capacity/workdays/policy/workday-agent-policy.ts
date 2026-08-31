import { ENGINEERING_HANDLER_KINDS,type AgentActivityProfile,type EngineeringHandlerKind } from '@treeseed/sdk/types/agents';
import { type AgentAuthorityPresetId } from '@treeseed/sdk/agent-capacity';
import { compileAgentAuthoritySnapshot } from '../../../../policy/authority/agent-authority-presets.ts';
import { compileDefaultChatActivityProfile } from '../../../../policy/workdays/chat-activity-profile.ts';
import { selectWorkdayAgents } from '../../../../policy/workdays/workday.ts';
import { projectAgentActivityRefs,type ProjectAgentActivityRef } from '../../../projects/projects-core/project-agent-activity-refs.ts';

type UnknownRecord = Record<string, unknown>;

export type CapacityWorkdayAgent = {
	nodeId: string;
	slug: string;
	displayName: string;
	groupIds: string[];
	contentPath: string | null;
	contextQueryRefs:Array<{id:string;revision:number}>;
	contextQuerySetRefs:Array<{id:string;revision:number}>;
	instructionTemplateRefs:Array<{id:string;revision:number}>;
	sourceImmutableRef: string | null;
	handler: EngineeringHandlerKind;
	projectAgentClassId: string;
	projectAgentClassSlug: string;
	purpose: string;
	identity: UnknownRecord;
	summary: string | null;
	promptSystem: string;
	promptTask: string;
	outputContract: UnknownRecord;
	signalPolicy: UnknownRecord;
	planningIntent: UnknownRecord;
	branchPolicy: UnknownRecord;
	permissions: UnknownRecord;
	toolPolicy: UnknownRecord;
	authorityPresetIds: AgentAuthorityPresetId[];
	execution: UnknownRecord;
	capabilityRequirements: UnknownRecord[];
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
	if (value && typeof value === 'object' && !Array.isArray(value)) return value as UnknownRecord;
	if (typeof value === 'string') {
		try { return record(JSON.parse(value)); } catch { return {}; }
	}
	return {};
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
	if (agent.activityType === 'chat') {
		const intent = compileDefaultChatActivityProfile(agent.slug).planningIntent;
		return { objective: text(intent?.objective), artifactKind: text(intent?.artifactKind), subjectModel: text(intent?.subjectModel), subjectId: null, includeWorkdayArtifacts: false };
	}
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
		const metadata = record(agentClass.metadata ?? agentClass.metadata_json);
		const allocation = Number(
			metadata.planningAllocationPercent
				?? metadata.planningPercent
				?? agentClass.planningAllocationPercent
				?? agentClass.planning_allocation_percent
				?? Number.NaN,
		);
		const handlerRefs = agentClass.handlerRefs ?? agentClass.handler_refs ?? record(agentClass.handler_refs_json);
		const selectedProfiles = new Map<string, ProjectAgentActivityRef>();
		for (const activityType of ['planning', 'reporting', 'reviewing', 'estimating', 'chat'] as const) {
			for (const ref of projectAgentActivityRefs(handlerRefs, activityType)) selectedProfiles.set(`${ref.agentId}:${ref.activityType}`, ref);
		}
		for (const selectedActivity of selectedProfiles.values()) {
			const slug = selectedActivity.agentId;
			const configuredProfile = selectedActivity.profile;
			const configuredReasoning = text(record(configuredProfile.execution).reasoningEffort);
			const profile = selectedActivity.activityType === 'chat' ? compileDefaultChatActivityProfile(slug, {
				foundation: 'discussion-v1',
				...(['minimal', 'low', 'medium', 'high', 'xhigh'].includes(configuredReasoning) ? { reasoningEffort: configuredReasoning as 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' } : {}),
			}) : configuredProfile;
			const configuredHandler = handler(selectedActivity.handlerId);
			if (!configuredHandler) continue;
			const authority = compileAgentAuthoritySnapshot(
				selectedActivity.activityType,
				profile as unknown as AgentActivityProfile,
			);
			if (authority.diagnostics.length) continue;
			const priority = Number(profile.planningPriority);
			for (const stage of planningStageVariants(profile)) agents.push({
				nodeId: `${slug}:${selectedActivity.activityType}:${text(stage.stage, 'discovery')}`,
				slug,
				displayName: selectedActivity.agentName,
				groupIds: selectedActivity.groupIds,
				contentPath: selectedActivity.contentPath,
				contextQueryRefs:selectedActivity.contextQueryRefs,
				contextQuerySetRefs:selectedActivity.contextQuerySetRefs,
				instructionTemplateRefs:selectedActivity.instructionTemplateRefs,
				sourceImmutableRef: text(metadata.immutableRef) || null,
				handler: configuredHandler,
				projectAgentClassId: text(agentClass.id),
				projectAgentClassSlug: text(agentClass.slug, 'planning'),
				purpose: text(profile.purpose, `Perform configured planning work as ${slug}.`),
				identity: selectedActivity.identity,
				summary: selectedActivity.summary,
				promptSystem: text(record(profile.prompt).system),
				promptTask: text(stage.promptTask, text(record(profile.prompt).task)),
				outputContract: record(profile.outputs),
				signalPolicy: Object.keys(record(stage.signals)).length ? record(stage.signals) : record(profile.signals),
				planningIntent: { ...record(profile.planningIntent), stage: stage.stage },
				branchPolicy: record(authority.branchPolicy),
				permissions: record(authority.permissions),
				toolPolicy: record(authority.tools),
				authorityPresetIds: authority.presetIds,
				execution: record(profile.execution),
				capabilityRequirements: array(profile.capabilityRequirements).map(record),
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
