import { validateAgentDefinitionModel, type AgentDefinition } from '@treeseed/sdk/agent-capacity';

type Row = Record<string, unknown>;
type Activity = keyof AgentDefinition['activityProfiles'];

const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

export interface WorkdayParticipant {
	projectId: string;
	definition: AgentDefinition;
	activity: Extract<Activity, 'planning' | 'estimating'>;
	id: string;
}

/** Resolve only cooperative planning profiles frozen into one workday.
 *
 * Reviewing, reporting, and chat already have concrete living-graph sources:
 * proposal/candidate authority, workday closing, and discussion messages.
 * Selecting them filters admission; it must not manufacture subjectless
 * work. Default planning includes estimating only where an exact selected
 * proposal supplies work for that agent; autonomous planning needs no proposal.
 */
export function workdayParticipants(parameters: Row): WorkdayParticipant[] {
	const snapshots = record(parameters.agentProfilesByProjectId);
	const selectedActivities = array(record(parameters.agentSelection).activityTypes).map(text).filter(Boolean);
	const explicitActivitySelection = selectedActivities.length > 0;
	const participants: WorkdayParticipant[] = [];
	for (const [projectId, snapshotValue] of Object.entries(snapshots)) {
		for (const entryValue of array(record(snapshotValue).agents)) {
			const entry = record(entryValue);
			const validation = validateAgentDefinitionModel(entry.definition);
			if (!validation.ok || !validation.data) continue;
			const frozenActivities = array(entry.activities).map(text).filter(Boolean) as Activity[];
			const workItems = array(record(record(record(parameters.proposalsByProjectId)[projectId]).executionPlan).workItems).map(record);
			const canEstimate = workItems.some(item => text(item.agentClass) === validation.data!.agentClass)
				|| (validation.data.agentClass === 'reviewer' && workItems.some(item => item.review === 'required'));
			const activities = (explicitActivitySelection ? frozenActivities : frozenActivities.filter((activity) =>
				activity === 'planning' || activity === 'estimating'))
				.filter((activity) => activity !== 'estimating' || canEstimate)
				.filter((activity): activity is 'planning' | 'estimating' => activity === 'planning' || activity === 'estimating');
			for (const activity of activities) {
				if (!validation.data.activityProfiles[activity]) continue;
				participants.push({
					projectId,
					definition: validation.data,
					activity,
					id: `${projectId}/${validation.data.id}:${activity}`,
				});
			}
		}
	}
	return participants.sort((left, right) => left.id.localeCompare(right.id));
}
