import { describe, expect, it } from 'vitest';
import { relationSchedulingDatabase } from './relation-scheduling-fixture.ts';
import { graphNode } from '../../../capacity/execution/graph/architecture/living/living-graph-fixture.ts';
import { DEFAULT_WORKDAY_POLICY, assignmentAttemptSchema, assignmentResultSchema, compileWorkday, validateAgentDefinitionModel } from '@treeseed/sdk/agent-capacity';
import { object } from './relation-authoring-fixture.ts';
import { listReadyExecutionNodes } from '../../../../../../src/api/capacity/services/build/ready-execution-node.ts';
import { assignNextReadyExecutionNode } from '../../../../../../src/api/capacity/services/capacity/assignments/planning/execution/living-execution-assignment.ts';
import { buildAssignmentAttempt } from '../../../../../../src/api/capacity/services/capacity/assignments/planning/execution/assignment-attempt-builder.ts';
import { livingAllocationInputs } from '../../../../../../src/api/capacity/services/capacity/assignments/admission/living-allocation-inputs.ts';
import { resolveKnowledgeGatewayConnection } from '../../../../../../src/api/knowledge/gateway-treedx-connection.ts';
import { createHash } from 'node:crypto';
import { canonicalOfferBuildInput } from '../../../capacity/execution/fixtures/assignment-attempt-fixtures.ts';
import { snapshotAgentDefinitions } from '../../../../../../src/api/capacity/services/capacity/agents/agent-definition-snapshot.ts';

describe('native publication to owning scheduler candidate input', () => {
	it('native exact Agent snapshots retain owning YAML diagnostics and invalid committed bytes before unchanged valid source retry', async () => {
		const f = await relationSchedulingDatabase();
		try {
			const source = f.sources.find(value => value.projectId === 'dependent'); if (!source) throw new Error('Original native source required.');
			const connect = async (commit: string) => {
				const connection = await resolveKnowledgeGatewayConnection(f.store, { projectId: source.projectId, write: false,
					readRefs: [commit], workspacePaths: ['agents/**'] });
				if (!connection) throw new Error('Original exact native agent read connection required.'); return connection;
			};
			const connection = await connect(source.commit), before = await f.snapshot(), baseline = await snapshotAgentDefinitions(connection, source.commit);
			expect(baseline.commit).toBe(source.commit); expect(baseline.files.length).toBeGreaterThan(0); expect(await f.snapshot()).toEqual(before);
			const path = 'agents/invalid.mdx', bytes = '---\nid: invalid\n---\n', validation = validateAgentDefinitionModel({ id: 'invalid' });
			expect(validation.ok).toBe(false); expect(validation.diagnostics.length).toBeGreaterThan(0);
			const workspace = object(await f.client.workspaces.create(source.repository, { baseRef: source.commit,
				branchName: 'refs/heads/staging', mode: 'writable', allowedPaths: [path] }));
			const id = String(workspace.workspaceId); let commit: string;
			try {
				await f.client.files.write(id, { path, content: bytes });
				const committed = object(await f.client.files.commit(id, { message: 'Retained invalid native Agent input',
					author: { name: 'Fixture', email: 'fixture@example.invalid' } }));
				commit = String(committed.commitSha); expect(commit).toMatch(/^[a-f0-9]{40}$/u); expect(commit).not.toBe(source.commit);
			} finally { await f.client.workspaces.close(id); }
			const invalid = await connect(commit);
			for (let retry = 0; retry < 2; retry++) {
				await expect(snapshotAgentDefinitions(invalid, commit)).rejects.toMatchObject({ code: 'agent_team_definition_invalid', status: 409,
					details: { path, diagnostics: validation.diagnostics } });
				const read = object(await invalid.client.readRepositoryFile({ repoId: source.repository, ref: commit, path }));
				expect(read.resolvedRef).toBe(commit);
				const file = object(read.file ?? (Array.isArray(read.files) ? read.files[0] : undefined));
				expect(file).toMatchObject({ path, content: bytes }); expect(await f.snapshot()).toEqual(before);
			}
			expect(await snapshotAgentDefinitions(connection, source.commit)).toEqual(baseline); expect(await f.snapshot()).toEqual(before);
			// Invalid native bytes remain committed, never repaired or registered.
			// Supplied credentials/profile inputs are not managed provider execution.
		} finally { await f.close(); }
	}, 60_000);
	it('native exact governed Proposal bytes produce the same canonical work-item priority on Actor and Reviewer nodes without making blocked work ready', async () => {
		const priorities = new Map([['precursor:first', -1], ['dependent:first', Number.MAX_SAFE_INTEGER]]), supplied = new Map(priorities);
		const f = await relationSchedulingDatabase(undefined, priorities);
		try {
			const sources = structuredClone(f.sources), files: Array<{ source: typeof f.sources[number]; returned: Record<string, unknown> }> = [];
			const readSource = async (source: typeof f.sources[number]) => {
				const connection = await resolveKnowledgeGatewayConnection(f.store, { projectId: source.projectId, write: false,
					readRefs: [source.commit], workspacePaths: [source.path] });
				expect(connection).toBeTruthy();
				const returned = object(await connection!.client.readRepositoryFile({ repoId: source.repository, ref: source.commit, path: source.path }));
				expect(returned.resolvedRef).toBe(source.commit);
				const file = object(returned.file ?? (Array.isArray(returned.files) ? returned.files[0] : undefined));
				expect(file.path).toBe(source.path); expect(typeof file.content).toBe('string');
				expect(`sha256:${createHash('sha256').update(String(file.content)).digest('hex')}`).toBe(source.digest);
				return returned;
			};
			for (const source of f.sources) files.push({ source, returned: await readSource(source) });
			const published = await f.publish(), before = await f.snapshot();
			for (const [key, priority] of priorities) {
				const [projectId, workItemId] = key.split(':');
				const nodes = published.graph.nodes.filter(node => node.projectId === projectId && node.workItemId === workItemId);
				expect(nodes.map(node => node.pairRole).sort()).toEqual(['actor', 'reviewer']);
				for (const node of nodes) expect(node).toMatchObject({ priority });
				const rows = await f.query('SELECT id,priority::text AS priority,status FROM execution_nodes WHERE project_id=? AND work_item_id=? ORDER BY id', [projectId, workItemId]);
				expect(rows.rows).toEqual(nodes.map(node => ({ id: node.id, priority: String(priority), status: node.status })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
			}
			expect(graphNode(published.graph, 'first', 'actor', 'dependent').status).toBe('blocked'); expect(await f.ready()).toEqual([]);
			expect(await f.snapshot()).toEqual(before);
			await f.completeInputs(); const ready = await f.ready(); expect(ready.length).toBeGreaterThan(0);
			for (const value of ready.filter(value => value.node.workItemId === 'first')) expect(value.node).toMatchObject({ priority: Number.MAX_SAFE_INTEGER });
			expect(ready.some(value => value.node.workItemId === 'first')).toBe(true);
			const committed = await f.snapshot(); expect(await f.ready()).toEqual(ready); expect(await f.snapshot()).toEqual(committed);
			expect(f.sources).toEqual(sources); expect(priorities).toEqual(supplied);
			for (const file of files) expect(await readSource(file.source)).toEqual(file.returned);
			// Existing native Proposal file write/commit/digest, public Note
			// publication, owning projection/SQL and native ready-content reads.
			// Accepted Decision and predecessor completion remain supplied inputs.
		} finally { await f.close(); }
	}, 60_000);
	it('native original scheduler applies provider hard gates before weighted priority selection and retains the exact eligible input beside one atomic admission', async () => {
		const f = await relationSchedulingDatabase();
		try {
			await f.publish(); await f.completeInputs();
			// All native content/schema setup precedes this new supplied admission
			// input. This is not a refresh of an executing assignment or lease.
			// This logical admission uses supplied provider/clock authority, not an
			// authenticated wall-clock observation. Keep its positive input away
			// from UTC rollover; the companion boundary case proves subsecond denial.
			const now = canonicalOfferBuildInput().now, startsAt = new Date(Date.parse(now) - 721_000).toISOString();
			const plan = { ...compileWorkday({ id: f.currentRun.id, teamId: f.currentRun.teamId, policyId: 'default', policyRevision: 1,
				executionMode: 'simulation', startsAt, agentIds: [], policy: { ...DEFAULT_WORKDAY_POLICY, durationSeconds: 3600, planningPercent: 20,
					maximumConcurrency: 1, communicationConcurrency: 1, projectPercentages: { precursor: 90, dependent: 10 } } }), state: 'active' as const };
			const parameters = { ...f.currentRun.parameters, projects: ['precursor', 'dependent'], scheduledProjectIds: ['precursor', 'dependent'], appliedPlan: plan };
			Object.assign(f.currentRun, { parameters, startedAt: startsAt });
			await f.query(`INSERT INTO capacity_workday_runs (id,team_id,capacity_provider_id,scenario_id,status,environment,execution_kind,trigger_kind,execution_mode,parameters_json,started_at,created_at,updated_at)
				VALUES (?,?,'provider','native-eligible-selection','running','local','workday','manual','simulation',?,?,?,?)`,
				[f.currentRun.id, f.currentRun.teamId, JSON.stringify(parameters), startsAt, startsAt, now]);
			const providers = structuredClone(canonicalOfferBuildInput(now, 'treeseed.research.verification').providers), principal = { teamId: f.currentRun.teamId, capacityProviderId: 'provider', membershipId: 'membership' };
			for (const provider of providers) {
				if (!provider.accountingObservation) throw new Error('Original accounting observation required');
				provider.accountingObservation.modelUsage = { ...provider.accountingObservation.modelUsage, day: now.slice(0, 10), observedAt: now };
				for (const capability of Object.keys(provider.accountingObservation.capabilityUsage)) {
					const original = provider.accountingObservation.capabilityUsage[capability]!;
					provider.accountingObservation.capabilityUsage[capability] = { ...original, day: now.slice(0, 10), observedAt: now };
				}
				await f.query(`INSERT INTO capacity_execution_providers (id,capacity_provider_id,display_name,adapter,native_unit,max_concurrent_runners,native_limits_json,created_at,updated_at)
					VALUES (?,'provider',?,'codex','seconds',1,?,?,?)`, [provider.id, provider.id, JSON.stringify(provider.accountingLimits), now, now]);
				for (const lane of provider.lanes) await f.query(`INSERT INTO capacity_provider_lanes (id,capacity_provider_id,execution_provider_id,display_name,purpose,max_concurrent_runners,created_at,updated_at)
					VALUES (?,'provider',?,?,'workday',1,?,?)`, [lane.id, provider.id, lane.id, now, now]);
			}
			await f.query(`INSERT INTO capacity_provider_availability_sessions (id,membership_id,team_id,capacity_provider_id,opened_at,refreshed_at,expires_at,available_from,execution_providers_json,created_at,updated_at)
				VALUES ('session','membership',?,'provider',?,?,?,?,?,?,?)`, [principal.teamId, now, now, plan.endsAt, now, JSON.stringify(providers), now, now]);
			const precursor = (await listReadyExecutionNodes(f.store, f.currentRun, { id: 'precursor', slug: 'precursor' }));
			expect(precursor.length).toBeGreaterThan(0);
			// A ready high-share/high-priority node with no qualified provider must
			// not enter the eligible fair inventory or create a reservation.
			for (const value of precursor) await f.query('UPDATE execution_nodes SET required_capabilities_json=?,priority=? WHERE id=?',
				[JSON.stringify(['unavailable-fixture-capability']), 100, value.node.id]);
			const ready = (await Promise.all(['precursor', 'dependent'].map(id => listReadyExecutionNodes(f.store, f.currentRun, { id, slug: id })))).flat();
			expect(ready.some(value => value.node.projectId === 'precursor')).toBe(true);
			const eligible = [];
			for (const value of ready) {
				const allocations = await livingAllocationInputs(f.store, { run: f.currentRun, runs: [f.currentRun], providers,
					capacityProviderId: principal.capacityProviderId, capabilityId: value.node.requiredCapabilities?.[0] ?? '', agentClass: value.node.agentClass!, activity: value.effectiveProfile.activity, now });
				try {
					buildAssignmentAttempt({ candidate: value, run: f.currentRun, principal, providerSessionId: 'session', providers, allocationInputs: allocations, attempt: 1, now });
					eligible.push(value);
				} catch (error) {
					expect(value.node.projectId, error instanceof Error ? error.message : 'Unexpected native build denial').toBe('precursor'); expect(error).toMatchObject({ code: 'capacity_execution_provider_unavailable' });
				}
			}
			expect(eligible.length).toBeGreaterThan(0); expect(eligible.every(value => value.node.projectId === 'dependent')).toBe(true);
			const before = await f.snapshot(), supplied = structuredClone({ providers, principal, parameters });
			const observation = object(await assignNextReadyExecutionNode(f.capacity, principal, 'session', providers, now)), admitted = object(observation.assignment);
			const attempt = assignmentAttemptSchema.parse(admitted.assignmentAttempt); expect(attempt.projectId).toBe('dependent');
			expect(attempt.limits.maximumSeconds).toBe(3); expect(attempt.deadline).toBe(plan.endsAt);
			const selection = object(object(object(admitted.explanation).metadata).allocation).selection;
			const expected = eligible.map(value => {
				const node = object(value.node);
				expect(!Object.hasOwn(node, 'priority') || typeof node.priority === 'number' && Number.isSafeInteger(node.priority)).toBe(true);
				return { id: value.node.id, projectId: value.node.projectId, agentClass: value.node.agentClass!, readyAt: value.readyAt || now,
					...(typeof node.priority === 'number' ? { priority: node.priority } : {}) };
			});
			expect(selection).toMatchObject({ id: attempt.nodeId, input: { nodes: expected, usage: [] } });
			const committed = await f.snapshot();
			expect(committed.assignments).toHaveLength(before.assignments.length + 1); expect(committed.reservations).toHaveLength(1);
			expect(committed.ledger).toEqual(before.ledger); expect({ providers, principal, parameters }).toEqual(supplied);
			const again = object(await assignNextReadyExecutionNode(f.capacity, principal, 'session', providers, now)); expect(again.assignment).toBeNull();
			expect(await f.snapshot()).toEqual(committed);
			// Actual native content reads and original SQL/scheduler/builder/admission.
			// Provider availability/principal/predecessors remain controlled INPUTS,
			// not signed enrollment, live model billing or provider-global fairness.
		} finally { await f.close(); }
	}, 60_000);
	it('native exact proposal context preserves the primary source lineage while foreign predecessor citations remain read-only evidence in either reference order', async () => {
		const primary = { store: 'git' as const, model: 'repository', id: 'dependent-source', repository: 'treeseed-ai/dependent', commit: 'c'.repeat(40) };
		const f = await relationSchedulingDatabase(primary); try {
			await f.publish(); const supplied = await f.completeInputs(), sources = structuredClone(f.sources);
			const actor = supplied.find(value => value.node.pairRole === 'actor'); expect(actor).toBeTruthy();
			const original = await f.snapshot();
			const foreignOnly = (await f.ready()).find(value => value.node.workItemId === 'first'); expect(foreignOnly).toBeTruthy();
			expect(foreignOnly!.lineageSourceCommit).toBeUndefined();
			expect(foreignOnly!.directPredecessorSourceCommit).toBeUndefined();
			expect(foreignOnly!.contextRefs).toContainEqual(primary);
			expect(foreignOnly!.contextRefs).toContainEqual(expect.objectContaining({ store: 'git', repository: 'treeseed-ai/precursor', commit: 'e'.repeat(40) }));
			expect(await f.snapshot()).toEqual(original);
			const references = [{ kind: 'git' as const, repository: primary.repository, commit: '8'.repeat(40) }, ...actor!.result.references];
			const observed: Array<Awaited<ReturnType<typeof f.ready>>> = [];
			for (const ordered of [references, [...references].reverse()]) {
				const result = assignmentResultSchema.parse({ ...actor!.result, references: ordered });
				await f.query('UPDATE capacity_provider_assignments SET assignment_result_json=? WHERE id=?', [JSON.stringify(result), actor!.attempt.id]);
				const before = await f.snapshot(), reads = await Promise.all([f.ready(), f.ready()]);
				for (const ready of reads) {
					const candidate = ready.find(value => value.node.workItemId === 'first'); expect(candidate).toBeTruthy();
					expect(candidate!.lineageSourceCommit).toBe('8'.repeat(40));
					expect(candidate!.directPredecessorSourceCommit).toBe('8'.repeat(40));
					expect(candidate!.predecessorResults).toContainEqual(result);
					expect(candidate!.contextRefs).toContainEqual(primary);
					expect(candidate!.contextRefs).toContainEqual(expect.objectContaining({ store: 'git', repository: 'treeseed-ai/precursor', commit: 'e'.repeat(40) }));
					observed.push(ready);
				}
				expect(await f.snapshot()).toEqual(before);
			}
			expect(observed).toHaveLength(4); expect(f.sources).toEqual(sources);
			await f.query('UPDATE capacity_provider_assignments SET assignment_result_json=? WHERE id=?', [JSON.stringify(actor!.result), actor!.attempt.id]);
			expect(await f.snapshot()).toEqual(original);
			expect((await f.ready()).find(value => value.node.workItemId === 'first')!.lineageSourceCommit).toBeUndefined();
		} finally { await f.close(); }
	}, 60_000);
	it('actual native Note publication blocks the dependent ready-node query before any successful independent predecessor input exists', async () => {
		const f = await relationSchedulingDatabase(); try {
			const published = await f.publish(), before = await f.snapshot();
			expect(graphNode(published.graph, 'first', 'actor', 'dependent').status).toBe('blocked');
			expect(await f.ready()).toEqual([]); expect(await f.snapshot()).toEqual(before);
			expect(before.assignments).toEqual([]); expect(before.reservations).toEqual([]); expect(before.ledger).toEqual([]);
		} finally { await f.close(); }
	}, 60_000);
	it('actual original graph SQL and native exact profile proposal reads retain both cross-project Actor and Reviewer results despite distinct accepted Decision ownership', async () => {
		const f = await relationSchedulingDatabase(); try {
			await f.publish(); const originals = structuredClone(f.sources), inputs = await f.completeInputs(), before = await f.snapshot(), candidates = await f.ready();
			const candidate = candidates.find(value => value.node.workItemId === 'first'); expect(candidate).toBeTruthy();
			expect(candidate!.predecessorResults.map(value => value.id).sort()).toEqual(inputs.map(value => value.result.id).sort());
			expect(candidate!.effectiveProfile.profileRef).toMatchObject({ repository: f.sources[1]!.repository, commit: f.sources[1]!.commit, path: 'agents/boundary-author.md' });
			expect(candidate!.contextRefs).toContainEqual(expect.objectContaining({ store: 'git', repository: 'treeseed-ai/precursor', commit: 'e'.repeat(40) }));
			expect(candidate!.contextRefs).toContainEqual(expect.objectContaining({ store: 'treedx', model: 'decision', repository: f.sources[0]!.repository, path: 'decisions/approval.md' }));
			expect(f.sources).toEqual(originals); expect(await f.snapshot()).toEqual(before); expect(before.reservations).toEqual([]); expect(before.ledger).toEqual([]);
			for (const input of inputs) for (const changed of ['decision', 'revision', 'failed-result'] as const) {
				await f.query('UPDATE capacity_provider_assignments SET decision_id=?,execution_node_revision=?,assignment_result_json=? WHERE id=?',
					[changed === 'decision' ? 'foreign-decision' : f.sources[0]!.decision!.id,
						changed === 'revision' ? input.node.nodeRevision + 1 : input.node.nodeRevision,
						JSON.stringify(changed === 'failed-result' ? { ...input.result, status: 'failed' } : input.result), input.attempt.id]);
				const invalid = await f.snapshot();
				await expect(f.ready()).rejects.toMatchObject({ code: 'execution_node_predecessor_result_missing' });
				expect(await f.snapshot()).toEqual(invalid);
				await f.query('UPDATE capacity_provider_assignments SET decision_id=?,execution_node_revision=?,assignment_result_json=? WHERE id=?',
					[f.sources[0]!.decision!.id, input.node.nodeRevision, JSON.stringify(input.result), input.attempt.id]);
			}
			expect(await f.snapshot()).toEqual(before); expect(await f.ready()).toEqual(candidates);
		} finally { await f.close(); }
	}, 60_000);
	it('failed cancelled running and Actor-only supplied predecessor states cannot make the native dependent candidate eligible', async () => {
		for (const status of ['failed', 'cancelled', 'running', 'blocked'] as const) {
			const f = await relationSchedulingDatabase(); try {
				const { graph } = await f.publish(), actor = graphNode(graph, 'first', 'actor', 'precursor'), reviewer = graphNode(graph, 'first', 'reviewer', 'precursor');
				await f.reconcile(new Map([[actor.id, { status: 'completed', nodeRevision: actor.nodeRevision }], [reviewer.id, { status, nodeRevision: reviewer.nodeRevision }]]));
				const before = await f.snapshot(); expect(await f.ready()).toEqual([]); expect(await f.snapshot()).toEqual(before);
			} finally { await f.close(); }
		}
	}, 60_000);
	it('missing disabled unpinned and moved native profile authority denies candidate retrieval without durable assignment reservation or financial mutation', async () => {
		for (const mode of ['missing', 'disabled', 'unpinned', 'moved'] as const) {
			const f = await relationSchedulingDatabase(); try {
				await f.publish(); await f.completeInputs();
				if (mode === 'missing') await f.query("UPDATE project_agent_classes SET handler_refs_json='{}' WHERE project_id='dependent'");
				if (mode === 'disabled') await f.query("UPDATE project_agent_classes SET status='paused' WHERE project_id='dependent'");
				if (mode === 'unpinned') await f.query("UPDATE project_agent_classes SET metadata_json='{}' WHERE project_id='dependent'");
				if (mode === 'moved') await f.query('UPDATE project_agent_classes SET metadata_json=? WHERE project_id=?', [JSON.stringify({ source: 'project-library', immutableRef: 'f'.repeat(40), definitionPaths: ['agents/boundary-author.md'] }), 'dependent']);
				const before = await f.snapshot(); await expect(f.ready()).rejects.toThrow(); expect(await f.snapshot()).toEqual(before);
			} finally { await f.close(); }
		}
	}, 60_000);
	it('concurrent and repeated actual native candidate reads preserve exact dependency results original graph and financial history without creating a claim', async () => {
		const f = await relationSchedulingDatabase(); try {
			await f.publish(); const supplied = await f.completeInputs(), before = await f.snapshot();
			const outputs = await Promise.all([f.ready(), f.ready(), f.ready()]);
			for (const output of outputs) {
				expect(output).toEqual(outputs[0]); expect(output).toHaveLength(1);
				expect(output[0]!.predecessorResults.map(value => value.id).sort()).toEqual(supplied.map(value => value.result.id).sort());
			}
			expect(await f.ready()).toEqual(outputs[0]); expect(await f.snapshot()).toEqual(before);
		} finally { await f.close(); }
	}, 60_000);
});
