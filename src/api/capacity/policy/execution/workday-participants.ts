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

function frozenCooperativeAgents(parameters: Row) {
 return Object.entries(record(parameters.agentProfilesByProjectId)).flatMap(([projectId, snapshot]) =>
  array(record(snapshot).agents).flatMap(value => {
   const entry = record(value), checked = validateAgentDefinitionModel(entry.definition);
   if (!checked.ok || !checked.data) return [];
   const activities = array(entry.activities).map(text).filter((activity): activity is WorkdayParticipant['activity'] =>
    activity === 'planning' || activity === 'estimating');
   return [{ projectId, definition: checked.data, activities }];
  }));
}

/** New cooperative work comes only from the governed group audience. */
export function workdayParticipants(parameters: Row): WorkdayParticipant[] {
 const groups = array(parameters.groupIds).map(text).filter(Boolean);
 if (!groups.length) return [];
 const proposals = Object.values(record(parameters.proposalsByProjectId)).flatMap(array).map(record);
 const selected = array(record(parameters.agentSelection).activityTypes).map(text);
 const participants: WorkdayParticipant[] = [];
 for (const agent of frozenCooperativeAgents(parameters)) {
  if (!agent.definition.groupIds?.some(id => groups.includes(id))) continue;
  for (const activity of agent.activities) {
   if (!agent.definition.activityProfiles[activity] || selected.length && !selected.includes(activity)) continue;
   const base = `${agent.projectId}/${agent.definition.id}:${activity}`;
   if (activity === 'planning' && !proposals.length) participants.push({ projectId: agent.projectId, definition: agent.definition, activity, id: base });
   else for (const proposal of proposals) {
    if (proposal.schemaVersion !== 'treeseed.proposal/v2' || !text(proposal.id)
     || !array(proposal.groupIds).some(id => groups.includes(text(id)) && agent.definition.groupIds?.includes(text(id)))) continue;
    participants.push({ projectId: agent.projectId, definition: agent.definition, proposalId: text(proposal.id), activity, id: `${base}:${proposalKey(text(proposal.id))}` });
   }
  }
 }
 return participants.sort((left, right) => left.id.localeCompare(right.id));
}

/** Decode only identities already declared in the immutable planning rounds.
 * This is custody/cancellation history, never a source of new admission. */
export function declaredWorkdayParticipants(parameters: Row, declaredIds: ReadonlySet<string>): WorkdayParticipant[] {
 const proposals = new Set([...Object.keys(record(parameters.planningSourceByProposalId)),
  ...Object.values(record(parameters.proposalsByProjectId)).flatMap(array).map(value => text(record(value).id))].filter(Boolean));
 const found = new Map<string, WorkdayParticipant>();
 for (const agent of frozenCooperativeAgents(parameters)) for (const activity of agent.activities) {
  if (!agent.definition.activityProfiles[activity]) continue;
  const base = `${agent.projectId}/${agent.definition.id}:${activity}`;
  const identity = { projectId: agent.projectId, definition: agent.definition, activity };
  const candidates = [...(activity === 'planning' ? [{ ...identity, id: base }] : []),
   ...[...proposals].map(proposalId => ({ ...identity, proposalId, id: `${base}:${proposalKey(proposalId)}` }))];
  for (const candidate of candidates) if (declaredIds.has(candidate.id)) found.set(candidate.id, candidate);
 }
 return [...found.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/** Current closeout includes every subscribed reporting profile. A selector is retained issued-plan authority only. */
export function selectWorkdayReportingAgents(candidates: Array<{projectId: string; definition: AgentDefinition}>, selection?: unknown) {
 const eligible=candidates.filter(candidate=>candidate.definition.activityProfiles.reporting);
 const selected=selection===undefined?eligible:eligible.filter(candidate=>candidate.definition.id===selection);
 if(selection!==undefined && selected.length!==1) throw new CapacityGovernanceError(
  'capacity_workday_reporting_selection_invalid','The retained reporting agent must resolve exactly once in its frozen participants.',409);
 return selected.sort((left,right)=>(left.projectId+':'+left.definition.id).localeCompare(right.projectId+':'+right.definition.id));
}
