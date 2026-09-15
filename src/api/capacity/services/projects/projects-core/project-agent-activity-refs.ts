type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function text(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export interface ProjectAgentActivityRef {
	agentId: string;
	agentName: string;
	groupIds: string[];
	contentPath: string | null;
	contextQueryRefs: Array<{id:string;revision:number}>;
	contextQuerySetRefs: Array<{id:string;revision:number}>;
	contextQueryLayers: {
		agent: {queryRefs:Array<{id:string;revision:number}>;querySetRefs:Array<{id:string;revision:number}>};
		activity: {queryRefs:Array<{id:string;revision:number}>;querySetRefs:Array<{id:string;revision:number}>};
	};
	instructionTemplateRefs: Array<{id:string;revision:number}>;
	activityType: string;
	handlerId: string;
	profile: JsonRecord;
	identity: JsonRecord;
	summary: string | null;
}

function revisionRefs(...values:unknown[]) {
	const refs=values.flatMap((value)=>Array.isArray(value)?value:[]).map(record)
		.filter((value)=>text(value.id)&&Number.isInteger(Number(value.revision))&&Number(value.revision)>0)
		.map((value)=>({id:text(value.id)!,revision:Number(value.revision)}));
	return [...new Map(refs.map((reference)=>[`${reference.id}@${reference.revision}`,reference])).values()];
}

export function projectAgentActivityRefs(handlerRefs: unknown, activityType: string): ProjectAgentActivityRef[] {
	const refs = record(handlerRefs);
	const agents = Array.isArray(refs.agents) ? refs.agents : [];
	return agents.flatMap((candidate) => {
		const validation = validateAgentDefinitionModel(candidate);
		if (!validation.ok || !validation.data) return [];
		const agent = validation.data;
		const profile = record(agent.activityProfiles[activityType as keyof typeof agent.activityProfiles]);
		const agentId = text(agent.id);
		const handlerId = text(profile.handler);
		const agentQueryRefs:Array<{id:string;revision:number}>=[], activityQueryRefs:Array<{id:string;revision:number}>=[];
		const agentQuerySetRefs:Array<{id:string;revision:number}>=[], activityQuerySetRefs:Array<{id:string;revision:number}>=[];
		return agentId && handlerId ? [{
			agentId,
			agentName: agent.name,
			groupIds: [], contentPath: null, activityType, handlerId, profile,
			identity: { purpose: agent.purpose, responsibilities: agent.responsibilities }, summary: agent.purpose,
			contextQueryRefs:revisionRefs(agentQueryRefs,activityQueryRefs),
			contextQuerySetRefs:revisionRefs(agentQuerySetRefs,activityQuerySetRefs),
			contextQueryLayers:{agent:{queryRefs:agentQueryRefs,querySetRefs:agentQuerySetRefs},activity:{queryRefs:activityQueryRefs,querySetRefs:activityQuerySetRefs}},
			instructionTemplateRefs:[],
		}] : [];
	});
}

export function validateProjectAgentActivityRefs(handlerRefs: unknown): string[] {
	const refs = record(handlerRefs);
	if (refs.agents === undefined) return [];
	if (!Array.isArray(refs.agents)) return ['handlerRefs.agents must be an array'];
	return refs.agents.flatMap((value, index) => validateAgentDefinitionModel(value).diagnostics
		.map((diagnostic) => `handlerRefs.agents[${index}].${diagnostic.path}: ${diagnostic.message}`));
}
import { validateAgentDefinitionModel } from '@treeseed/sdk/agent-capacity';
