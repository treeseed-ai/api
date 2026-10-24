import { randomUUID } from 'node:crypto';
import { stringify } from 'yaml';
import { expect } from 'vitest';
import { compileWorkday, DEFAULT_WORKDAY_POLICY, validateAgentDefinitionModel, exactEntityReferenceSchema, type ExactEntityReference } from '@treeseed/sdk/agent-capacity';
import { workdayParticipants } from '../../../../../src/api/capacity/policy/execution/workday-participants.ts';
import { createExecutionGraphService } from '../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-service.ts';
import { ProjectAgentClassRepository } from '../../../../../src/api/capacity/repositories/projects/agents/project-agent-class.ts';
import { resolveWorkdayAgentProfileSnapshot } from '../../../../../src/api/capacity/services/capacity/workdays/policy/workday-agent-profile-policy.ts';
import type { relationAuthoringDatabase } from '../../knowledge/workspaces/architecture/relation-authoring-fixture.ts';
import { object } from '../../knowledge/workspaces/architecture/relation-authoring-fixture.ts';
type Row = Record<string, unknown>;

export function automaticEstimatingProfiles(groupIds: string[]) {
 return ['engineer', 'reviewer', 'reporter', 'outsider'].map(name => {
  const permissions = { content: { read: ['proposal'], write: ['proposal'] }, tools: [] };
  const checked = validateAgentDefinitionModel({ schemaVersion: 'treeseed.agent/v1', id: 'native-renamed/' + name,
   name: 'Configured ' + name, agentClass: 'maintenance', groupIds: name === 'outsider' ? ['another-workstream'] : groupIds,
   purpose: 'Contribute only to exact governed work.', responsibilities: ['Preserve source and predecessor authority.'],
   capabilities: ['planning'], context: { include: ['assignment-subject'] }, activityProfiles: {
    planning: { handler: 'writer', permissions, prompt: { system: 'Publish the original planning contribution.' } },
    estimating: { handler: 'writer', permissions, prompt: { system: 'Estimate and own a useful proposal contribution.' } },
   } });
  if (!checked.ok || !checked.data) throw new Error(JSON.stringify(checked.diagnostics)); return checked.data;
 });
}

/** Controlled run/profile inputs; actual PostgreSQL, native TreeDX publication,
 * group selection, graph persistence and independent-connection replay. No
 * authenticated Workday admission, live model execution or usage is claimed. */
export async function verifyAutomaticEstimatingGraph(f: Awaited<ReturnType<typeof relationAuthoringDatabase>>, definition: Row, reference: ExactEntityReference) {
 expect(definition.schemaVersion).toBe('treeseed.proposal/v2');
 if (!Array.isArray(definition.groupIds) || !definition.groupIds.every(value => typeof value === 'string')) throw new Error('Current proposal groups required');
 if (!reference.repository || !reference.commit || !reference.path) throw new Error('Exact native proposal provenance required');
 const groupIds = definition.groupIds as string[], projectId = String(definition.projectId), now = new Date().toISOString();
 const profiles = automaticEstimatingProfiles(groupIds), repository = String(reference.repository);
 const profileInputs = profiles.map(profile => ({ definition: profile, path: `agents/${profile.id.split('/').at(-1)}.mdx`, raw: `---\n${stringify(profile)}---\n` }));
 const created = object(await f.client.workspaces.create(repository, { baseRef: String(reference.commit),
  branchName: 'refs/heads/automatic-profiles-' + randomUUID(), mode: 'writable', allowedPaths: ['agents/**'] }));
 const workspaceId = String(created.workspaceId ?? ''); expect(workspaceId).not.toBe('');
 let profileCommit: string;
 try {
  for (const profile of profileInputs) await f.client.files.write(workspaceId, { path: profile.path, content: profile.raw });
  const committed = object(await f.client.files.commit(workspaceId, { message: 'Controlled group subscriber YAML inputs',
   author: { name: 'Native estimator fixture', email: 'estimate-fixture@example.invalid' } }));
  profileCommit = String(committed.commitSha ?? ''); expect(profileCommit).toMatch(/^[a-f0-9]{40}$/u);
 } finally { await f.client.workspaces.close(workspaceId); expect(object(await f.client.workspaces.get(workspaceId)).status).toBe('closed'); }
 for (const profile of profileInputs) {
  const read = object(await f.client.query.readFile(repository, { ref: profileCommit, path: profile.path, encoding: 'utf8', parseFrontmatter: true }));
  expect(read.resolvedRef).toBe(profileCommit); expect(object(read.file)).toMatchObject({ content: profile.raw, frontmatter: profile.definition });
 }
 const allocationId = 'automatic-' + randomUUID();
 await f.query(`INSERT INTO project_agent_classes (id,team_id,project_id,slug,name,handler_refs_json,metadata_json,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?)`, [allocationId, 'team', projectId, 'maintenance', 'Shared allocation', JSON.stringify({ agents: profiles }),
  JSON.stringify({ source: 'project-library', immutableRef: profileCommit, definitionPaths: profileInputs.map(profile => profile.path) }), now, now]);
 const classes = new ProjectAgentClassRepository(f.store);
 const snapshot = await resolveWorkdayAgentProfileSnapshot({ listProjectAgentClassesPage: (id, page) => classes.listPage(id, { ...page, cursor: null }) }, projectId, undefined, groupIds);
 const selected = snapshot.agents.map(entry => entry.definition.id).sort();
 expect(selected).toEqual(profiles.slice(0, 3).map(profile => profile.id).sort());
 const runs: Array<{ id: string; selected: boolean }> = [];
 for (const chosen of [false, true]) {
  const id = 'workday-' + randomUUID(), selection = chosen ? { [projectId]: [definition] } : {}, snapshots = { [projectId]: snapshot };
  const participants = workdayParticipants({ groupIds, agentProfilesByProjectId: snapshots, proposalsByProjectId: selection });
  const appliedPlan = compileWorkday({ id, teamId: 'team', policyId: 'default', policyRevision: 1, executionMode: 'simulation', startsAt: now,
   agentIds: participants.map(value => value.id), policy: { ...DEFAULT_WORKDAY_POLICY, durationSeconds: 3600, maximumConcurrency: 5, communicationConcurrency: 5 } });
  const parameters = { groupIds, appliedPlan: { ...appliedPlan, state: 'active', activatedAt: now }, scheduledProjectIds: [projectId], agentProfilesByProjectId: snapshots,
   ...(chosen ? { proposalIds: [definition.id], planningSourceByProposalId: { [String(definition.id)]: reference } } : {}) };
  expect(Object.hasOwn(parameters, 'agentSelection')).toBe(false);
  await f.query('INSERT INTO capacity_workday_runs (id,team_id,execution_kind,execution_mode,status,parameters_json,started_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
   [id, 'team', 'workday', 'simulation', 'running', JSON.stringify(parameters), now, now, now]); runs.push({ id, selected: chosen });
 }
 const service = createExecutionGraphService(f.store), reconciled = await service.reconcile(f.principal, 'team', {}), graph = await service.show(f.principal, 'team', {});
 expect(reconciled).toMatchObject({ teamId: graph.teamId, revision: graph.revision, graphDigest: graph.digest });
 expect((await service.watch(f.principal, 'team', { cursor: '0' })).items).toEqual([reconciled]);
 const author = (node: typeof graph.nodes[number]) => node.authorityRefs?.find(ref => ref.model === 'agent')?.id;
 for (const run of runs) {
  const nodes = graph.nodes.filter(node => node.workdayId === run.id), planning = nodes.filter(node => node.kind === 'planning'), estimating = nodes.filter(node => node.kind === 'estimating');
  expect(planning.map(author).sort()).toEqual(selected); expect(estimating.map(author).sort()).toEqual(run.selected ? selected : []);
  for (const estimator of estimating) {
   expect(estimator.sourceRef).toEqual(reference); expect(estimator.status).toBe('blocked'); expect(estimator.workItemId).toBeUndefined();
   const own = planning.filter(node => author(node) === author(estimator)); expect(own).toHaveLength(1);
   const predecessors = graph.edges.filter(edge => edge.toNodeId === estimator.id).map(edge => edge.fromNodeId).sort();
   expect(predecessors).toEqual([own[0]!.id]);
   const explanation = await service.explain(f.principal, 'team', estimator.id); expect(explanation.admission.eligible).toBe(false);
   expect(explanation.predecessors.map(value => value.node!.id).sort()).toEqual(predecessors);
   expect(explanation.blockingReasons).toContain('predecessor-incomplete:' + own[0]!.id);
  }
 }
 const state = async () => ({ nodes: await f.store.all('SELECT * FROM execution_nodes ORDER BY id'), edges: await f.store.all('SELECT * FROM execution_edges ORDER BY id'),
  revisions: await f.store.all('SELECT * FROM execution_graph_revisions ORDER BY team_id,revision'), events: await f.store.all('SELECT * FROM capacity_workday_events ORDER BY run_id,event_index,id'),
  attempts: await f.store.all('SELECT * FROM capacity_provider_assignments ORDER BY id'), reservations: await f.store.all('SELECT * FROM capacity_reservations ORDER BY id'),
  usage: await f.store.all('SELECT * FROM capacity_usage_actuals ORDER BY id'), ledger: await f.store.all('SELECT * FROM capacity_ledger_entries ORDER BY id') });
 const held = await state(); expect(held.edges.filter(edge => edge.graph_revision_removed === null)).toHaveLength(graph.edges.length);
 for (const rows of [held.attempts, held.reservations, held.usage, held.ledger]) expect(rows).toEqual([]);
 if (!f.peerStore) throw new Error('Independent native PostgreSQL connection required');
 const peer = createExecutionGraphService(f.peerStore), replays = await Promise.all([service.reconcile(f.principal, 'team', {}), peer.reconcile(f.principal, 'team', {})]);
 expect(replays).toEqual([reconciled, reconciled]); expect(await state()).toEqual(held); expect(await peer.show(f.principal, 'team', {})).toEqual(graph);
 const profile = profileInputs.find(input => input.definition.id === selected[0]); if (!profile) throw new Error('Exact subscribed estimator input required');
 return { allocationId, definition: profile.definition, profileRef: exactEntityReferenceSchema.parse({ store: 'treedx', model: 'agent', id: profile.definition.id,
  repository, commit: profileCommit, path: profile.path }) };
}
