import { parse } from 'yaml';
import { compileWorkday, validateAgentDefinitionModel, type AgentDefinition } from '@treeseed/sdk/agent-capacity';
import { projectActiveWorkdays } from '../../../../../../../src/api/capacity/policy/execution/workday-execution-projector.ts';
import { applyOperationalState, type TeamGraph } from '../../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-state.ts';

export function profile(agentClass: string, options: { reporting?: boolean; closing?: boolean; planningClosing?: boolean } = {}): AgentDefinition {
	const input: unknown = parse(`
schemaVersion: treeseed.agent/v1
id: project/${agentClass}
name: Configured ${agentClass}
agentClass: ${agentClass}
purpose: Produce the assigned governed contribution.
responsibilities: [Complete only the assigned work.]
capabilities: [treeseed.coordination.reporting]
context: { include: [assignment-subject] }
activityProfiles:
  planning:
    handler: writer
    permissions: { content: { read: [note], write: [note] }, tools: [] }
    prompt: { system: Plan the assigned contribution. }
    ${options.planningClosing ? 'dependsOn: { events: [workday-closing] }' : ''}
  ${options.reporting === false ? '' : `reporting:
    handler: reporter
    permissions: { content: { read: [note], write: [note] }, tools: [] }
    prompt: { system: Commit the assigned exact report note. }
    ${options.closing === false ? '' : 'dependsOn: { events: [workday-closing] }'}`}
`);
	const validation = validateAgentDefinitionModel(input);
	if (!validation.ok || !validation.data) throw new Error(JSON.stringify(validation));
	return validation.data;
}

export function project(profiles: AgentDefinition[], state: 'active' | 'closing' = 'active') {
	const participants = profiles.map(definition => ({ definition, activities: ['planning'] }));
	const plan = compileWorkday({ id: 'architecture-workday', teamId: 'team', policyId: 'default', policyRevision: 1,
		executionMode: 'simulation', startsAt: '2026-09-16T12:00:00Z',
		agentIds: profiles.map(definition => `project/${definition.id}:planning`),
		policy: { durationSeconds: 1800, maximumConcurrency: 2, communicationConcurrency: 1 } });
	return projectActiveWorkdays({ teamId: 'team', revision: 1,
		profiles: Object.fromEntries(profiles.map(definition => [`project:${definition.agentClass}`, definition])),
		sources: [{ id: plan.id, teamId: 'team', parameters: { appliedPlan: { ...plan, state },
			scheduledProjectIds: ['project'], agentProfilesByProjectId: { project: { agents: participants } } } }] });
}

export const emptyGraph = (): TeamGraph => ({ teamId: 'team', revision: 0, digest: '', nodes: [], edges: [] });

export function reconcile(projection: ReturnType<typeof project>, current = emptyGraph(), revision = 1): TeamGraph {
	return applyOperationalState(current, { teamId: 'team', revision, digest: '',
		nodes: projection.nodes, edges: projection.edges }, revision);
}
