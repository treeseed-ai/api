import { randomUUID } from 'node:crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { compileAgentDefinition, validateAgentSignalContract, validateProposalTypeContract } from '@treeseed/sdk/agent-capacity';
import type { AgentAuthoringIntent } from '@treeseed/sdk/agent-capacity';
import { parseSceneManifest } from '@treeseed/sdk/scenes';
import { validateSeedSource } from '@treeseed/sdk/seeds';
import { parseFrontmatterDocument } from '@treeseed/sdk/frontmatter';
import type { Context, Hono } from 'hono';
import { resolveKnowledgeGatewayConnection } from '../../../../knowledge/gateway-treedx-connection.ts';
import { ProjectAgentClassService } from '../../../services/projects/agents/project-agent-class-service.ts';
import { projectTreeDxCommitSignals } from '../../../services/treedx/repositories/treedx-change-projector.ts';
import { agentLabRepositoryDefinitions, validateAgentDefinitionSource } from '../agent-lab-repository-definitions.ts';
import type { WorkdayRouteDependencies } from '../operator-workdays.ts';
import { readCapacityRequestObject } from '../request-json.ts';
import { applyTextChangeset } from '../../../../knowledge/changesets/apply-text-changeset.ts';

type Row = Record<string, unknown>;
const PATH = /^(?:src\/content\/agents\/[^/]+(?:\/[^/]+)*\.mdx|\.treeseed\/agents\/signals\/[^/]+\.ya?ml|\.treeseed\/governance\/proposal-types\/[^/]+\.ya?ml|seeds\/[^/]+\.ya?ml|scenes\/[^/]+(?:\/[^/]+)*\.ya?ml)$/u;
function object(value: unknown): Row { return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}; }
function text(...values: unknown[]) { return String(values.find((value) => typeof value === 'string' && value) ?? ''); }
function strings(value: unknown) { return Array.isArray(value) ? [...new Set(value.map(text).filter(Boolean))] : []; }

function compileIntentRequest(body: Row) {
	if (!body.intent || typeof body.intent !== 'object' || Array.isArray(body.intent)) return body;
	const currentSource = text(body.source); const parsed = currentSource ? parseFrontmatterDocument(currentSource) : { frontmatter: {}, body: '' };
	const current = object(parsed.frontmatter); const requestedPath = text(body.path);
	const existingSlug = text(current.slug); const existing = existingSlug ? { identity: { id: text(current.id, `agent:${existingSlug}`), slug: existingSlug, path: requestedPath, createdFromTemplate: text(current.template) || undefined }, frontmatter: current } : undefined;
	const compiled = compileAgentDefinition({ intent: body.intent as unknown as AgentAuthoringIntent, projectId: text(body.projectId), existing });
	const source = `---\n${stringifyYaml(compiled.frontmatter, { lineWidth: 0 }).trim()}\n---\n${text(parsed.body, body.contentBody, `\n${text(object(body.intent).name)} participates through declared activity profiles and durable outputs.\n`)}`;
	return { ...body, path: compiled.identity.path, source, generated: compiled.generated };
}

function validateSource(path: string, source: string) {
	if (path.endsWith('.mdx')) return validateAgentDefinitionSource(source);
	let parsed: unknown; try { parsed = parseYaml(source); } catch (error) { return { ok: false, diagnostics: [{ path, message: error instanceof Error ? error.message : 'Invalid YAML.' }] }; }
	if (path.includes('/agents/signals/')) return validateAgentSignalContract(parsed);
	if (path.includes('/governance/proposal-types/')) return validateProposalTypeContract(parsed);
	if (path.startsWith('seeds/')) return validateSeedSource(source);
	if (path.startsWith('scenes/')) { const diagnostics: Array<{ severity: 'error' | 'warning'; code: string; message: string; path?: string }> = []; const scene = parseSceneManifest(parsed, diagnostics); return { ok: Boolean(scene) && !diagnostics.some((item) => item.severity === 'error'), diagnostics }; }
	return { ok: false, diagnostics: [{ path, message: 'Unsupported authoring definition.' }] };
}

function activityCapabilities(activities: Row) {
	const values = ['repo_read', 'agent_mode_run'];
	for (const activity of Object.values(activities).map(object)) values.push(...strings(object(activity.execution).requiredCapabilities));
	return [...new Set(values)];
}

async function reconcileAgents(dependencies: WorkdayRouteDependencies, project: Row, commit: string) {
	const definitions = await agentLabRepositoryDefinitions(dependencies, [project]);
	const agents = definitions.filter((item) => item.kind === 'agent');
	const contracts = Object.fromEntries(definitions.filter((item) => item.kind === 'signal').map((item) => [text(object(item.data).contractId), object(object(item.data).definition)]));
	const proposalTypes = Object.fromEntries(definitions.filter((item) => item.kind === 'proposal-type').map((item) => [text(object(item.data).contractId), object(object(item.data).definition)]));
	const groups = new Map<string, Row[]>();
	for (const agent of agents) { const definition = object(object(agent.data).definition); const classSlug = text(definition.projectAgentClassId, definition.agentClass); if (classSlug) groups.set(classSlug, [...(groups.get(classSlug) ?? []), agent]); }
	const service = new ProjectAgentClassService(dependencies.store as ConstructorParameters<typeof ProjectAgentClassService>[0]);
	const existing = await service.listPage(text(project.id), { limit: 200, cursor: null });
	for (const [classSlug, entries] of groups) {
		const configured = entries.map((entry) => { const data = object(entry.data); const definition = object(data.definition); return { slug: text(definition.slug, definition.id), contentPath: text(data.path), enabled: definition.enabled !== false, activities: object(data.activities) }; });
		const allowedModes = [...new Set(configured.flatMap((agent) => Object.values(agent.activities).map((activity) => text(object(activity).activityType) === 'acting' ? 'acting' : 'planning')))] as Array<'planning' | 'acting'>;
		const current = existing.items.find((item) => item.slug === classSlug || item.id === `${project.id}:${classSlug}`);
		const value = { id: `${project.id}:${classSlug}`, slug: classSlug, name: text(object(object(entries[0].data).definition).agentClassTitle, classSlug), status: configured.some((agent) => agent.enabled) ? 'active' : 'paused', allowedModes, requiredCapabilities: [...new Set(configured.flatMap((agent) => activityCapabilities(agent.activities)))], handlerRefs: { agents: configured, signalContracts: contracts, proposalTypeContracts: proposalTypes }, metadata: { source: 'treedx_agent_lab_authoring', immutableRef: commit } };
		if (current) await service.update(text(project.id), current.id, value, `agent-lab-sync:${commit}:${classSlug}`); else await service.create(text(project.id), value, `agent-lab-sync:${commit}:${classSlug}`);
	}
}

async function verifyReferences(dependencies: WorkdayRouteDependencies, connection: NonNullable<Awaited<ReturnType<typeof resolveKnowledgeGatewayConnection>>>, workspaceBase: string, files: Array<{ path: string; source: string }>) {
	const references = files.flatMap((file) => file.path.endsWith('.mdx') ? validateAgentDefinitionSource(file.source).references : []);
	const included = new Map(files.map((file) => [file.path, file.source])); const paths = [...new Set(references.map((reference) => `.treeseed/agents/signals/${reference.id}.yaml`))];
	const missingPaths = paths.filter((path) => !included.has(path)); const read = missingPaths.length ? await connection.client.readRepositoryFiles({ repoId: connection.repositoryId, ref: workspaceBase, paths: missingPaths, encoding: 'utf8', parseFrontmatter: false, allowProtected: true }).catch(() => ({ files: [] })) : { files: [] };
	const available = new Map([...included, ...(read.files ?? []).map((file: unknown) => [text(object(file).path), text(object(file).content)] as const)]);
	return references.flatMap((reference) => { const path = `.treeseed/agents/signals/${reference.id}.yaml`; const source = available.get(path); if (!source) return [{ path, message: `Missing signal contract ${reference.id}.` }]; try { const result = validateAgentSignalContract(parseYaml(source)); return result.ok ? [] : result.diagnostics; } catch { return [{ path, message: `Signal contract ${reference.id} is invalid YAML.` }]; } });
}

async function commitBundle(c: Context, dependencies: WorkdayRouteDependencies, body: Row) {
	const projectId = text(body.projectId); const project = projectId ? await dependencies.store.first('SELECT id, name, slug FROM projects WHERE id = ? AND team_id = ? LIMIT 1', [projectId, c.req.param('teamId')]) : null;
	if (!project) return c.json({ ok: false, code: 'agent_lab_authoring_project_invalid', error: 'Choose a project in this team.' }, 422);
	const files = (Array.isArray(body.files) ? body.files : [{ path: body.path, source: body.source }]).map(object).map((file) => ({ path: text(file.path).replace(/^\/+|\/+$/gu, ''), source: text(file.source) }));
	if (!files.length || files.some((file) => !PATH.test(file.path) || !file.source.trim()) || new Set(files.map((file) => file.path)).size !== files.length) return c.json({ ok: false, code: 'agent_lab_authoring_bundle_invalid', error: 'Every definition needs a unique allowed repository path and nonempty source.' }, 422);
	const diagnostics = files.flatMap((file) => { const result = validateSource(file.path, file.source); return result.ok ? [] : result.diagnostics; });
	if (diagnostics.length) return c.json({ ok: false, code: 'agent_lab_authoring_validation_failed', error: 'Correct the definition diagnostics before committing.', diagnostics }, 422);
	const connection = await resolveKnowledgeGatewayConnection(dependencies.store, { projectId, write: true, authoringPaths: true });
	if (!connection) return c.json({ ok: false, code: 'agent_lab_treedx_unavailable', error: 'The project TreeDX repository is unavailable.' }, 503);
	const branchName = `refs/heads/${connection.authoringBranch.replace(/^refs\/heads\//u, '')}`; const workspace = await connection.client.createWorkspace({ repoId: connection.repositoryId, baseRef: branchName, branchName, mode: 'writable', allowedPaths: connection.allowedPaths, ttlSeconds: 900 });
	if (text(body.expectedBase) && text(body.expectedBase) !== workspace.baseCommitSha) { await connection.client.closeWorkspace(workspace.workspaceId).catch(() => {}); return c.json({ ok: false, code: 'agent_lab_authoring_conflict', error: 'The authoring branch changed. Compare and rebase before saving.', currentBase: workspace.baseCommitSha }, 409); }
	const referenceDiagnostics = await verifyReferences(dependencies, connection, workspace.baseCommitSha, files); if (referenceDiagnostics.length) { await connection.client.closeWorkspace(workspace.workspaceId).catch(() => {}); return c.json({ ok: false, code: 'agent_contract_reference_invalid', error: 'The bundle references missing or invalid signal contracts.', diagnostics: referenceDiagnostics }, 422); }
	try {
		const existing = await connection.client.readRepositoryFiles({ repoId: connection.repositoryId, ref: workspace.baseCommitSha, paths: files.map((file) => file.path), encoding: 'utf8', parseFrontmatter: false, allowProtected: true }).catch(() => ({ files: [] }));
		const beforeByPath = new Map((existing.files ?? []).map((file: unknown) => [text(object(file).path), text(object(file).content)]));
		const changeset = await applyTextChangeset({ client: connection.client, workspace, changes: files.map((file) => ({ path: file.path, before: beforeByPath.get(file.path) ?? null, after: file.source })) });
		const access = await dependencies.manage(c); const commit = await connection.client.commit({ workspaceId: workspace.workspaceId, message: text(body.changeSummary, `agent-lab: update ${files.length} definition${files.length === 1 ? '' : 's'}`), author: { name: access.principal?.name ?? access.principal?.id ?? 'Agent Lab operator', email: access.principal?.email ?? 'agent-lab@users.treeseed.local' } });
		await projectTreeDxCommitSignals(dependencies.store, { projectId, commitSha: commit.commitSha, immutableRef: commit.branchName, changedPaths: commit.changedPaths, changeSummary: text(body.changeSummary, 'Agent Lab definition update'), actorType: 'user', actorId: access.principal?.id });
		if (files.some((file) => file.path.startsWith('src/content/agents/') || file.path.includes('/agents/signals/') || file.path.includes('/proposal-types/'))) await reconcileAgents(dependencies, project, commit.commitSha);
		await dependencies.store.run("INSERT INTO audit_events (id, actor_type, actor_id, event_type, target_type, target_id, data_json, created_at) VALUES (?, 'user', ?, 'agent_lab.authoring.committed', 'project', ?, ?, ?)", [randomUUID(), access.principal?.id ?? null, projectId, JSON.stringify({ changedPaths: commit.changedPaths, commitSha: commit.commitSha }), new Date().toISOString()]);
		return c.json({ ok: true, payload: { commit: commit.commitSha, branch: commit.branchName, changedPaths: commit.changedPaths, changeset: { ...changeset, resultCommitSha: commit.commitSha } } });
	} catch (error) { await connection.client.closeWorkspace(workspace.workspaceId).catch(() => {}); return c.json({ ok: false, code: 'agent_lab_authoring_failed', error: error instanceof Error ? error.message : 'TreeDX could not commit the definitions.' }, 409); }
}

async function draft(dependencies: WorkdayRouteDependencies, teamId: string, selectedProjectId?: string) {
	const team = await dependencies.store.first('SELECT id, slug, name FROM teams WHERE id = ? LIMIT 1', [teamId]); const projects = await dependencies.store.all('SELECT id, slug, name, description, metadata_json FROM projects WHERE team_id = ? ORDER BY slug', [teamId]);
	const members = await dependencies.store.all("SELECT users.email, roles.key AS role FROM team_memberships JOIN users ON users.id = team_memberships.user_id JOIN team_role_bindings ON team_role_bindings.team_membership_id = team_memberships.id JOIN roles ON roles.id = team_role_bindings.role_id WHERE team_memberships.team_id = ? AND team_memberships.status = 'active' AND users.email IS NOT NULL ORDER BY users.email", [teamId]);
	const rolesByEmail = new Map<string, string[]>();
	for (const member of members) {
		const email = text(member.email).trim().toLowerCase();
		if (email) rolesByEmail.set(email, [...new Set([...(rolesByEmail.get(email) ?? []), text(member.role)].filter(Boolean))]);
	}
	const teamKey = `team:${text(team?.slug, 'team')}`; const projectKeys = new Map(projects.map((project) => [text(project.id), `project:${text(team?.slug, 'team')}/${text(project.slug)}`]));
	const resources = { teams: [{ key: teamKey, slug: text(team?.slug), name: text(team?.name) }], teamMemberships: [...rolesByEmail].map(([email, roles]) => ({ key: `membership:${text(team?.slug)}/${email.replace(/[^a-z0-9]+/gu, '-')}`, team: teamKey, email, roles, missingUser: 'defer' })), projects: await Promise.all(projects.map(async (project) => { const library = await dependencies.store.first('SELECT content_path, content_repository_url, content_repository_default_branch, content_repository_ref FROM treedx_project_libraries WHERE project_id = ? LIMIT 1', [project.id]); return { key: projectKeys.get(text(project.id)), team: teamKey, slug: text(project.slug), name: text(project.name), description: text(project.description), repository: { role: 'primary', provider: 'github', gitUrl: text(library?.content_repository_url), defaultBranch: text(library?.content_repository_default_branch, 'main') }, metadata: { immutableRef: text(library?.content_repository_ref), contentPath: text(library?.content_path) } }; })) };
	const provider = await dependencies.store.first("SELECT provider.id, provider.display_name FROM capacity_providers provider JOIN capacity_provider_team_memberships membership ON membership.capacity_provider_id = provider.id WHERE membership.team_id = ? AND membership.status = 'approved' AND provider.status = 'active' ORDER BY membership.updated_at DESC LIMIT 1", [teamId]);
	const seed = { name: `agent-lab-${text(team?.slug, 'team')}`, version: 1, description: `Portable Agent Lab profile for ${text(team?.name, 'team')}.`, defaultEnvironments: ['local'], environments: ['local'], resources, runtime: { agentLabServicePrincipals: [{ key: `service-principal:${text(team?.slug)}/agent-lab`, environments: ['local'], team: teamKey, name: 'Agent Lab Operations Runner', roles: ['team_owner'] }], capacityProviders: provider ? [{ key: `capacity-provider:${text(team?.slug)}/local`, environments: ['local'], team: teamKey, manifest: 'treeseed.capacity-provider.yaml', connectionId: 'primary-team', approval: 'trusted-local-owner', projects: [...projectKeys.values()], allowedModes: ['planning', 'acting'], executionProviderIds: ['codex'] }] : [] } };
	const chosen = projects.find((project) => text(project.id) === selectedProjectId) ?? projects[0]; const seedPath = `seeds/${seed.name}.yaml`; const scenePath = `scenes/agent-lab/${text(team?.slug, 'team')}-browser-demo.yaml`;
	const scene = { schemaVersion: 'treeseed.scene/v1', id: `${text(team?.slug, 'team')}-browser-demo`, title: `${text(team?.name, 'Team')} Agent Lab Demo`, description: 'Team-scoped retained cooperative planning simulation.', audience: ['operator'], journey: { kind: 'agent-lab', proves: [] }, mode: { test: false, demo: true, training: false }, runtime: { mode: 'demo' }, target: { app: 'market', environment: 'local', baseUrl: 'auto', browser: 'chromium', viewport: { width: 1440, height: 900 } }, setup: { dev: { required: false, reuseExisting: true }, seeds: [{ name: seed.name, environments: ['local'], apply: true }] }, artifacts: { trace: false, video: false, screenshots: false, console: true, network: true, timeline: true, appLogs: true }, workflow: [], agentLab: { scope: { kind: 'team', team: teamKey, capacityProvider: `capacity-provider:${text(team?.slug)}/local` }, provider: 'local', executionProvider: 'codex', presentation: 'race-control', repositories: chosen ? [text(chosen.slug)] : [], workdays: [{ id: 'cooperative-planning-demo', title: 'Cooperative Planning Demo', durationSeconds: 900, timePolicy: { cooperativePlanningPercent: 90, governedExecutionPercent: 0, reservePercent: 10 }, planningSession: { rounds: 3, assignmentTimeboxSeconds: 120, tokenWarning: 12000 }, maxActiveAssignments: 4, planningOnly: true }] }, training: { enabled: false } };
	return { projectId: text(chosen?.id), projectName: text(chosen?.name), seedPath, scenePath, seedYaml: stringifyYaml(seed, { lineWidth: 0 }), sceneYaml: stringifyYaml(scene, { lineWidth: 0 }), expectedBase: text((await dependencies.store.first('SELECT content_repository_ref FROM treedx_project_libraries WHERE project_id = ? LIMIT 1', [chosen?.id]))?.content_repository_ref), diagnostics: provider ? [] : [{ severity: 'error', message: 'No approved active capacity provider is connected to this team.' }] };
}

export function installOperatorAgentLabAuthoringRoutes(app: Hono, dependencies: WorkdayRouteDependencies) {
	app.get('/v1/teams/:teamId/agent-lab/surfaces/build/draft', async (c) => { const access = await dependencies.manage(c); if (access.response) return access.response; return c.json({ ok: true, payload: await draft(dependencies, c.req.param('teamId'), c.req.query('project')) }); });
	app.post('/v1/teams/:teamId/agent-lab/surfaces/build/authoring', async (c) => { const access = await dependencies.manage(c); if (access.response) return access.response; return commitBundle(c, dependencies, compileIntentRequest(await readCapacityRequestObject(c))); });
	app.post('/v1/teams/:teamId/agent-lab/surfaces/build/authoring-bundle', async (c) => { const access = await dependencies.manage(c); if (access.response) return access.response; return commitBundle(c, dependencies, await readCapacityRequestObject(c)); });
	app.post('/v1/teams/:teamId/agent-lab/questions/answer', async (c) => {
		const access = await dependencies.manage(c); if (access.response) return access.response; const body = await readCapacityRequestObject(c); const projectId = text(body.projectId); const path = text(body.path).replace(/^\/+|\/+$/gu,''); const answer = text(body.answer).trim();
		const project = await dependencies.store.first('SELECT id FROM projects WHERE id = ? AND team_id = ? LIMIT 1',[projectId,c.req.param('teamId')]); if(!project || !answer) return c.json({ok:false,code:'agent_lab_question_answer_invalid',error:'Choose a team question and provide an answer.'},422);
		const connection = await resolveKnowledgeGatewayConnection(dependencies.store,{projectId,write:true,relationPaths:true}); if(!connection || !path.startsWith(`${connection.contentPath}/questions/`)) return c.json({ok:false,code:'agent_lab_question_path_invalid',error:'The question is outside this project’s canonical question collection.'},422);
		const branchName=`refs/heads/${connection.authoringBranch.replace(/^refs\/heads\//u,'')}`; const workspace=await connection.client.createWorkspace({repoId:connection.repositoryId,baseRef:branchName,branchName,mode:'writable',allowedPaths:connection.allowedPaths,ttlSeconds:600}); if(text(body.expectedBase)&&text(body.expectedBase)!==workspace.baseCommitSha){await connection.client.closeWorkspace(workspace.workspaceId).catch(()=>{});return c.json({ok:false,code:'agent_lab_question_conflict',error:'The question changed before this answer was submitted.',currentBase:workspace.baseCommitSha},409);}
		try { const read=await connection.client.readRepositoryFile({repoId:connection.repositoryId,ref:workspace.baseCommitSha,path,encoding:'utf8',maxBytes:196_608}); const before=text(object(read.file).content); const parsed=parseFrontmatterDocument(before); const now=new Date().toISOString(); const source=`---\n${stringifyYaml({...object(parsed.frontmatter),status:'answered',answer,answeredAt:now,answeredBy:access.principal?.id ?? 'team-owner'},{lineWidth:0}).trim()}\n---\n${parsed.body}`; const changeset=await applyTextChangeset({client:connection.client,workspace,changes:[{path,before,after:source}]}); const commit=await connection.client.commit({workspaceId:workspace.workspaceId,message:`agent-lab: answer ${path}`,author:{name:access.principal?.name ?? 'Agent Lab operator',email:access.principal?.email ?? 'agent-lab@users.treeseed.local'}}); await projectTreeDxCommitSignals(dependencies.store,{projectId,commitSha:commit.commitSha,immutableRef:commit.branchName,changedPaths:commit.changedPaths,changeSummary:'Answer team question',actorType:'user',actorId:access.principal?.id}); return c.json({ok:true,payload:{commit:commit.commitSha,status:'answered',changeset:{...changeset,resultCommitSha:commit.commitSha}}}); } catch(error){await connection.client.closeWorkspace(workspace.workspaceId).catch(()=>{});return c.json({ok:false,code:'agent_lab_question_answer_failed',error:error instanceof Error?error.message:'The answer could not be committed.'},409);}
	});
}
