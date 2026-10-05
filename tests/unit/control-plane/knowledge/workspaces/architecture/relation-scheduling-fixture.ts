import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { stringify } from 'yaml';
import { allocateWorkdayCapacity, assignmentAttemptSchema, assignmentResultSchema, compileWorkday, effectiveActivityProfileSchema, executionNodeSchema, exactEntityReferenceSchema, type ExactEntityReference } from '@treeseed/sdk/agent-capacity';
import { relationPublicationDatabase } from './relation-publication-fixture.ts';
import { object } from './relation-authoring-fixture.ts';
import { candidate, gitRef, provider } from '../../../capacity/execution/fixtures/assignment-attempt-fixtures.ts';
import { replayAttempt } from '../../../capacity/execution/architecture/admission-replay-fixture.ts';
import { graphNode, graphState, emptyLivingGraph } from '../../../capacity/execution/graph/architecture/living/living-graph-fixture.ts';
import { serializeCapacityWorkdayRunRow } from '../../../../../../src/api/capacity/repositories/capacity/workdays/workday-run.ts';
import { buildAssignmentAttempt } from '../../../../../../src/api/capacity/services/capacity/assignments/planning/execution/assignment-attempt-builder.ts';
import { listReadyExecutionNodes } from '../../../../../../src/api/capacity/services/build/ready-execution-node.ts';
import { applyOperationalState, type TeamGraph } from '../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-state.ts';
import { persistExecutionGraph } from '../../../../../../src/api/control-plane/repositories/capacity/execution/execution-graph-service.ts';

export function schedulingInputs(): Parameters<typeof buildAssignmentAttempt>[0] {
	const now = '2026-09-13T12:00:00.000Z', plan = { ...compileWorkday({ id: 'workday', teamId: 'team', policyId: 'default', policyRevision: 1,
		executionMode: 'simulation', startsAt: now, agentIds: [], policy: { durationSeconds: 3600, planningPercent: 20, maximumConcurrency: 1, communicationConcurrency: 1 } }), state: 'active' as const };
	const run = serializeCapacityWorkdayRunRow({ id: plan.id, team_id: 'team', scenario_id: 'isolated-relation', status: 'running', environment: 'local',
		execution_kind: 'workday', trigger_kind: 'manual', execution_mode: 'simulation', created_at: now, updated_at: now, started_at: now,
		parameters_json: JSON.stringify({ appliedPlan: plan }), ...Object.fromEntries(['summary', 'metrics', 'expected', 'actual', 'report_refs', 'error'].map(key => [`${key}_json`, '{}'])) }); assert.ok(run);
	const approval = { store: 'treedx' as const, model: 'decision', id: 'precursor-approval', repository: 'precursor-library', commit: 'd'.repeat(40), path: 'decisions/approval.md' };
	const actor = assignmentResultSchema.parse({ schemaVersion: 'treeseed.assignment-result/v1', id: 'precursor-actor-result', assignmentId: 'precursor-actor', status: 'completed',
		summary: 'Supplied predecessor candidate input.', references: [{ kind: 'git', repository: 'treeseed-ai/precursor', commit: 'e'.repeat(40) }],
		verification: [], usage: { elapsedSeconds: 1 }, diagnostics: [], completedAt: now });
	const review = assignmentResultSchema.parse({ ...actor, id: 'precursor-review-result', assignmentId: 'precursor-review', references: [{ kind: 'treedx', projectId: 'precursor', repository: approval.repository, commit: approval.commit, path: approval.path }] });
	const permissions = { content: { read: ['proposal', 'decision'], write: [] }, tools: ['source.read', 'source.write', 'verification'] };
	const opportunity = allocateWorkdayCapacity({ now, remainingSeconds: 180, workdays: [{ plan, committedSeconds: 0, planningCommittedSeconds: 0, maximumAdditionalSeconds: 180, actingReady: true }] })[plan.id]; assert.ok(opportunity);
	return { candidate: { ...candidate, readyAt: now, sourceRepositories: ['treeseed-ai/sdk'], node: executionNodeSchema.parse({ ...candidate.node, requestedPermissions: permissions }),
		effectiveProfile: effectiveActivityProfileSchema.parse({ ...candidate.effectiveProfile, permissionCeiling: permissions }),
		contextRefs: [gitRef, { store: 'git', model: 'repository', id: 'precursor-candidate', repository: 'treeseed-ai/precursor', commit: 'e'.repeat(40) }, approval], predecessorResults: [actor, review] },
		run, principal: { teamId: 'team', capacityProviderId: 'provider', membershipId: 'membership' }, providerSessionId: 'session',
		providers: [{ ...provider, lanes: provider.lanes.map(lane => ({ ...lane, purpose: 'workday' })) }], allocationInputs: { codex: { measurements: [], constraints: [], opportunity } }, attempt: 1, now };
}

// Native publication/profile/proposal files, original SQL and actual candidate
// loader. Reviewed decisions/results/statuses and run clocks are supplied INPUTS,
// not live Actor/Reviewer execution, provider polling/admission or generated usage.
export async function relationSchedulingDatabase(primarySource?: ExactEntityReference, workItemPriorities?: ReadonlyMap<string, number>) {
	const f = await relationPublicationDatabase(); let teamRepository: string | undefined;
	const close = async () => {
		const failures: unknown[] = [];
		if (teamRepository) try { await f.client.repositories.retire(teamRepository); } catch (error) { failures.push(error); }
		try { await f.close(); } catch (error) { failures.push(error); }
		if (failures.length) throw new AggregateError(failures, 'Relation scheduling fixture cleanup failed');
	};
	try {
		const run = schedulingInputs().run, now = run.createdAt;
		if (workItemPriorities) {
			const matched = new Set<string>();
			for (const source of f.sources) {
				const workItems = object(source.frontmatter.executionPlan).workItems; assert.ok(Array.isArray(workItems));
				for (const value of workItems) {
					const item = object(value), key = `${source.projectId}:${item.id}`;
					if (workItemPriorities.has(key)) { item.priority = workItemPriorities.get(key); matched.add(key); }
				}
			}
			assert.equal(matched.size, workItemPriorities.size, 'Every controlled priority input must name an original work item');
		}
		if (primarySource) {
			const reference = exactEntityReferenceSchema.parse(primarySource);
			assert.equal(reference.store, 'git');
			const dependent = f.sources.find(source => source.projectId === 'dependent'); assert.ok(dependent);
			const workItems = object(dependent.frontmatter.executionPlan).workItems; assert.ok(Array.isArray(workItems));
			for (const item of workItems) object(item).contextRefs = [structuredClone(reference)];
		}
		for (const source of f.sources) {
			const binding = await f.store.getProjectTreeDxLibrary(source.projectId); assert.ok(binding);
			const paths = [source.path, ...Object.values(f.profiles).filter(definition => definition.agentClass && f.profiles[`${source.projectId}:${definition.agentClass}`] === definition).map(definition => `agents/${definition.agentClass}.md`)] ;
			const workspace = object(await f.client.workspaces.create(source.repository, { baseRef: String(binding.contentRepositoryRef), branchName: 'refs/heads/staging', mode: 'writable', allowedPaths: paths }));
			const id = String(workspace.workspaceId); let failure: unknown;
			try {
				const bytes = `---\n${stringify(source.frontmatter)}---\n\nExact supplied accepted proposal.\n`;
				await f.client.files.write(id, { path: source.path, content: bytes });
				for (const definition of Object.values(f.profiles).filter(value => f.profiles[`${source.projectId}:${value.agentClass}`] === value)) {
					await f.client.files.write(id, { path: `agents/${definition.agentClass}.md`, content: `---\n${stringify(definition)}---\n` });
				}
				const committed = object(await f.client.files.commit(id, { message: 'Exact disposable scheduler inputs', author: { name: 'Fixture', email: 'fixture@example.invalid' } }));
				source.commit = String(committed.commitSha); assert.match(source.commit, /^[a-f0-9]{40}$/u);
				source.digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
				await f.query('UPDATE treedx_project_libraries SET content_repository_ref=? WHERE project_id=?', [source.commit, source.projectId]);
				for (const definition of Object.values(f.profiles).filter(value => f.profiles[`${source.projectId}:${value.agentClass}`] === value)) {
					await f.query(`INSERT INTO project_agent_classes (id,team_id,project_id,slug,name,handler_refs_json,metadata_json,created_at,updated_at)
						VALUES (?,?,?,?,?,?,?,?,?)`, [`${source.projectId}:${definition.agentClass}`, 'team', source.projectId, definition.agentClass, definition.name,
							JSON.stringify({ agents: [definition] }), JSON.stringify({ source: 'project-library', immutableRef: source.commit, definitionPaths: [`agents/${definition.agentClass}.md`] }), now, now]);
				}
			} catch (error) { failure = error; throw error; }
			finally { try { await f.client.workspaces.close(id); } catch (error) { if (failure) throw new AggregateError([failure, error], 'Native input write and workspace close failed'); throw error; } }
		}
		Object.assign(f.link.from, { commit: f.sources[0]!.commit, digest: f.sources[0]!.digest });
		Object.assign(f.link.to, { commit: f.sources[1]!.commit, digest: f.sources[1]!.digest });
		const repository = object(object(await f.client.repositories.create({ repositoryName: `api-relation-team-${randomUUID()}` })).repo);
		teamRepository = String(repository.repoId); assert.equal(repository.storageKind, 'managed'); assert.ok(!repository.remoteUrl);
		const refs = object(await f.client.repositories.refs(teamRepository)); assert.ok(Array.isArray(refs.refs));
		const main = refs.refs.map(object).find(ref => ref.name === 'refs/heads/main'); assert.ok(main);
		const teamCommit = String(main.target ?? main.sha); assert.match(teamCommit, /^[a-f0-9]{40}$/u);
		await f.query('INSERT INTO projects (id,team_id,slug,name,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)', ['team-context', 'team', 'team', 'Isolated Team Library', '{}', now, now]);
		await f.query(`INSERT INTO treedx_project_libraries (id,team_id,project_id,instance_id,library_id,repository_id,content_path,content_repository_ref,created_at,updated_at)
			VALUES (?,?,?,?,?,?,?,?,?,?)`, ['team-context-binding', 'team', 'team-context', 'native-conformance', 'team-context', teamRepository, '.', teamCommit, now, now]);
		await f.query(`INSERT INTO capacity_providers (id,fingerprint,public_jwk_json,display_name,created_at,updated_at) VALUES ('provider','isolated','{}','Supplied provider',?,?)`, [now, now]);
		await f.query(`INSERT INTO capacity_provider_team_memberships (id,team_id,capacity_provider_id,approved_at,approved_by_id,created_at,updated_at) VALUES ('membership','team','provider',?,'operator',?,?)`, [now, now, now]);
		const parameters = { ...run.parameters, proposalIds: f.sources.map(source => String(source.frontmatter.id)), decisionIds: f.sources.map(source => source.decision!.id) };
		const currentRun = { ...run, parameters };
		let current = emptyLivingGraph();
		const reconcile = async (states: Map<string, { status: TeamGraph['nodes'][number]['status']; nodeRevision: number }> = new Map()) => {
			const projection = f.project(await f.load(), current.revision + 1);
			const next = current.revision === 0 ? graphState(projection) : applyOperationalState(current, { teamId: 'team', revision: projection.revision.revision,
				digest: projection.revision.graphDigest, nodes: projection.nodes, edges: projection.edges }, projection.revision.revision, new Set(), states);
			await persistExecutionGraph(f.store, next, current, { ...projection.revision, graphDigest: next.digest }); current = next; return current;
		};
		const publish = async () => {
			const workspace = await f.create(), written = await f.write(workspace, `---\n${stringify(f.note)}---\n\nReviewed precursor governs dependent work.\n`);
			const submitted = await f.submit(written.workspace), result = await f.run(submitted.integration.operation.id); assert.equal(result.ok, true);
			return { submitted, graph: await reconcile() };
		};
		const ready = () => listReadyExecutionNodes(f.store, currentRun, { id: 'dependent', slug: 'dependent' });
		const completeInputs = async () => {
			const actor = graphNode(current, 'first', 'actor', 'precursor'), review = graphNode(current, 'first', 'reviewer', 'precursor');
			const source = replayAttempt();
			const rows = [actor, review].map(node => {
				const reviewing = node.pairRole === 'reviewer';
				const ref = { store: 'treedx' as const, model: 'decision', id: 'precursor-approval', repository: node.sourceRef.repository!, commit: f.sources[0]!.commit, path: 'decisions/approval.md' };
				// Completed predecessor DTOs are deliberately supplied SQL inputs to
				// the candidate reader, not executions of these native readonly nodes.
				const attempt = assignmentAttemptSchema.parse({ ...source, agentClass: node.agentClass, id: `input-${node.id}`, idempotencyKey: `input-${node.id}`, projectId: 'precursor', workdayId: run.id,
					nodeId: node.id, nodeRevision: node.nodeRevision, graphRevision: current.revision, workItemId: 'first', sourceRef: node.sourceRef, authorityRefs: node.authorityRefs,
					grant: { ...source.grant, contentWrite: reviewing ? [ref] : [] }, predecessorResultIds: reviewing ? [`result-${actor.id}`] : [] });
				const result = assignmentResultSchema.parse({ schemaVersion: 'treeseed.assignment-result/v1', id: `result-${node.id}`, assignmentId: attempt.id,
					status: 'completed', summary: 'Supplied reviewed predecessor INPUT, not a live execution.', references: reviewing
						? [{ kind: 'treedx', projectId: 'precursor', repository: ref.repository, commit: ref.commit, path: ref.path }]
						: [{ kind: 'git', repository: 'treeseed-ai/precursor', commit: 'e'.repeat(40) }], verification: [], usage: { elapsedSeconds: 1 }, diagnostics: [], completedAt: run.createdAt });
				return { node, attempt, result };
			});
			for (const value of rows) await f.query(`INSERT INTO capacity_provider_assignments
				(id,membership_id,team_id,project_id,capacity_provider_id,project_agent_class_id,work_day_id,mode,status,lease_state,decision_id,execution_node_id,execution_node_revision,assignment_attempt_json,assignment_result_json,completed_at,created_at,updated_at)
				VALUES (?,'membership','team','precursor','provider',?,?,'acting','completed','released',?,?,?,?,?,?,?,?)`,
				[value.attempt.id, `precursor:${value.node.agentClass}`, run.id, f.sources[0]!.decision!.id, value.node.id, value.node.nodeRevision,
					JSON.stringify(value.attempt), JSON.stringify(value.result), run.createdAt, run.createdAt, run.createdAt]);
			await reconcile(new Map(rows.map(value => [value.node.id, { status: 'completed' as const, nodeRevision: value.node.nodeRevision }])));
			return rows;
		};
		const snapshot = async () => ({ ...await f.snapshot(), graph: current, assignments: await f.store.all('SELECT * FROM capacity_provider_assignments ORDER BY id'),
			reservations: await f.store.all('SELECT * FROM capacity_reservations ORDER BY id'), classes: await f.store.all('SELECT * FROM project_agent_classes ORDER BY id') });
		return { ...f, currentRun, ready, publish, completeInputs, reconcile, snapshot, close };
	} catch (error) { try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Relation scheduling setup and cleanup failed'); } throw error; }
}
