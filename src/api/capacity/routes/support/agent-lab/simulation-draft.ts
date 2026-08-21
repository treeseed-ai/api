import { stringify as stringifyYaml } from 'yaml';
import { resolveKnowledgeGatewayConnection } from '../../../../knowledge/gateway-treedx-connection.ts';
import { agentLabRepositoryDefinitions } from './repository-definitions.ts';
import { parseAgentLabSimulationDraftOptions, validateAgentLabSimulationSelection, type AgentLabSimulationDraftOptions } from './simulation-draft-options.ts';

type Dependencies = { store: { first: (query: string, values: unknown[]) => Promise<Record<string, unknown> | null>; all: (query: string, values: unknown[]) => Promise<Array<Record<string, unknown>>> } };

function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function jsonObject(value: unknown) { if (typeof value === 'string') try { return object(JSON.parse(value)); } catch { return {}; } return object(value); }
function text(...values: unknown[]) { return String(values.find((value) => typeof value === 'string' && value) ?? ''); }

export async function agentLabSimulationDraft(dependencies: Dependencies, teamId: string, selectedProjectId?: string, simulationOptions: AgentLabSimulationDraftOptions = parseAgentLabSimulationDraftOptions(() => undefined)) {
  const team = await dependencies.store.first('SELECT id, slug, name FROM teams WHERE id = ? LIMIT 1', [teamId]);
  const projects = await dependencies.store.all('SELECT id, slug, name, description, metadata_json FROM projects WHERE team_id = ? ORDER BY slug', [teamId]);
  const chosen = projects.find((project) => text(project.id) === selectedProjectId) ?? (!selectedProjectId ? projects[0] : undefined);
  const selectedProjects = chosen ? [chosen] : [];
  const teamKey = `team:${text(team?.slug, 'team')}`;
  const projectKeys = new Map(selectedProjects.map((project) => [text(project.id), `project:${text(team?.slug, 'team')}/${text(project.slug)}`]));
  const resources = { teams: [{ key: teamKey, slug: text(team?.slug), name: text(team?.name) }], projects: selectedProjects.map((project) => {
    const configuration = jsonObject(project.metadata_json);
    return { key: projectKeys.get(text(project.id)), team: teamKey, slug: text(project.slug), name: text(project.name), description: text(project.description), kind: text(configuration.kind), repository: object(configuration.repository), architecture: object(configuration.architecture) };
  }) };
  const provider = chosen ? await dependencies.store.first(`SELECT provider.id, provider.display_name,
		capacity_grant.metadata_json AS grant_metadata_json,
		capacity_grant.execution_provider_ids_json
		FROM capacity_grants capacity_grant
		JOIN capacity_providers provider ON provider.id = capacity_grant.capacity_provider_id
		JOIN capacity_provider_team_memberships membership ON membership.id = capacity_grant.membership_id
		WHERE capacity_grant.team_id = ? AND capacity_grant.project_id = ? AND capacity_grant.status = 'active'
			AND membership.team_id = ? AND membership.status = 'approved' AND provider.status = 'active'
		ORDER BY capacity_grant.updated_at DESC LIMIT 1`, [teamId, chosen.id, teamId]) : null;
  const providerResourceKey = text(jsonObject(provider?.grant_metadata_json).seedResourceKey);
  const executionProviderIds = Array.isArray(provider?.execution_provider_ids_json) ? provider.execution_provider_ids_json.map(text).filter(Boolean) : (() => {
    try { const parsed = JSON.parse(text(provider?.execution_provider_ids_json, '[]')); return Array.isArray(parsed) ? parsed.map(text).filter(Boolean) : []; } catch { return []; }
  })();
  const executionProviderId = executionProviderIds[0] ?? '';
  const seed = { name: `agent-lab-${text(team?.slug, 'team')}`, version: 1, description: `Portable Agent Lab profile for ${text(chosen?.name, team?.name, 'team')}.`, defaultEnvironments: ['local'], environments: ['local'], references: providerResourceKey ? [providerResourceKey] : [], resources, runtime: { agentLabServicePrincipals: [{ key: `service-principal:${text(team?.slug)}/agent-lab`, environments: ['local'], team: teamKey, name: 'Agent Lab Service Principal', roles: ['team_owner'] }] } };
  const connection = chosen ? await resolveKnowledgeGatewayConnection(dependencies.store as never, { projectId: text(chosen.id), write: false, authoringPaths: true }) : null;
  const authoringRef = connection ? `refs/heads/${connection.authoringBranch.replace(/^refs\/heads\//u, '')}` : '';
  const refs = connection ? await connection.client.listRepositoryRefs(connection.repositoryId).catch(() => []) : [];
  const observed = refs.find((entry) => entry.name === authoringRef || entry.name === connection?.authoringBranch);
  const definitions = chosen && observed ? await agentLabRepositoryDefinitions(dependencies as never, [chosen] as never, text(observed.target, observed.sha)) : [];
  const configuredAgents = [...new Set(definitions.filter((entry) => entry.kind === 'agent' && object(entry.data).valid === true).map((entry) => object(object(entry.data).definition)).filter((definition) => definition.enabled !== false).map((definition) => text(definition.slug, definition.id)).filter(Boolean))];
  const selectedAgents = simulationOptions.agentSlugs.length ? configuredAgents.filter((slug) => simulationOptions.agentSlugs.includes(slug)) : configuredAgents;
  const missingAgents = simulationOptions.agentSlugs.filter((slug) => !configuredAgents.includes(slug));
  const generatedTestId = 'agent-lab-project-inventory';
  const selectedTest = selectedAgents.length && !missingAgents.length ? generatedTestId : '';
  const testPath = connection ? `${connection.contentPath}/agent-tests/${generatedTestId}.mdx` : '';
  const testMdx = selectedTest ? `---\n${stringifyYaml({ id: `agent-test:${generatedTestId}`, agent: selectedAgents[0], kind: 'workday', trigger: { planningOnly: true, agents: selectedAgents }, expect: { productionPath: true, everySelectedAgent: true, durableModeRuns: true, treeDxOnlyContentAccess: true, usageAndSettlement: true }, groupIds: [] }, { lineWidth: 0 }).trim()}\n---\n\nRun the enabled agents for this project through a real planning-only workday using the normal provider, AgentKernel, TreeDX, usage, and settlement paths.\n` : '';
  const seedPath = `seeds/${seed.name}.yaml`;
  const scenePath = `scenes/agent-lab/${text(team?.slug, 'team')}-browser-demo.yaml`;
  const graphDiagnostics = chosen && selectedTest ? await validateAgentLabSimulationSelection(dependencies.store as never, text(chosen.id), { ...simulationOptions, agentSlugs: selectedAgents }) : [];
  const scene = { schemaVersion: 'treeseed.scene/v1', id: `${text(team?.slug, 'team')}-browser-demo`, title: `${text(team?.name, 'Team')} Agent Lab Demo`, description: 'Team-scoped retained cooperative planning simulation.', audience: ['operator'], journey: { kind: 'agent-lab', proves: [] }, mode: { test: false, demo: true, training: false }, runtime: { mode: 'demo' }, target: { app: 'api', environment: 'local', baseUrl: 'auto', browser: 'chromium', viewport: { width: 1440, height: 900 } }, setup: { dev: { required: false, reuseExisting: true }, seeds: [{ name: seed.name, environments: ['local'], apply: false }] }, artifacts: { trace: false, video: false, screenshots: false, console: true, network: true, timeline: true, appLogs: true }, workflow: [], agentLab: { scope: { kind: 'team', team: teamKey, capacityProvider: providerResourceKey }, provider: 'local', executionProvider: executionProviderId, presentation: 'race-control', repositories: chosen ? [text(chosen.slug)] : [], workdays: [{ id: 'cooperative-planning-demo', title: 'Cooperative Planning Demo', agentTests: selectedTest ? [selectedTest] : [], durationSeconds: simulationOptions.durationSeconds, timePolicy: { cooperativePlanningPercent: 90, governedExecutionPercent: 0, reservePercent: 10 }, planningSession: { rounds: simulationOptions.planningRounds, assignmentTimeboxSeconds: simulationOptions.assignmentTimeboxSeconds, tokenWarning: 12e3 }, maxActiveAssignments: simulationOptions.maxActiveAssignments, planningOnly: true, activityTypes: simulationOptions.activityTypes }] }, training: { enabled: false } };
  return { projectId: text(chosen?.id), projectName: text(chosen?.name), seedPath, scenePath, testPath: selectedTest ? testPath : '', seedYaml: stringifyYaml(seed, { lineWidth: 0 }), sceneYaml: stringifyYaml(scene, { lineWidth: 0 }), testMdx: selectedTest ? testMdx : '', expectedBase: text(observed?.target, observed?.sha), diagnostics: [...chosen ? [] : [{ severity: 'error', message: 'Choose a project from this team before generating a simulation.' }], ...providerResourceKey && executionProviderId ? [] : [{ severity: 'error', message: 'No reconciled seed-backed capacity provider has an active grant for this project.' }], ...missingAgents.length ? [{ severity: 'error', message: `Requested agents are not enabled in this project: ${missingAgents.join(', ')}.`, path: 'agents' }] : [], ...selectedTest ? [] : [{ severity: 'error', message: 'The selected project has no enabled repository-backed agents for a workday test.' }], ...graphDiagnostics, ...!observed ? [{ severity: 'error', message: 'The TreeDX authoring branch could not be resolved to an exact commit.' }] : []] };
}
