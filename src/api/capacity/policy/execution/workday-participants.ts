import { createHash } from 'node:crypto';
import { CapacityGovernanceError } from '../../database.ts';
import { validateAgentDefinitionModel, type AgentDefinition } from '@treeseed/sdk/agent-capacity';

type Row = Record<string, unknown>;
type Activity = keyof AgentDefinition['activityProfiles'];

const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
// Planning node IDs include the workday, round, project and agent. Keep long
// proposal names in the exact source reference, not in the bounded node ID.
const proposalKey = (id: string): string => id.length > 50
	? createHash('sha256').update(id).digest('hex').slice(0, 32) : id;

export interface WorkdayParticipant {
	projectId: string;
	proposalId?: string;
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
export function workdayParticipants(parameters: Row, options: { includeEstimated?: boolean } = {}): WorkdayParticipant[] {
	const snapshots = record(parameters.agentProfilesByProjectId);
	const selectedActivities = array(record(parameters.agentSelection).activityTypes).map(text).filter(Boolean);
	const explicitActivitySelection = selectedActivities.length > 0;
	const groups = array(parameters.groupIds).map(text);
	const proposalsByProject = record(parameters.proposalsByProjectId);
	const participants: WorkdayParticipant[] = [];
	for (const [projectId, snapshotValue] of Object.entries(snapshots)) {
		for (const entryValue of array(record(snapshotValue).agents)) {
			const entry = record(entryValue);
			const validation = validateAgentDefinitionModel(entry.definition);
			if (!validation.ok || !validation.data) continue;
			const frozenActivities = array(entry.activities).map(text).filter(Boolean) as Activity[];
			const activities = (explicitActivitySelection ? frozenActivities : frozenActivities.filter((activity) =>
				activity === 'planning' || activity === 'estimating'))
				.filter((activity): activity is 'planning' | 'estimating' => activity === 'planning' || activity === 'estimating');
			for (const activity of activities) {
				if (!validation.data.activityProfiles[activity]) continue;
				if (activity === 'planning') {
						const proposals = (groups.length ? Object.values(proposalsByProject).flatMap(array)
							: array(proposalsByProject[projectId])).map(record);
						if (groups.length && proposals.length) for (const proposal of proposals) {
							if (!array(proposal.groupIds).some(id => groups.includes(text(id))
								&& validation.data!.groupIds?.includes(text(id)))) continue;
						const proposalId = text(proposal.id);
						if (proposalId) participants.push({ projectId, proposalId, definition: validation.data,
							activity, id: `${projectId}/${validation.data.id}:planning:${proposalKey(proposalId)}` });
					} else participants.push({ projectId, definition: validation.data,
						activity, id: `${projectId}/${validation.data.id}:planning` });
				}
				else for (const proposalValue of array(record(parameters.proposalsByProjectId)[projectId])) {
					const proposal = record(proposalValue);
					const proposalId = text(proposal.id);
					const items = array(record(proposal.executionPlan).workItems).map(record);
					const canEstimate = items.some(item => text(item.agentClass) === validation.data!.agentClass
						&& (options.includeEstimated || Object.keys(record(item.estimate)).length === 0))
						|| (validation.data.agentClass === 'reviewer' && items.some(item => item.review === 'required'
							&& (options.includeEstimated || Object.keys(record(item.reviewEstimate)).length === 0)));
					if (proposalId && canEstimate) participants.push({ projectId, proposalId,
						definition: validation.data, activity, id: `${projectId}/${validation.data.id}:estimating:${proposalKey(proposalId)}` });
				}
			}
		}
	}
	return participants.sort((left, right) => left.id.localeCompare(right.id));
}

/** Resolve one configured closeout profile without changing planning participation. */
export function selectWorkdayReportingAgent(candidates: Array<{projectId: string; definition: AgentDefinition}>, selection?: unknown) {
 const eligible=candidates.filter(candidate=>candidate.definition.activityProfiles.reporting);
 const selected=selection===undefined?eligible:eligible.filter(candidate=>candidate.definition.id===selection);
 if((selection!==undefined && selected.length!==1)||selected.length>1) throw new CapacityGovernanceError(
  'capacity_workday_reporting_selection_invalid','Select exactly one eligible configured reporting agent from the participating projects.',409);
 return selected[0] ?? null;
}
