import { createHash } from 'node:crypto';
import { MAX_CAPACITY_PAGE_LIMIT, type CapacityPage } from '@treeseed/sdk/capacity-pagination';
import { validateAgentDefinitionModel, type AgentDefinition } from '@treeseed/sdk/agent-capacity';
import { CapacityGovernanceError } from '../../../../database.ts';
import { normalizeWorkdayAgentSelection } from '../../../../policy/workdays/workday.ts';

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

export interface WorkdayAgentSelectionSnapshot {
	definition: AgentDefinition;
	projectAgentClassId: string;
	projectAgentClassSlug: string;
	activities: Array<keyof AgentDefinition['activityProfiles']>;
}
export interface WorkdayAgentProfileSnapshot { revision: string; agents: WorkdayAgentSelectionSnapshot[] }
interface Store { listProjectAgentClassesPage(projectId: string, filters: { limit: number }): Promise<CapacityPage<unknown>> }

export function compileWorkdayAgentProfileSnapshot(agentClasses: unknown[], selectionValue?: unknown): WorkdayAgentProfileSnapshot {
	const selection = normalizeWorkdayAgentSelection(selectionValue);
	const available: WorkdayAgentSelectionSnapshot[] = [];
	for (const value of agentClasses) {
		const row = record(value);
		if (text(row.status || 'active') !== 'active') continue;
		for (const candidate of array(record(row.handlerRefs ?? row.handler_refs ?? row.handler_refs_json).agents)) {
			const validation = validateAgentDefinitionModel(candidate);
			if (!validation.ok || !validation.data) throw new CapacityGovernanceError(
				'capacity_workday_agent_profile_invalid', 'An active project agent class contains an invalid minimal agent definition.', 409,
				{ projectAgentClassId: text(row.id), diagnostics: validation.diagnostics });
			const activities = Object.keys(validation.data.activityProfiles) as WorkdayAgentSelectionSnapshot['activities'];
			available.push({ definition: validation.data, projectAgentClassId: text(row.id),
				projectAgentClassSlug: text(row.slug) || validation.data.agentClass, activities });
		}
	}
	const selectorMatch = (entry: WorkdayAgentSelectionSnapshot, activity: string) => {
		const classMatch = !selection.classIds.length && !selection.classSlugs.length
			|| selection.classIds.includes(entry.projectAgentClassId) || selection.classSlugs.includes(entry.projectAgentClassSlug)
			|| selection.classSlugs.includes(entry.definition.agentClass);
		const agentNames = [entry.definition.id, entry.definition.id.split('/').at(-1) ?? entry.definition.id];
		const agentMatch = !selection.agentSlugs.length || selection.agentSlugs.some((id) => agentNames.includes(id));
		const activityMatch = !selection.activityTypes.length || selection.activityTypes.includes(activity);
		return selection.mode === 'union'
			? (selection.classIds.length + selection.classSlugs.length > 0 && classMatch)
				|| (selection.agentSlugs.length > 0 && agentMatch) || (selection.activityTypes.length > 0 && activityMatch)
			: classMatch && agentMatch && activityMatch;
	};
	const agents = available.map((entry) => ({ ...entry, activities: entry.activities.filter((activity) => selectorMatch(entry, activity)) }))
		.filter((entry) => entry.activities.length).sort((left, right) => left.definition.id.localeCompare(right.definition.id));
	const unknown = [
		...selection.classIds.filter((id) => !available.some((entry) => entry.projectAgentClassId === id)).map((value) => ({ selector: 'classIds', value })),
		...selection.classSlugs.filter((id) => !available.some((entry) => [entry.projectAgentClassSlug,entry.definition.agentClass].includes(id))).map((value) => ({ selector: 'classSlugs', value })),
		...selection.agentSlugs.filter((id) => !available.some((entry) => [entry.definition.id,entry.definition.id.split('/').at(-1)].includes(id))).map((value) => ({ selector: 'agentSlugs', value })),
		...selection.activityTypes.filter((id) => !available.some((entry) => entry.activities.includes(id as never))).map((value) => ({ selector: 'activityTypes', value })),
	];
	if (unknown.length) throw new CapacityGovernanceError('capacity_workday_agent_selection_unknown',
		'Workday selectors must identify eligible activity profiles exactly.', 409, { unknown });
	if (!agents.length) throw new CapacityGovernanceError('capacity_workday_agent_selection_empty',
		'Workday selection resolved no eligible activity profiles.', 409);
	const revision = createHash('sha256').update(stable(agents)).digest('hex');
	return { revision, agents };
}

export async function resolveWorkdayAgentProfileSnapshot(store: Store, projectId: string, selection?: unknown) {
	const page = await store.listProjectAgentClassesPage(projectId, { limit: MAX_CAPACITY_PAGE_LIMIT });
	if (page.page.hasMore) throw new CapacityGovernanceError('capacity_internal_collection_bound_exceeded',
		'Project agent classes exceed the activity-profile snapshot bound.', 409, { projectId });
	return compileWorkdayAgentProfileSnapshot(page.items, selection);
}

export function decodeWorkdayAgentProfileSnapshot(value: unknown, projectId: string): WorkdayAgentProfileSnapshot {
	const snapshot = record(value);
	if (!Array.isArray(snapshot.agents) || typeof snapshot.revision !== 'string') throw new CapacityGovernanceError(
		'capacity_workday_agent_profile_snapshot_invalid', 'Workday activity-profile snapshot is missing or corrupt.', 500, { projectId });
	const agents = snapshot.agents.map(record).map((entry) => {
		const validation = validateAgentDefinitionModel(entry.definition);
		if (!validation.ok || !validation.data || !Array.isArray(entry.activities)) throw new CapacityGovernanceError(
			'capacity_workday_agent_profile_snapshot_invalid', 'Workday activity-profile snapshot contains an invalid definition.', 500, { projectId });
		return { definition: validation.data, projectAgentClassId: text(entry.projectAgentClassId),
			projectAgentClassSlug: text(entry.projectAgentClassSlug), activities: entry.activities.map(String) } as WorkdayAgentSelectionSnapshot;
	});
	const revision = createHash('sha256').update(stable(agents)).digest('hex');
	if (revision !== snapshot.revision) throw new CapacityGovernanceError('capacity_workday_agent_profile_snapshot_invalid',
		'Workday activity-profile snapshot changed after scheduling.', 500, { projectId });
	return { revision, agents };
}
