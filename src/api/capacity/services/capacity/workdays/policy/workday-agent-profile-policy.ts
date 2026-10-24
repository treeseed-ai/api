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

export function compileWorkdayAgentProfileSnapshot(agentClasses: unknown[], selectionValue?: unknown, groupIds?: readonly string[]): WorkdayAgentProfileSnapshot {
	let selection: ReturnType<typeof normalizeWorkdayAgentSelection>;
	try { selection = normalizeWorkdayAgentSelection(selectionValue); }
	catch (error) { throw new CapacityGovernanceError('capacity_workday_agent_selection_invalid',
		'Workday selection accepts activity phases only; groups supply the participants.', 409, { diagnostics: record(error).issues }); }
	const available: WorkdayAgentSelectionSnapshot[] = [];
	for (const value of agentClasses) {
		const row = record(value);
		for (const candidate of array(record(row.handlerRefs ?? row.handler_refs ?? row.handler_refs_json).agents)) {
			const membership = record(candidate).groupIds;
			if (groupIds !== undefined && !(Array.isArray(membership) && membership.some(id => groupIds.includes(String(id))))) continue;
			const validation = validateAgentDefinitionModel(candidate);
			if (!validation.ok || !validation.data) throw new CapacityGovernanceError(
				'capacity_workday_agent_profile_invalid', 'An active project agent class contains an invalid minimal agent definition.', 409,
				{ projectAgentClassId: text(row.id), diagnostics: validation.diagnostics });
			const activities = Object.keys(validation.data.activityProfiles) as WorkdayAgentSelectionSnapshot['activities'];
			available.push({ definition: validation.data, projectAgentClassId: text(row.id),
				projectAgentClassSlug: text(row.slug) || validation.data.agentClass, activities });
		}
	}
	const audience = available;
	const agents = audience
		.map((entry) => ({ ...entry, activities: entry.activities.filter((activity) => !selection.activityTypes.length || selection.activityTypes.includes(activity)) }))
		.filter((entry) => entry.activities.length).sort((left, right) => left.definition.id.localeCompare(right.definition.id));
	const unknown = [
		...selection.activityTypes.filter((id) => !audience.some((entry) => entry.activities.includes(id as never))).map((value) => ({ selector: 'activityTypes', value })),
	];
	if (unknown.length) throw new CapacityGovernanceError('capacity_workday_agent_selection_unknown',
		'Workday selectors must identify eligible activity profiles exactly.', 409, { unknown });
	if (!agents.length) throw new CapacityGovernanceError('capacity_workday_agent_selection_empty',
		'Workday selection resolved no eligible activity profiles.', 409);
	// Cooperative selectors cannot remove the standing closeout activity.
	// Preserve the original empty/unknown selection denials before reserving it.
	for (const entry of audience) if (entry.definition.activityProfiles.reporting) {
		const selected = agents.find(candidate => candidate.definition === entry.definition);
		if (selected) { if (!selected.activities.includes('reporting')) selected.activities.push('reporting'); }
		else agents.push({ ...entry, activities: ['reporting'] });
	}
	agents.sort((left, right) => left.definition.id.localeCompare(right.definition.id));
	const revision = createHash('sha256').update(stable(agents)).digest('hex');
	return { revision, agents };
}

export async function resolveWorkdayAgentProfileSnapshot(store: Store, projectId: string, selection?: unknown, groupIds?: readonly string[]) {
	const page = await store.listProjectAgentClassesPage(projectId, { limit: MAX_CAPACITY_PAGE_LIMIT });
	if (page.page.hasMore) throw new CapacityGovernanceError('capacity_internal_collection_bound_exceeded',
		'Project agent classes exceed the activity-profile snapshot bound.', 409, { projectId });
	return compileWorkdayAgentProfileSnapshot(page.items, selection, groupIds);
}

/** A conversation's audience is the durable addressed invocation, not proposal groups. */
export async function resolveDiscussionAgentProfileSnapshot(store: Store & {
	first(query: string, params?: unknown[]): Promise<Row | null>;
}, run: { id: string; teamId: string; parameters: Row }, projectId: string) {
	const discussion = record(run.parameters.discussion);
	const deny = (): never => { throw new CapacityGovernanceError('capacity_workday_discussion_authority_invalid',
		'Conversation admission requires its exact persisted addressed invocation and current Chat profile.', 409); };
	if (!text(discussion.invocationId) || !text(discussion.discussionId) || !text(discussion.messageId)
		|| !text(discussion.messagePath) || !/^[a-f0-9]{40}$/u.test(text(discussion.commitSha))) return deny();
	const invocation = await store.first(`SELECT * FROM agent_invocation_requests
		WHERE id=? AND team_id=? AND project_id=? AND execution_id=?
		AND execution_kind='conversation' AND status='admitted' LIMIT 1`,
		[discussion.invocationId, run.teamId, projectId, run.id]);
	if (!invocation || invocation.id !== discussion.invocationId || invocation.team_id !== run.teamId
		|| invocation.project_id !== projectId || invocation.execution_id !== run.id
		|| invocation.execution_kind !== 'conversation' || invocation.status !== 'admitted') return deny();
	let metadata: Row;
	try { metadata = record(typeof invocation.metadata_json === 'string' ? JSON.parse(invocation.metadata_json) : invocation.metadata_json); }
	catch { return deny(); }
	if (metadata.discussionId !== discussion.discussionId || metadata.sourceMessageId !== discussion.messageId
		|| metadata.sourceMessagePath !== discussion.messagePath || metadata.sourceCommit !== discussion.commitSha) return deny();
	const selection = normalizeWorkdayAgentSelection(run.parameters.agentSelection);
	if (selection.activityTypes.length !== 1 || selection.activityTypes[0] !== 'chat') return deny();
	const page = await store.listProjectAgentClassesPage(projectId, { limit: MAX_CAPACITY_PAGE_LIMIT });
	if (page.page.hasMore) throw new CapacityGovernanceError('capacity_internal_collection_bound_exceeded',
		'Project agent classes exceed the activity-profile snapshot bound.', 409, { projectId });
	const classes = page.items.map(record).filter(row => row.id === invocation.project_agent_class_id);
	if (classes.length !== 1) return deny();
	const row = classes[0]!, authority = record(row.metadata ?? row.metadata_json);
	if (authority.immutableRef !== invocation.agent_revision || !/^[a-f0-9]{40}$/u.test(text(invocation.agent_revision))) return deny();
	const agents = array(record(row.handlerRefs ?? row.handler_refs ?? row.handler_refs_json).agents).filter(value => {
		const id = text(record(value).id);
		return id === invocation.agent_id || id.endsWith(`/${text(invocation.agent_id)}`);
	});
	if (agents.length !== 1 || !record(record(agents[0]).activityProfiles).chat) return deny();
	return compileWorkdayAgentProfileSnapshot([{ ...row, handlerRefs: { agents } }], selection);
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
