type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function text(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export interface ProjectAgentActivityRef {
	agentId: string;
	activityType: string;
	handlerId: string;
	profile: JsonRecord;
}

export function projectAgentActivityRefs(handlerRefs: unknown, activityType: string): ProjectAgentActivityRef[] {
	const refs = record(handlerRefs);
	const agents = Array.isArray(refs.agents) ? refs.agents.map(record) : [];
	return agents.flatMap((agent) => {
		const profile = record(record(agent.activities)[activityType]);
		const agentId = text(agent.slug ?? agent.agentId);
		const handlerId = text(profile.handler);
		return agentId && handlerId ? [{ agentId, activityType, handlerId, profile }] : [];
	});
}

const ACTIVITY_TYPES = new Set(['planning', 'estimating', 'reviewing', 'reporting', 'acting']);

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
