import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import test from 'node:test';
import pg from 'pg';
import { encryptedEnvelopeSchema } from '@treeseed/sdk/security';
import { createDiagnosticEnvelopeService } from '../../dist/security/diagnostic-envelope.js';
import { assignmentAttemptSchema, assignmentResultSchema, selectFairReadyNode, workdayPolicySchema, calibrateAssignmentSeconds, type AllocationMeasurement } from '@treeseed/sdk/agent-capacity';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { resolveApiDatabaseUrl } from '../../dist/api/configuration/runtime-config.js';
import { verifyDatabaseMigrations } from '../../dist/api/support/verify-database-migrations.js';
import { parse } from 'yaml';
import { createHash } from 'node:crypto';
import { validatePortableContentData } from '@treeseed/sdk/content-validation';
import { executionWorkdayStart, requireNativeAdmissionSamples, verifyNativeInventory } from './execution-inventory.ts';

function installedCli(): string {
	const manifest = createRequire(import.meta.url).resolve('@treeseed/cli/package.json');
	const binary = JSON.parse(readFileSync(manifest, 'utf8')).bin?.trsd;
	assert.ok(typeof binary === 'string' && binary, 'ACCEPTANCE_SCHEMA_CLI: Installed CLI public binary required');
	return resolve(dirname(manifest), binary);
}

async function verifyManagedExecutionSchema(requireObservedSamples: boolean): Promise<void> {
	const started = Date.now(), deadline = started + 120_000;
	const { id } = executionWorkdayStart(), team = process.env.TREESEED_ACCEPTANCE_TEAM;
	const workspace = process.env.TREESEED_DEVELOPMENT_WORKSPACE_ROOT;
	assert.ok(id && /^workday-[a-f0-9-]+$/u.test(id) && team && workspace, 'ACCEPTANCE_SCHEMA_INPUT: Actual workday, team and held workspace required');
	assert.ok(['local', 'staging'].includes(process.env.TREESEED_API_ENVIRONMENT ?? process.env.TREESEED_ENVIRONMENT ?? ''),
		'ACCEPTANCE_SCHEMA_SCOPE: Explicit non-production database environment required');
	assert.ok(process.env.TREESEED_DATABASE_URL?.trim() || process.env.TREESEED_DATABASE_URL_FILE?.trim(),
		'ACCEPTANCE_SCHEMA_DATABASE: Explicit original database binding required; no default discovery');
	const connectionString = resolveApiDatabaseUrl(process.env);
	assert.ok(connectionString, 'ACCEPTANCE_SCHEMA_DATABASE: Original binding resolution failed');
	if (!process.env.TREESEED_DATABASE_URL_FILE?.trim()) assert.ok(['localhost', '127.0.0.1'].includes(new URL(connectionString).hostname),
		'ACCEPTANCE_SCHEMA_SCOPE: Explicit URL must select local PostgreSQL; managed files retain original validation');
	const cli = installedCli(), cliBytes = readFileSync(cli);
	const root = resolve('drizzle/control-plane');
	const sources = readdirSync(root).filter(name => name.endsWith('.sql')).sort().map(name => ({ name, bytes: readFileSync(resolve(root, name)) }));
	assert.ok(sources.length > 0, 'ACCEPTANCE_SCHEMA_SOURCE: Complete owning migration inventory required');
	const object = (value: unknown): Record<string, unknown> => {
		assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'ACCEPTANCE_SCHEMA_RECORD: Complete object required');
		return Object.fromEntries(Object.entries(value));
	};
	const read = (args: string[]) => {
		const remaining = deadline - Date.now(); assert.ok(remaining > 0, 'ACCEPTANCE_SCHEMA_DEADLINE: Original bound elapsed');
		const native = spawnSync(process.execPath, [cli, ...args, '--server', 'local', '--team', team, '--json'], {
			encoding: 'utf8', timeout: remaining, maxBuffer: 32 * 1024 * 1024,
		});
		assert.ok(!native.error && native.signal === null && native.status === 0, 'ACCEPTANCE_SCHEMA_CLI: Supported exact command failed; raw credential-bearing output is not exposed');
		const envelope = object(JSON.parse(native.stdout)); assert.equal(envelope.ok, true, 'ACCEPTANCE_SCHEMA_CLI: Failed response');
		return object(envelope.result);
	};
	const workday = read(['workdays', 'show', id]), run = object(workday.run);
	assert.equal(run.id, id); assert.equal(run.status, 'completed'); assert.equal(typeof run.teamId, 'string');
	const lifecycle = { runnerId: 'original-runner', leaseToken: 'isolated-validation-input' };
	const measured = { assignmentAttempt: 1, usageDimension: 'aggregate', activeSeconds: 2, elapsedSeconds: 3 };
	for (const [operation, original] of [
		[CONTROL_PLANE_OPERATIONS.providers.renewAssignment, lifecycle], [CONTROL_PLANE_OPERATIONS.providers.returnAssignment, lifecycle],
		[CONTROL_PLANE_OPERATIONS.providers.completeAssignment, lifecycle], [CONTROL_PLANE_OPERATIONS.providers.failAssignment, lifecycle],
		[CONTROL_PLANE_OPERATIONS.providers.reportUsage, measured], [CONTROL_PLANE_OPERATIONS.providers.settleAssignment, measured],
	] as const) {
		assert.equal(operation.schema.body.safeParse(original).success, true, 'ACCEPTANCE_SCHEMA_CURRENT_REQUEST: Current published provider input must remain valid');
		for (const modeRunId of [undefined, null, '', 'retired-run', false, 0, {}, []]) {
			const body = Object.assign({}, original, { modeRunId }), before = structuredClone(body);
			assert.equal(operation.schema.body.safeParse(body).success, false, 'ACCEPTANCE_SCHEMA_RETIRED_REQUEST: Bound SDK permits a caller-owned retired identity before serialization');
			assert.equal(Object.hasOwn(body, 'modeRunId'), true); assert.deepEqual(body, before);
		}
	}
	const remaining = deadline - Date.now(); assert.ok(remaining > 0, 'ACCEPTANCE_SCHEMA_DEADLINE: Original bound elapsed');
	const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: remaining, query_timeout: remaining });
	let held: Record<string, unknown> | undefined;
	try {
		const client = await pool.connect();
		try {
			await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
			try {
				assert.deepEqual((await client.query('SHOW transaction_read_only')).rows, [{ transaction_read_only: 'on' }]);
				await verifyDatabaseMigrations(client, root);
				const catalog = async () => (await client.query<{ table_name: string; column_name: string }>(
					"SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,column_name")).rows;
				const before = await catalog();
				for (const table of ['agent_capacity_plans', 'capacity_workday_demands', 'capacity_workday_participation_cycles',
					'capacity_workday_participation_entries', 'agent_mode_runs', 'workday_capacity_envelopes', 'decision_assignment_graphs', 'capacity_allocation_sets']) {
					assert.ok(!before.some(value => value.table_name === table), 'ACCEPTANCE_SCHEMA_RETIRED_TABLE: Retired scheduling authority remains');
					assert.deepEqual((await client.query('SELECT to_regclass($1) AS name', [`public.${table}`])).rows, [{ name: null }]);
				}
				const retired = [
					['capacity_provider_assignments', 'decision_input_json'], ['capacity_provider_assignments', 'allocation_set_id'],
					...['allowed_modes_json', 'required_capabilities_json', 'kernel_profile_json', 'kernel_policy_json', 'output_contracts_json'].map(name => ['project_agent_classes', name]),
					...['capacity_usage_actuals', 'capacity_ledger_entries', 'capacity_workday_events'].map(name => [name, 'mode_run_id']),
					...['allocation_set_id', 'allocation_version', 'allocation_slice_ids_json'].map(name => ['capacity_reservations', name]),
				];
				for (const [table, column] of retired) assert.ok(!before.some(value => value.table_name === table && value.column_name === column),
					'ACCEPTANCE_SCHEMA_RETIRED_COLUMN: Retired assignment authority remains');
				for (const table of ['execution_nodes', 'execution_edges', 'execution_graph_revisions', 'capacity_provider_assignments',
					'capacity_reservations', 'capacity_usage_actuals', 'capacity_ledger_entries']) assert.ok(before.some(value => value.table_name === table),
					'ACCEPTANCE_SCHEMA_CURRENT_TABLE: Required owning execution storage is absent');
				const ledger = (await client.query<{ name: string }>('SELECT * FROM treeseed_control_plane_schema_migrations ORDER BY name')).rows;
				assert.deepEqual(ledger.map(value => value.name), sources.map(value => value.name));
				const nativeRun = (await client.query('SELECT * FROM capacity_workday_runs WHERE id=$1', [id])).rows;
				assert.equal(nativeRun.length, 1); assert.equal(nativeRun[0].team_id, run.teamId); assert.equal(nativeRun[0].status, run.status);
				const assignments = (await client.query('SELECT * FROM capacity_provider_assignments WHERE work_day_id=$1 ORDER BY id', [id])).rows;
				assert.ok(assignments.length > 0, 'ACCEPTANCE_SCHEMA_EMPTY: Actual managed assignment inventory required');
				const inventoryReads: Array<{ args: string[]; cursor?: string; returned: Record<string, unknown> }> = [];
				const nativeInventories: Array<{ sql: string; parameters: unknown[]; rows: unknown[] }> = [];
				const nativeInventory = async (sql: string, parameters: unknown[]) => {
					const rows = (await client.query(sql, parameters)).rows; nativeInventories.push({ sql, parameters, rows }); return rows;
				};
				const inventory = (native: unknown, args: string[], direction: 'ascending' | 'descending' = 'descending') => verifyNativeInventory(native, cursor => {
					const returned = read([...args, '--limit', '200', ...(cursor ? ['--cursor', cursor] : [])]);
					inventoryReads.push({ args, cursor, returned }); return returned;
				}, 200, direction);
				const publicAssignments = await inventory(assignments, ['assignments', 'list', '--workday', id]);
				const nativeEvents = await nativeInventory('SELECT * FROM capacity_workday_events WHERE run_id=$1 AND team_id=$2 ORDER BY id', [id, run.teamId]);
				assert.ok(nativeEvents.length > 0, 'ACCEPTANCE_NATIVE_INVENTORY: Actual transition history required');
				const publicEvents = await inventory(nativeEvents, ['workdays', 'events', 'list', id], 'ascending');
				for (const visible of publicEvents) {
					const native = nativeEvents.find(value => value.id === visible.id); assert.ok(native);
					for (const [key, column] of [['runId','run_id'], ['teamId','team_id'], ['assignmentId','assignment_id'], ['eventIndex','event_index'],
						['eventType','event_type'], ['status','status']] as const) assert.equal(visible[key], native[column]);
				}
				for (const project of new Set(assignments.map(value => String(value.project_id)))) {
					for (const [table, command] of [['capacity_usage_actuals','usage'], ['capacity_ledger_entries','ledger']] as const) {
						const native = await nativeInventory(`SELECT * FROM ${table} WHERE work_day_id=$1 AND project_id=$2 ORDER BY id`, [id, project]);
						const visible = await inventory(native, ['capacity', command, '--project', project, '--workday', id]);
						for (const value of visible) {
							const stored = native.find(record => record.id === value.id); assert.ok(stored);
							assert.equal(value.assignmentId, stored.assignment_id); assert.equal(value.workDayId, id);
							assert.equal(value.activeSeconds, stored.active_seconds); assert.equal(value.elapsedSeconds, stored.elapsed_seconds);
							if (command === 'usage') assert.deepEqual(value.nativeUsage, JSON.parse(stored.native_usage_json));
							else if (stored.phase === 'task_completed_actual_settlement') assert.deepEqual(value.usageSettlement, JSON.parse(stored.metadata_json).usageSettlement);
						}
					}
				}
				const membershipSql = `SELECT id,team_id,capacity_provider_id FROM capacity_provider_team_memberships membership
					WHERE EXISTS (SELECT 1 FROM capacity_provider_assignments assignment WHERE assignment.work_day_id=$1
						AND assignment.membership_id=membership.id) ORDER BY id`;
				const memberships = (await client.query<{ id: string; team_id: string; capacity_provider_id: string }>(membershipSql, [id])).rows;
				assert.equal(memberships.length, new Set(assignments.map(value => value.membership_id)).size,
					'ACCEPTANCE_PROVIDER_MEMBERSHIP: Every actual assignment needs its independently stored provider membership');
				const byMembership = new Map(memberships.map(value => [value.id, value]));
				const observations: Array<{ id: string; value: Record<string, unknown> }> = [];
				const prioritySources = new Map<string, { args: string[]; returned: Record<string, unknown> }>(); let prioritizedWork = 0, calibratedWork = 0;
				const calibrationHistory = new Map<string, { sql: string; parameters: unknown[]; rows: unknown[] }>();
				for (const value of assignments) {
					assert.equal(value.team_id, run.teamId); assert.equal(typeof value.id, 'string');
					assert.deepEqual(byMembership.get(value.membership_id), { id: value.membership_id, team_id: value.team_id,
						capacity_provider_id: value.capacity_provider_id }, 'ACCEPTANCE_PROVIDER_MEMBERSHIP: Assignment team and provider must match its owning membership');
					const visible = read(['assignments', 'show', value.id]);
					assert.deepEqual(publicAssignments.find(record => record.id === value.id), visible);
					assert.equal(visible.id, value.id); assert.equal(visible.workDayId, id); assert.equal(visible.teamId, run.teamId); assert.equal(visible.status, value.status);
					assert.equal(visible.membershipId, value.membership_id); assert.equal(visible.capacityProviderId, value.capacity_provider_id);
					assert.equal(Object.hasOwn(visible, 'modeRunId'), false, 'ACCEPTANCE_SCHEMA_RETIRED_IDENTITY: Public assignment retains a retired mode-run alias');
					const nativeAttempt: unknown = JSON.parse(value.assignment_attempt_json);
					const attempt = assignmentAttemptSchema.parse(nativeAttempt);
					assert.deepEqual(nativeAttempt, attempt, 'ACCEPTANCE_SCHEMA_ATTEMPT: Native bytes contain stripped or coerced canonical fields');
					assert.equal(attempt.id, value.id); assert.equal(attempt.teamId, run.teamId); assert.equal(attempt.workdayId, id);
					assert.deepEqual(visible.assignmentAttempt, attempt);
					if (value.execution_kind === 'workday') {
						const allocation = object(object(object(visible.explanation).metadata).allocation), selection = object(allocation.selection), inputs = object(selection.input);
						assert.equal(allocation.admitted, true, 'ACCEPTANCE_QUOTA_ADMISSION: Retained admission must be positive even when the later attempt failed');
						assert.equal(allocation.allocatedSeconds, attempt.limits.maximumSeconds);
						// Independently resolve the actual immutable measurements, not
						// trust only IDs or reconstruct today's provider supply/limits.
						const historySql = `SELECT usage.id,usage.created_at,usage.active_seconds,
							assignment.status,assignment.lifecycle_code,assignment.assignment_attempt_json,
							assignment.assignment_result_json FROM capacity_usage_actuals usage
							JOIN capacity_provider_assignments assignment ON assignment.id=usage.assignment_id
							JOIN execution_nodes node ON node.team_id=assignment.team_id AND node.id=assignment.execution_node_id
							WHERE assignment.capacity_provider_id=$1 AND assignment.execution_provider_id=$2 AND node.agent_class=$3
							AND usage.accounting_mode='aggregate' AND usage.created_at<$4
							AND assignment.assignment_attempt_json::jsonb->'provider'->>'modelConfigurationId'=$5
							AND assignment.assignment_attempt_json::jsonb->'provider'->>'executionCapabilityId'=$6
							AND assignment.assignment_attempt_json::jsonb->'effectiveProfile'->>'activity'=$7
							AND ((assignment.status='failed' AND assignment.lifecycle_code='assignment_timeout')
							OR (assignment.status='completed' AND (node.pair_role IS DISTINCT FROM 'actor' OR EXISTS (
								SELECT 1 FROM capacity_provider_assignments review JOIN execution_edges pair ON pair.team_id=review.team_id
								AND pair.from_node_id=assignment.execution_node_id AND pair.to_node_id=review.execution_node_id AND pair.provenance='review-pair'
								WHERE review.team_id=assignment.team_id AND review.status='completed' AND review.assignment_result_json IS NOT NULL
								AND review.lifecycle_output_json::jsonb #>> '{activityCompletion,reviewDisposition}'='approved'
								AND review.assignment_result_json::jsonb->>'completedAt'<$4
								AND review.assignment_attempt_json::jsonb->'predecessorResultIds' @> jsonb_build_array(assignment.assignment_result_json::jsonb->>'id')))))
							ORDER BY usage.created_at DESC,usage.id DESC`;
						const historyParameters = [attempt.provider.providerId, attempt.provider.executionProviderId,
							attempt.agentClass, attempt.createdAt, attempt.provider.modelConfigurationId, attempt.provider.executionCapabilityId, attempt.effectiveProfile.activity];
						const history = (await client.query(historySql, historyParameters)).rows;
						calibrationHistory.set(attempt.id, { sql: historySql, parameters: historyParameters, rows: history });
						const measurements: AllocationMeasurement[] = history.map(value => {
							const prior = assignmentAttemptSchema.parse(JSON.parse(String(value.assignment_attempt_json)));
							assert.equal(prior.provider.providerId, attempt.provider.providerId); assert.equal(prior.provider.executionProviderId, attempt.provider.executionProviderId);
							assert.equal(prior.provider.modelConfigurationId, attempt.provider.modelConfigurationId); assert.equal(prior.provider.executionCapabilityId, attempt.provider.executionCapabilityId);
							assert.equal(prior.agentClass, attempt.agentClass); assert.equal(prior.effectiveProfile.activity, attempt.effectiveProfile.activity);
							assert.ok(typeof value.id === 'string' && value.id && typeof value.created_at === 'string' && Number.isFinite(Date.parse(value.created_at)));
							assert.ok(typeof value.active_seconds === 'number' && Number.isFinite(value.active_seconds) && value.active_seconds >= 0);
							const priorResult = assignmentResultSchema.parse(JSON.parse(String(value.assignment_result_json)));
							assert.equal(priorResult.assignmentId, prior.id); assert.ok(Date.parse(priorResult.completedAt) < Date.parse(attempt.createdAt));
							return { id: value.id, completedAt: value.created_at, expectedSeconds: prior.estimate.expectedSeconds,
								allocatedSeconds: prior.limits.maximumSeconds, activeSeconds: value.active_seconds,
								outcome: value.status === 'failed' ? 'expired' : 'completed' };
						});
						assert.equal(new Set(measurements.map(value => value.id)).size, measurements.length);
						const calibration = calibrateAssignmentSeconds(attempt.estimate, measurements);
						assert.deepEqual(allocation.calibration, calibration, 'ACCEPTANCE_CALIBRATION_HISTORY: Stored allocation does not replay complete original eligible measurement values and latest-twenty order');
						assert.equal(allocation.desiredSeconds, calibration.seconds); if (measurements.length) calibratedWork++;
						assert.ok(Array.isArray(allocation.constraints) && allocation.constraints.length > 0,
							'ACCEPTANCE_QUOTA_ADMISSION: Original allocator constraints are required, not a current quota reconstruction');
						const constraints = allocation.constraints.map(object);
						assert.equal(new Set(constraints.map(constraint => constraint.id)).size, constraints.length);
						for (const constraint of constraints) assert.ok(typeof constraint.id === 'string' && constraint.id
							&& typeof constraint.remainingSeconds === 'number' && Number.isFinite(constraint.remainingSeconds)
							&& constraint.remainingSeconds >= attempt.limits.maximumSeconds,
							'ACCEPTANCE_QUOTA_ADMISSION: A zero, exhausted, coerced or smaller hard limit authorized productive execution');
						for (const name of ['model-day', 'capability-day', 'execution-window', 'workday-phase-share'])
							assert.equal(constraints.filter(constraint => constraint.id === name).length, 1,
								'ACCEPTANCE_QUOTA_ADMISSION: Complete original model, capability, time and fair-share bounds required');
						assert.ok(Array.isArray(inputs.nodes) && inputs.nodes.length > 0 && Array.isArray(inputs.usage),
							'ACCEPTANCE_SELECTION_INPUT: Native winning admission must retain its complete original selector inputs');
						const nodes = inputs.nodes.map(value => {
							const node = object(value);
							assert.ok(typeof node.id === 'string' && node.id && typeof node.projectId === 'string' && node.projectId
								&& typeof node.agentClass === 'string' && node.agentClass && typeof node.readyAt === 'string' && Number.isFinite(Date.parse(node.readyAt)));
							assert.ok(!Object.hasOwn(node, 'priority') || typeof node.priority === 'number' && Number.isSafeInteger(node.priority),
								'ACCEPTANCE_NODE_PRIORITY: Only the canonical integer priority can be used; no string coercion or provider priority');
							return { id: node.id, projectId: node.projectId, agentClass: node.agentClass, readyAt: node.readyAt,
								...(typeof node.priority === 'number' ? { priority: node.priority } : {}) };
						});
						assert.equal(new Set(nodes.map(node => node.id)).size, nodes.length, 'ACCEPTANCE_SELECTION_INPUT: Duplicate eligible node');
						const usage = inputs.usage.map(value => {
							const row = object(value); assert.ok(typeof row.projectId === 'string' && row.projectId && typeof row.agentClass === 'string' && row.agentClass
								&& typeof row.seconds === 'number' && Number.isFinite(row.seconds) && row.seconds >= 0);
							return { projectId: row.projectId, agentClass: row.agentClass, seconds: row.seconds };
						});
						const policy = workdayPolicySchema.parse(object(object(object(run.parameters).appliedPlan).policySnapshot));
						assert.deepEqual(selectFairReadyNode(nodes, usage, policy), selection, 'ACCEPTANCE_SELECTION_REPLAY: Native admission does not reproduce its exact project/class/priority/readiness choice');
						assert.equal(selection.id, attempt.nodeId);
						assert.ok(nodes.some(node => node.id === attempt.nodeId && node.projectId === attempt.projectId && node.agentClass === attempt.agentClass));
						if (attempt.workItemId && attempt.sourceRef.model === 'proposal') {
							const source = attempt.sourceRef;
							assert.ok(source.store === 'treedx' && source.repository && source.commit && source.path && source.digest,
								'ACCEPTANCE_PRIORITY_SOURCE: Exact governed Proposal authority required');
							const key = JSON.stringify([attempt.projectId, source.repository, source.commit, source.path]);
							let observation = prioritySources.get(key);
							if (!observation) {
								const args = ['library', 'read', attempt.projectId, source.path, '--ref', source.commit];
								observation = { args, returned: read(args) }; prioritySources.set(key, observation);
							}
							const returned = object(observation.returned.result ?? observation.returned);
							assert.equal(returned.resolvedRef, source.commit); assert.ok(Array.isArray(returned.files) && returned.files.length === 1);
							const file = object(returned.files[0]); assert.equal(file.path, source.path); assert.equal(typeof file.content, 'string');
							assert.equal(`sha256:${createHash('sha256').update(String(file.content)).digest('hex')}`, source.digest);
							const document = String(file.content).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u); assert.ok(document);
							const frontmatter = object(parse(document[1]!)); assert.deepEqual(file.frontmatter, frontmatter); assert.equal(frontmatter.id, source.id);
							const checked = validatePortableContentData('proposal', frontmatter); assert.ok(checked.ok);
							const work = object(object(checked.data).executionPlan).workItems; assert.ok(Array.isArray(work));
							const matches = work.map(object).filter(item => item.id === attempt.workItemId); assert.equal(matches.length, 1);
							const selected = nodes.find(node => node.id === attempt.nodeId); assert.ok(selected);
							assert.equal(Object.hasOwn(selected, 'priority'), Object.hasOwn(matches[0]!, 'priority'),
								'ACCEPTANCE_PRIORITY_SOURCE: Projection invented or discarded the governed priority');
							if (Object.hasOwn(matches[0]!, 'priority')) {
								const priority = matches[0]!.priority; assert.ok(typeof priority === 'number' && Number.isSafeInteger(priority));
								assert.equal(selected.priority, priority); if (priority !== 0) prioritizedWork++;
							}
						}
						// Replay uses the stored owning input, never today's changed ready
						// graph or a reconstructed terminal eligible inventory. The real
						// producer integration separately proves hard-gate completeness.
					}
					if (value.assignment_result_json !== null) {
						const nativeResult: unknown = JSON.parse(value.assignment_result_json);
						const result = assignmentResultSchema.parse(nativeResult);
						assert.deepEqual(nativeResult, result, 'ACCEPTANCE_SCHEMA_RESULT: Native bytes contain stripped or coerced canonical fields');
						assert.equal(result.assignmentId, value.id); assert.deepEqual(visible.assignmentResult, result);
					} else assert.ok(visible.assignmentResult === null || visible.assignmentResult === undefined);
					observations.push({ id: value.id, value: visible });
				}
				requireNativeAdmissionSamples(prioritizedWork, calibratedWork, requireObservedSamples);
				for (const observation of calibrationHistory.values()) assert.deepEqual(
					(await client.query(observation.sql, observation.parameters)).rows, observation.rows);
				for (const observation of prioritySources.values()) assert.deepEqual(read(observation.args), observation.returned);
				for (const observation of observations) assert.deepEqual(read(['assignments', 'show', observation.id]), observation.value);
				for (const { args, cursor, returned } of inventoryReads) assert.deepEqual(read([...args, '--limit', '200', ...(cursor ? ['--cursor', cursor] : [])]), returned);
				for (const name of ['agent-author', 'capacity-plan-create', 'checkpoint-integrate', 'content-integrate', 'content-abandon']) {
					const remaining = deadline - Date.now(); assert.ok(remaining > 0, 'ACCEPTANCE_SCHEMA_DEADLINE: Original bound elapsed');
					// Plan-only even on regression: this scene does not authorize an obsolete mutation against a managed database.
					const native = spawnSync(process.execPath, [cli, name, '--plan', '--server', 'local', '--team', team, '--json'], {
						encoding: 'utf8', timeout: remaining, maxBuffer: 32 * 1024 * 1024,
					});
					assert.ok(!native.error && native.signal === null && native.status === 1 && native.stdout === '', 'ACCEPTANCE_SCHEMA_RETIRED_COMMAND: Removed command must fail before execution');
					const envelope = object(JSON.parse(native.stderr)); assert.equal(envelope.ok, false); assert.equal(envelope.result, null);
					assert.equal(object(envelope.error).code, 'unknown_command'); assert.equal(object(envelope.error).category, 'unknown_command');
					assert.deepEqual(envelope.warnings, []);
				}
				assert.deepEqual(read(['workdays', 'show', id]), workday);
				assert.deepEqual(await catalog(), before);
				assert.deepEqual((await client.query('SELECT * FROM capacity_provider_assignments WHERE work_day_id=$1 ORDER BY id', [id])).rows, assignments);
				assert.deepEqual((await client.query('SELECT * FROM capacity_workday_runs WHERE id=$1', [id])).rows, nativeRun);
				assert.deepEqual((await client.query('SELECT * FROM treeseed_control_plane_schema_migrations ORDER BY name')).rows, ledger);
				assert.deepEqual((await client.query(membershipSql, [id])).rows, memberships);
				held = { catalog: before, assignments, run: nativeRun, ledger, memberships, membershipSql, nativeInventories };
			} finally { await client.query('ROLLBACK'); }
		} finally { client.release(); }
		assert.ok(held);
		const fresh = await pool.connect();
		try {
			await fresh.query('BEGIN TRANSACTION READ ONLY');
			try {
				assert.deepEqual((await fresh.query('SHOW transaction_read_only')).rows, [{ transaction_read_only: 'on' }]);
				await verifyDatabaseMigrations(fresh, root);
				assert.deepEqual((await fresh.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,column_name")).rows, held.catalog);
				assert.deepEqual((await fresh.query('SELECT * FROM capacity_provider_assignments WHERE work_day_id=$1 ORDER BY id', [id])).rows, held.assignments);
				assert.deepEqual((await fresh.query('SELECT * FROM capacity_workday_runs WHERE id=$1', [id])).rows, held.run);
				for (const inventory of held.nativeInventories as Array<{ sql: string; parameters: unknown[]; rows: unknown[] }>)
					assert.deepEqual((await fresh.query(inventory.sql, inventory.parameters)).rows, inventory.rows);
				assert.equal(typeof held.membershipSql, 'string');
				assert.deepEqual((await fresh.query(String(held.membershipSql), [id])).rows, held.memberships);
				assert.deepEqual((await fresh.query('SELECT * FROM treeseed_control_plane_schema_migrations ORDER BY name')).rows, held.ledger);
			} finally { await fresh.query('ROLLBACK'); }
		} finally { fresh.release(); }
	} finally { await pool.end(); }
	assert.deepEqual(readFileSync(cli), cliBytes);
	assert.deepEqual(readdirSync(root).filter(name => name.endsWith('.sql')).sort(), sources.map(value => value.name));
	for (const source of sources) assert.deepEqual(readFileSync(resolve(root, source.name)), source.bytes);
	assert.ok(Date.now() <= deadline, 'ACCEPTANCE_SCHEMA_DEADLINE: Original observation bound elapsed');
}
test('Actual managed execution uses the complete clean migration inventory and exact canonical assignment rows without retired scheduling authorities or read-time repair',
	{ timeout: 120_000 }, () => verifyManagedExecutionSchema(true));
test('Actual normal SDK workday retains complete clean migration and canonical public native inventories with genuine cold start and default zero priority allowed',
	{ timeout: 120_000 }, () => verifyManagedExecutionSchema(false));

async function verifyManagedModelExecution(requireUnfinished: boolean): Promise<void> {
	const deadline = Date.now() + 120_000, { id } = executionWorkdayStart();
	const team = process.env.TREESEED_ACCEPTANCE_TEAM, workspace = process.env.TREESEED_DEVELOPMENT_WORKSPACE_ROOT;
	assert.ok(id && /^workday-[a-f0-9-]+$/u.test(id) && team && workspace, 'ACCEPTANCE_DIAGNOSTICS_INPUT: Exact actual workday team and workspace required');
	assert.ok(['local', 'staging'].includes(process.env.TREESEED_API_ENVIRONMENT ?? process.env.TREESEED_ENVIRONMENT ?? ''), 'ACCEPTANCE_DIAGNOSTICS_SCOPE: Explicit non-production environment required');
	assert.ok(process.env.TREESEED_DATABASE_URL?.trim() || process.env.TREESEED_DATABASE_URL_FILE?.trim(), 'ACCEPTANCE_DIAGNOSTICS_DATABASE: Explicit original binding required');
	const connectionString = resolveApiDatabaseUrl(process.env); assert.ok(connectionString);
	if (!process.env.TREESEED_DATABASE_URL_FILE?.trim()) assert.ok(['localhost', '127.0.0.1'].includes(new URL(connectionString).hostname));
	const cli = installedCli(), bytes = readFileSync(cli);
	const object = (value: unknown): Record<string, unknown> => {
		assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'ACCEPTANCE_DIAGNOSTICS_OBJECT: Exact readable object required');
		return Object.fromEntries(Object.entries(value));
	};
	const read = (args: string[]) => {
		const remaining = deadline - Date.now(); assert.ok(remaining > 0);
		const native = spawnSync(process.execPath, [cli, ...args, '--server', 'local', '--team', team, '--json'], { encoding: 'utf8', timeout: remaining, maxBuffer: 32 * 1024 * 1024 });
		assert.ok(!native.error && native.signal === null && native.status === 0, 'ACCEPTANCE_DIAGNOSTICS_CLI: Original public read failed; private output withheld');
		const envelope = object(JSON.parse(native.stdout)); assert.equal(envelope.ok, true); return object(envelope.result);
	};
	const workday = read(['workdays', 'show', id]), run = object(workday.run); assert.equal(run.id, id); assert.equal(run.status, 'completed');
	const envelopes = createDiagnosticEnvelopeService(), remaining = deadline - Date.now(); assert.ok(remaining > 0);
	const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: remaining, query_timeout: remaining });
	try {
		const client = await pool.connect();
		try {
			await client.query('BEGIN TRANSACTION READ ONLY');
			try {
				assert.deepEqual((await client.query('SHOW transaction_read_only')).rows, [{ transaction_read_only: 'on' }]);
				const assignments = (await client.query('SELECT * FROM capacity_provider_assignments WHERE work_day_id=$1 ORDER BY id', [id])).rows;
				const events = (await client.query('SELECT * FROM capacity_workday_events WHERE run_id=$1 ORDER BY event_index,id', [id])).rows;
				assert.ok(assignments.length > 0 && events.length > 0, 'ACCEPTANCE_DIAGNOSTICS_EMPTY: Actual native inventory required');
				const activities = new Set<string>(), verifiedActivities = new Set<string>(), publicReads: Array<{ id: string; value: Record<string, unknown> }> = [];
				const contentReads: Array<{ args: string[]; value: Record<string, unknown> }> = []; let unfinishedDrafts = 0;
				const exactContent = (args: string[], commit: string, path: string) => {
					const value = read(args); assert.equal(value.resolvedRef, commit); assert.ok(Array.isArray(value.files) && value.files.length === 1);
					const file = object(value.files[0]); assert.equal(file.path, path); assert.equal(typeof file.content, 'string');
					const raw = String(file.content).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u); assert.ok(raw && raw[2]!.trim());
					const frontmatter = object(parse(raw[1]!)); assert.ok(isDeepStrictEqual(file.frontmatter, frontmatter));
					assert.ok(validatePortableContentData('proposal', frontmatter).ok); contentReads.push({ args, value }); return { frontmatter, content: String(file.content) };
				};
				for (const native of assignments) {
					assert.equal(native.team_id, run.teamId); const visible = read(['assignments', 'show', String(native.id)]);
					assert.equal(visible.id, native.id); assert.equal(visible.teamId, run.teamId); assert.equal(visible.workDayId, id);
					publicReads.push({ id: String(native.id), value: visible });
					const output = object(visible.lifecycleOutput); if (typeof output.sandboxId !== 'string' || !output.sandboxId) continue;
					const attempt = assignmentAttemptSchema.parse(visible.assignmentAttempt); assert.equal(attempt.id, native.id);
					const candidates = events.filter(event => event.assignment_id === attempt.id
						&& ['provider.execution.completed', 'provider.execution.failed'].includes(event.event_type)
						&& object(JSON.parse(String(event.metadata_json))).protectedPayloadEnvelope !== undefined);
					assert.equal(candidates.length, 1, 'ACCEPTANCE_DIAGNOSTICS_CUSTODY: One owning original protected executor observation required');
					const event = candidates[0]!, metadata = object(JSON.parse(String(event.metadata_json)));
					const envelope = encryptedEnvelopeSchema.parse(metadata.protectedPayloadEnvelope);
					assert.ok(envelope.aad.purpose === 'diagnostics' && envelope.aad.teamId === attempt.teamId && envelope.aad.assignmentId === attempt.id
						&& envelope.aad.resourceId === event.id && envelope.aad.eventType === event.event_type && Number.isInteger(envelope.aad.sequence),
						'ACCEPTANCE_DIAGNOSTICS_CORRELATION: Ciphertext must authenticate the exact native owning event');
					const protectedPayload = envelopes.decrypt(envelope);
					assert.ok(Array.isArray(protectedPayload.providerEvents) && protectedPayload.providerEvents.length > 0, 'ACCEPTANCE_DIAGNOSTICS_ACTIONS: Original provider actions required, not timing flags');
					const actions = protectedPayload.providerEvents.map(object).filter(value => value.type === 'item.completed').map(value => object(value.item))
						.filter(value => ['mcp_tool_call', 'command_execution'].includes(String(value.type)));
					assert.ok(actions.length >= 2, 'ACCEPTANCE_DIAGNOSTICS_BOUNDARIES: Actual first and final actions required');
					const time = object(object(object(visible.capacityEnvelope).budget).time);
					assert.ok(typeof time.executionStartedAt === 'string' && typeof time.executionDeadlineAt === 'string');
					const duration = (Date.parse(time.executionDeadlineAt) - Date.parse(time.executionStartedAt)) / 1000;
					assert.ok(Number.isFinite(duration) && duration > 0 && duration <= attempt.limits.maximumSeconds);
					const seen = new Set<string>(); let previous = Infinity, previousWasClock = false, firstRemaining: number | undefined;
					for (const [index, action] of actions.entries()) {
						const clock = action.type === 'mcp_tool_call' && action.server === 'treedx' && action.tool === 'treeseed_time_status';
						if (index === 0 || index === actions.length - 1) assert.ok(clock, 'ACCEPTANCE_DIAGNOSTICS_BOUNDARIES: First and final native tool actions must query the original API clock');
						if (action.type === 'command_execution') assert.ok(previousWasClock, 'ACCEPTANCE_DIAGNOSTICS_RECHECK: A blocking command requires a fresh preceding clock query');
						if (clock) {
							assert.ok(action.status === 'completed' && action.error === null && typeof action.id === 'string' && !seen.has(action.id)); seen.add(action.id);
							const result = object(action.result), structured = object(result.structuredContent);
							assert.ok(result.isError !== true && Array.isArray(result.content) && result.content.length === 1);
							const text = object(result.content[0]); assert.ok(text.type === 'text' && typeof text.text === 'string');
							assert.ok(isDeepStrictEqual(JSON.parse(text.text), structured), 'ACCEPTANCE_DIAGNOSTICS_CLOCK: Raw and structured API observations disagree');
							assert.ok(structured.startedAt === time.executionStartedAt && structured.deadlineAt === time.executionDeadlineAt);
							assert.ok(typeof structured.remainingSeconds === 'number' && Number.isInteger(structured.remainingSeconds) && structured.remainingSeconds >= 0
								&& structured.remainingSeconds <= duration && structured.remainingSeconds <= previous); previous = structured.remainingSeconds;
							firstRemaining ??= structured.remainingSeconds;
							if (index === actions.length - 1) assert.ok(previous > 0, 'ACCEPTANCE_DIAGNOSTICS_EXPIRED: Final response cannot refresh an expired productive window');
						}
						previousWasClock = clock;
					}
					if (visible.status === 'completed') {
						const result = assignmentResultSchema.parse(visible.assignmentResult);
						assert.equal(result.assignmentId, attempt.id); assert.equal(result.status, 'completed');
						const completed = Date.parse(result.completedAt), start = Date.parse(time.executionStartedAt), end = Date.parse(time.executionDeadlineAt);
						assert.ok(Number.isFinite(completed) && completed >= start && completed <= end,
							'ACCEPTANCE_DIAGNOSTICS_CLOSEOUT: Model, mandatory replay and publication must finish inside the SAME original productive window');
						assert.ok(Array.isArray(protectedPayload.verificationRecords), 'ACCEPTANCE_DIAGNOSTICS_REPLAY: Original runner records required, not model-reported success');
						assert.ok(isDeepStrictEqual(protectedPayload.verificationRecords, result.verification),
							'ACCEPTANCE_DIAGNOSTICS_REPLAY: Canonical result changed the owning runner-observed command receipts');
						for (const receipt of result.verification) {
							assert.ok(typeof receipt.durationSeconds === 'number' && Number.isInteger(receipt.durationSeconds) && receipt.durationSeconds >= 0
								&& receipt.durationSeconds <= previous, 'ACCEPTANCE_DIAGNOSTICS_REPLAY_WINDOW: Measured mandatory command exceeded remaining time after the final model action');
							assert.ok(receipt.status === 'passed' ? receipt.exitCode === 0 : receipt.status === 'failed' && receipt.exitCode === 1,
								'ACCEPTANCE_DIAGNOSTICS_REPLAY_EXIT: Retain actual behavioral RED; never admit skipped or interrupted verification');
						}
						if (result.verification.length > 0) verifiedActivities.add(attempt.effectiveProfile.activity);
						if (requireUnfinished && result.verification.some(value => value.status === 'failed' && value.exitCode === 1)) {
							for (const ref of result.references) {
								if (ref.kind !== 'treedx' || !attempt.grant.contentWrite.some(value => value.model === 'proposal' && value.repository === ref.repository && value.path === ref.path)) continue;
								const draft = exactContent(['library', 'read', attempt.projectId, ref.path, '--ref', ref.commit], ref.commit, ref.path);
								if (draft.frontmatter.status !== 'draft') continue;
								assert.ok(attempt.workspace.mode === 'treedx' && attempt.workspace.repository === ref.repository
									&& attempt.effectiveProfile.permissionCeiling.content.write.includes('proposal'));
								const targets = attempt.grant.contentWrite.filter(value => value.model === 'proposal' && value.repository === ref.repository && value.path === ref.path);
								assert.equal(targets.length, 1); assert.equal(draft.frontmatter.id, targets[0]!.id); assert.equal(draft.frontmatter.projectId, attempt.projectId);
								const sourceRef = attempt.sourceRef; assert.ok(sourceRef.store === 'treedx' && sourceRef.model === 'proposal' && sourceRef.commit && sourceRef.path && sourceRef.digest);
								const original = exactContent(['library', 'read', attempt.projectId, sourceRef.path, '--ref', sourceRef.commit], sourceRef.commit, sourceRef.path);
								assert.equal(`sha256:${createHash('sha256').update(original.content).digest('hex')}`, sourceRef.digest);
								assert.equal(original.frontmatter.id, sourceRef.id); assert.equal(original.frontmatter.projectId, attempt.projectId);
								const work = object(original.frontmatter.executionPlan).workItems, next = object(draft.frontmatter.executionPlan).workItems;
								assert.ok(Array.isArray(work) && Array.isArray(next));
								const pending = work.map(object).filter(value => value.id === attempt.workItemId), retained = next.map(object).filter(value => value.id === attempt.workItemId);
								assert.equal(pending.length, 1); assert.equal(retained.length, 1);
								assert.ok(isDeepStrictEqual(retained[0], pending[0]), 'ACCEPTANCE_UNFINISHED_WORK: Actual draft lost or weakened original unverified criteria authority estimates or priority');
								const maximum = object(pending[0]!.estimate).maximumSeconds;
								assert.ok(typeof maximum === 'number' && typeof firstRemaining === 'number' && firstRemaining < maximum && previous > 0 && previous < firstRemaining,
									'ACCEPTANCE_UNFINISHED_ADAPTATION: Actual original remaining clocks must prove reduced scope before expiry');
								assert.ok(Array.isArray(draft.frontmatter.evidenceRefs) && draft.frontmatter.evidenceRefs.some(value => isDeepStrictEqual(value, sourceRef)));
								// Only the authorized draft scope completed. Its genuine failed
								// command remains failed, and the original work is still proposed.
								unfinishedDrafts++;
								}
						}
						// Native durationSeconds is already rounded by the owning observer.
						// Do not sum rounded commands into guessed actual elapsed seconds,
						// fabricate per-command clocks, or add a tolerance to the deadline.
					}
					activities.add(attempt.effectiveProfile.activity);
					assert.ok(!JSON.stringify(workday).includes('"providerEvents"') && !JSON.stringify(visible).includes('"providerEvents"'), 'ACCEPTANCE_DIAGNOSTICS_PRIVACY: Original private transcript leaked into a public read');
					const context = object(JSON.parse(String(event.context_json))); assert.equal(Object.hasOwn(context, 'providerEvents'), false);
				}
				assert.ok(['chat', 'planning', 'estimating', 'acting', 'reviewing'].every(activity => activities.has(activity)), 'ACCEPTANCE_DIAGNOSTICS_ACTIVITY: All model-backed activity boundaries must be represented by actual execution, not agent-name flags');
				assert.ok(['acting', 'reviewing'].every(activity => verifiedActivities.has(activity)),
					'ACCEPTANCE_DIAGNOSTICS_REPLAY_EMPTY: Actual Actor and independent Reviewer mandatory replay must be represented');
				if (requireUnfinished) assert.ok(unfinishedDrafts > 0, 'ACCEPTANCE_UNFINISHED_EMPTY: An actual before-deadline authorized unfinished-work handoff is required; ordinary successful work cannot substitute');
				for (const observation of contentReads) assert.ok(isDeepStrictEqual(read(observation.args), observation.value));
				for (const value of publicReads) assert.ok(isDeepStrictEqual(read(['assignments', 'show', value.id]), value.value));
				assert.ok(isDeepStrictEqual(read(['workdays', 'show', id]), workday));
				assert.ok(isDeepStrictEqual((await client.query('SELECT * FROM capacity_workday_events WHERE run_id=$1 ORDER BY event_index,id', [id])).rows, events));
				assert.ok(isDeepStrictEqual((await client.query('SELECT * FROM capacity_provider_assignments WHERE work_day_id=$1 ORDER BY id', [id])).rows, assignments));
			} finally { await client.query('ROLLBACK'); }
		} finally { client.release(); }
	} finally { await pool.end(); }
	assert.ok(readFileSync(cli).equals(bytes)); assert.ok(Date.now() <= deadline);
}

test('Actual managed model execution retains encrypted original action observations for every enabled activity and independently binds first final and intervening clocks without public transcript leakage', { timeout: 120_000 }, () => verifyManagedModelExecution(false));
test('Actual original model clocks failed verification and exact governed pending work bind an authorized unfinished draft before the unchanged deadline without a falsely passed replay', { timeout: 120_000 }, () => verifyManagedModelExecution(true));
