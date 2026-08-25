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
	const agents = Array.isArray(refs.agents) ? refs.agents.map(record) : [];
	return agents.flatMap((agent) => {
		if (agent.enabled === false) return [];
		const profile = record(record(agent.activities)[activityType]);
		if (profile.enabled === false) return [];
		const agentId = text(agent.slug ?? agent.agentId);
		const handlerId = text(profile.handler);
		return agentId && handlerId ? [{
			agentId,
			agentName: text(agent.name ?? agent.title) ?? agentId,
			groupIds: Array.isArray(agent.groupIds) ? agent.groupIds.map(String).filter(Boolean) : [],
			contentPath: text(agent.contentPath), activityType, handlerId, profile, identity: record(agent.identity), summary: text(agent.summary),
			contextQueryRefs:revisionRefs(agent.contextQueryRefs,profile.contextQueryRefs),
			contextQuerySetRefs:revisionRefs(agent.contextQuerySetRefs,profile.contextQuerySetRefs),
			instructionTemplateRefs:revisionRefs(agent.instructionTemplateRefs,profile.instructionTemplateRefs),
		}] : [];
	});
}

const ACTIVITY_TYPES = new Set(['planning', 'estimating', 'reviewing', 'reporting', 'acting', 'chat']);

export function validateProjectAgentActivityRefs(handlerRefs: unknown): string[] {
	const refs = record(handlerRefs);
	if (refs.agents === undefined) return [];
	if (!Array.isArray(refs.agents)) return ['handlerRefs.agents must be an array'];
	const issues: string[] = [];
	for (const [index, value] of refs.agents.entries()) {
		const agent = record(value);
		if (!text(agent.slug ?? agent.agentId)) issues.push(`handlerRefs.agents[${index}] requires slug`);
		if ('handler' in agent || 'activityType' in agent) issues.push(`handlerRefs.agents[${index}] must use activities instead of flat handler fields`);
		const activities = record(agent.activities);
		for (const [activityType, profileValue] of Object.entries(activities)) {
			if (!ACTIVITY_TYPES.has(activityType)) issues.push(`handlerRefs.agents[${index}].activities.${activityType} is unsupported`);
			if (!text(record(profileValue).handler)) issues.push(`handlerRefs.agents[${index}].activities.${activityType}.handler is required`);
		}
	}
	return issues;
}
