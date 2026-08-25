export interface WorkdayPlanningAgent {
	slug: string;
	activityType?: string | null;
	planningAllocationPercent?: number | null;
	projectAgentClassSlug?: string | null;
	projectAgentClassId?: string | null;
}

export interface WorkdayAgentSelection {
	classIds: string[];
	classSlugs: string[];
	agentSlugs: string[];
	activityTypes: string[];
	mode: 'intersection' | 'union';
}

function uniqueStrings(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))].sort();
}

export function normalizeWorkdayAgentSelection(value: unknown): WorkdayAgentSelection {
	const input = record(value);
	return {
		classIds: uniqueStrings(input.classIds),
		classSlugs: uniqueStrings(input.classSlugs),
		agentSlugs: uniqueStrings(input.agentSlugs),
		activityTypes: uniqueStrings(input.activityTypes),
		mode: input.mode === 'union' ? 'union' : 'intersection',
	};
}

export function workdayAgentSelectionActive(selection: WorkdayAgentSelection): boolean {
	return selection.classIds.length > 0 || selection.classSlugs.length > 0 || selection.agentSlugs.length > 0 || selection.activityTypes.length > 0;
}

export function selectWorkdayAgents<T extends WorkdayPlanningAgent>(agents: T[], value: unknown): T[] {
	const selection = normalizeWorkdayAgentSelection(value);
	if (!workdayAgentSelectionActive(selection)) return agents;
	const classSelectors = new Set([...selection.classIds, ...selection.classSlugs]);
	const agentSelectors = new Set(selection.agentSlugs);
	const activitySelectors = new Set(selection.activityTypes);
	return agents.filter((agent) => {
		const classMatch = classSelectors.size === 0 || [agent.projectAgentClassId, agent.projectAgentClassSlug]
			.some((candidate) => candidate && [...classSelectors].some((selector) => selector === candidate || selector.endsWith(`:${candidate}`)));
		const agentMatch = agentSelectors.size === 0 || agentSelectors.has(agent.slug);
		const activityMatch = activitySelectors.size === 0 || Boolean(agent.activityType && activitySelectors.has(agent.activityType));
		if (selection.mode === 'union') {
			return (classSelectors.size > 0 && classMatch) || (agentSelectors.size > 0 && agentMatch) || (activitySelectors.size > 0 && activityMatch);
		}
		return classMatch && agentMatch && activityMatch;
	});
}

export interface WorkdayExistingAssignment {
	projectId?: string | null;
	project_id?: string | null;
	agentId?: string | null;
	agent_id?: string | null;
	metadata?: Record<string, unknown> | null;
}

export function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function selectFairPlanningAgentCycles<T extends WorkdayPlanningAgent>(projectId: string, agents: T[], existingAssignments: WorkdayExistingAssignment[], limit: number) {
	if (!agents.length || limit <= 0) return [];
	const uniqueAgents = [...new Map(agents
		.filter((agent) => agent.slug.trim())
		.map((agent) => [agent.slug, agent])).values()];
	if (!uniqueAgents.length) return [];
	const cyclesByAgent = new Map<string, Set<number>>();
	for (const assignment of existingAssignments) {
		const metadata = record(assignment.metadata);
		const assignmentProjectId = String(assignment.projectId ?? assignment.project_id ?? '');
		const agentSlug = String(assignment.agentId ?? assignment.agent_id ?? metadata.agentSlug ?? '');
		const cycle = Number(metadata.cycle ?? 1);
		if (assignmentProjectId !== projectId || !agentSlug || !Number.isFinite(cycle) || cycle <= 0) continue;
		const normalizedCycle = Math.floor(cycle);
		const cycles = cyclesByAgent.get(agentSlug) ?? new Set<number>();
		cycles.add(normalizedCycle);
		cyclesByAgent.set(agentSlug, cycles);
	}
	const classes = new Map<string, T[]>();
	for (const agent of uniqueAgents) {
		const classSlug = String(agent.projectAgentClassSlug ?? agent.projectAgentClassId ?? 'planning');
		classes.set(classSlug, [...(classes.get(classSlug) ?? []), agent]);
	}
	const defaultClassPercent = classes.size > 0 ? 100 / classes.size : 100;
	const shares = new Map<string, number>();
	for (const classAgents of classes.values()) {
		const configured = classAgents.map((agent) => Number(agent.planningAllocationPercent ?? Number.NaN)).find((value) => Number.isFinite(value) && value > 0);
		const share = (configured ?? defaultClassPercent) / Math.max(1, classAgents.length);
		for (const agent of classAgents) shares.set(agent.slug, Math.max(0.01, share));
	}
	const selected: Array<{ agent: T; cycle: number }> = [];
	const nextCycle = (agent: T) => {
		const claimed = cyclesByAgent.get(agent.slug) ?? new Set<number>();
		let cycle = 1;
		while (claimed.has(cycle)) cycle += 1;
		return cycle;
	};
	while (selected.length < limit) {
		const minimumCycle = Math.min(...uniqueAgents.map(nextCycle));
		const ranked = uniqueAgents.filter((agent) => nextCycle(agent) === minimumCycle).sort((left, right) => {
			const leftCount = cyclesByAgent.get(left.slug)?.size ?? 0;
			const rightCount = cyclesByAgent.get(right.slug)?.size ?? 0;
			const delta = leftCount / (shares.get(left.slug) ?? 1) - rightCount / (shares.get(right.slug) ?? 1);
			return Math.abs(delta) > 0.000001 ? delta : left.slug.localeCompare(right.slug);
		});
		const agent = ranked[0];
		if (!agent) break;
		const cycle = nextCycle(agent);
		selected.push({ agent, cycle });
		const cycles = cyclesByAgent.get(agent.slug) ?? new Set<number>();
		cycles.add(cycle);
		cyclesByAgent.set(agent.slug, cycles);
	}
	return selected;
}

export function evaluateWorkdayContinuation(input: { status: string; now: string; deadlineAt?: string | null; totalSeconds: number; committedSeconds: number; usefulEligibleWork: boolean }) {
	if (input.status !== 'active' && input.status !== 'running') return { continue: false, reason: 'workday_not_active' as const };
	const deadline = input.deadlineAt ? Date.parse(input.deadlineAt) : Number.POSITIVE_INFINITY;
	if (Number.isFinite(deadline) && deadline <= Date.parse(input.now)) return { continue: false, reason: 'duration_bound_reached' as const };
	if (input.totalSeconds - input.committedSeconds <= 0) return { continue: false, reason: 'budget_bound_reached' as const };
	if (!input.usefulEligibleWork) return { continue: false, reason: 'no_useful_eligible_work' as const };
	return { continue: true, reason: 'within_duration_and_budget' as const };
}
