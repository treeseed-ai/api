import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { MarketPostgresDatabase } from '../../../src/api/market-postgres.ts';
import { MarketControlPlaneStore } from '../../../src/api/store.ts';
import { createCapacityControlPlane } from '../../../src/api/capacity/control-plane.ts';
import { CapacityAllocationService } from '../../../src/api/capacity/services/allocation-service.ts';
import { CapacityWorkdayEventService } from '../../../src/api/capacity/services/workday-event-service.ts';
import { CapacityWorkdayRunService } from '../../../src/api/capacity/services/workday-run-service.ts';
import { CapacityWorkdayRunRepository } from '../../../src/api/capacity/repositories/workday-run.ts';
import { CapacityWorkdayRunWriteRepository } from '../../../src/api/capacity/repositories/workday-run-write.ts';
import { CapacityRegistrationSecurityRepository } from '../../../src/api/capacity/repositories/registration-security.ts';
import { CapacityProviderIdentityRepository } from '../../../src/api/capacity/repositories/provider-identity.ts';
import { CapacityGovernanceRepository } from '../../../src/api/capacity/repositories/governance.ts';
import { CapacityRegistrationRequestAdmissionRepository } from '../../../src/api/capacity/repositories/registration-request-admission.ts';
import { commitCapacityAdmission } from '../../../src/api/capacity/services/admission-service.ts';
import { settleCapacityReservationExactlyOnce } from '../../../src/api/capacity/services/settlement-service.ts';
import { reportCapacityUsage } from '../../../src/api/capacity/services/usage-report-service.ts';
import type { CapacityAdmissionInput } from '@treeseed/sdk/agent-capacity/allocation';

const { Pool } = pg;
const sourceUrl = process.env.TREESEED_PHASE1_POSTGRES_URL?.trim();
const databaseNames = new Set<string>();

function databaseUrl(name: string): string {
	assert(sourceUrl, 'TREESEED_PHASE1_POSTGRES_URL is required for the real PostgreSQL Phase 1 proof.');
	const url = new URL(sourceUrl);
	url.pathname = `/${name}`;
	return url.toString();
}

function safeDatabaseName(label: string): string {
	return `treeseed_phase1_${label}_${randomUUID().replaceAll('-', '')}`;
}

async function createDatabase(name: string): Promise<void> {
	const admin = new Pool({ connectionString: databaseUrl('postgres') });
	try {
		await admin.query(`CREATE DATABASE "${name}"`);
		databaseNames.add(name);
	} finally {
		await admin.end();
	}
}

async function dropDatabase(name: string): Promise<void> {
	const admin = new Pool({ connectionString: databaseUrl('postgres') });
	try {
		await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [name]);
		await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
		databaseNames.delete(name);
	} finally {
		await admin.end();
	}
}

describe.skipIf(!sourceUrl)('Phase 1 real PostgreSQL proof', () => {
	afterAll(async () => {
		for (const name of [...databaseNames]) await dropDatabase(name);
	});

	it('initializes only the clean baseline and enforces rollback, uniqueness, and concurrent hard caps', async () => {
		const name = safeDatabaseName('baseline');
		await createDatabase(name);
		const database = new MarketPostgresDatabase(databaseUrl(name));
		try {
			await database.migrate();
			const store = createCapacityControlPlane(new MarketControlPlaneStore({ repoRoot: process.cwd() }, database));
			const canonicalTables = await database.pool.query(
				`SELECT table_name FROM information_schema.tables
				 WHERE table_schema = 'public' AND table_name = ANY($1::text[])
				 ORDER BY table_name`,
				[[
					'capacity_providers', 'capacity_provider_team_memberships', 'capacity_provider_availability_sessions',
					'capacity_allocation_sets', 'capacity_reservations', 'capacity_provider_assignments',
					'capacity_usage_actuals', 'capacity_ledger_entries', 'capacity_provider_registration_rate_limits',
					'capacity_provider_credential_issuance_authorizations',
					'capacity_provider_identity_rotations',
				]],
			);
			expect(canonicalTables.rows.map((row) => row.table_name)).toHaveLength(11);

			const legacyTables = await database.pool.query(
				`SELECT table_name FROM information_schema.tables
				 WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
				[['provider_assignments', 'task_usage_actuals', 'capacity_provider_api_keys', 'capacity_provider_live_registrations']],
			);
			expect(legacyTables.rows).toEqual([]);
			const reversibleCredentialColumns = await database.pool.query(
				`SELECT column_name FROM information_schema.columns
				 WHERE table_schema = 'public' AND table_name = 'capacity_provider_team_credentials'
				   AND column_name IN ('encrypted_reveal_value', 'credential', 'secret')`,
			);
			expect(reversibleCredentialColumns.rows).toEqual([]);

			const now = new Date().toISOString();
			await expect(database.batch([
				{ query: 'INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', params: ['rollback-team', 'rollback-team', 'Rollback Team', now, now] },
				{ query: 'INSERT INTO phase1_missing_table (id) VALUES (?)', params: ['failure'] },
			])).rejects.toThrow();
			expect((await database.pool.query(`SELECT id FROM teams WHERE id = 'rollback-team'`)).rows).toEqual([]);

			await database.pool.query(
				`INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)`,
				['team-a', 'team-a', 'Team A', now, now],
			);
			await expect(database.pool.query(
				`INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)`,
				['team-b', 'team-a', 'Team B', now, now],
			)).rejects.toMatchObject({ code: '23505' });

			await database.pool.query(
				`INSERT INTO capacity_admission_counters
				 (id, team_id, scope, scope_id, period_key, hard_limit, committed_amount, state_version, created_at, updated_at)
				 VALUES ($1, $2, $3, $4, $5, 1, 0, 1, $6, $6)`,
				['counter-a', 'team-a', 'team', 'team-a', 'all-time', now],
			);
			const claim = () => database.batch([{
				query: `UPDATE capacity_admission_counters
				 SET committed_amount = committed_amount + 1, state_version = state_version + 1, updated_at = ?
				 WHERE id = ?`,
				params: [new Date().toISOString(), 'counter-a'],
			}]);
			const concurrentClaims = await Promise.allSettled([claim(), claim()]);
			expect(concurrentClaims.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
			expect(concurrentClaims.filter((result) => result.status === 'rejected')).toHaveLength(1);
			expect((await database.pool.query(`SELECT committed_amount, state_version FROM capacity_admission_counters WHERE id = 'counter-a'`)).rows[0])
				.toMatchObject({ committed_amount: 1, state_version: 2 });

			await database.pool.query(`INSERT INTO projects (id, team_id, slug, name, created_at, updated_at) VALUES ('project-a', 'team-a', 'project-a', 'Project A', $1, $1)`, [now]);
			await database.pool.query(`INSERT INTO capacity_providers (id, fingerprint, public_jwk_json, display_name, identity_version, status, metadata_json, created_at, updated_at) VALUES ('provider-a', 'sha256:provider-a', '{}', 'Provider A', 1, 'active', '{}', $1, $1)`, [now]);
			await database.pool.query(`INSERT INTO capacity_provider_team_memberships (id, team_id, capacity_provider_id, status, approved_at, approved_by_id, metadata_json, created_at, updated_at) VALUES ('membership-a', 'team-a', 'provider-a', 'approved', $1, 'owner-a', '{}', $1, $1)`, [now]);
			await database.pool.query(`INSERT INTO capacity_execution_providers (id, capacity_provider_id, display_name, adapter, status, capabilities_json, native_unit, quota_visibility, max_concurrent_runners, native_limits_json, metadata_json, created_at, updated_at) VALUES ('codex', 'provider-a', 'Codex', 'codex', 'active', '["engineering"]', 'assignment', 'exact', 2, '[]', '{}', $1, $1)`, [now]);
			await database.pool.query(`INSERT INTO project_agent_classes (id, team_id, project_id, slug, name, status, allowed_modes_json, required_capabilities_json, kernel_profile_json, kernel_policy_json, handler_refs_json, output_contracts_json, metadata_json, created_at, updated_at) VALUES ('class-a', 'team-a', 'project-a', 'engineer', 'Engineer', 'active', '["planning"]', '["engineering"]', '{}', '{}', '{}', '{}', '{}', $1, $1)`, [now]);
			await database.pool.query(`INSERT INTO capacity_allocation_sets (id, team_id, version, status, effective_from, reserve_policy_json, slices_json, borrowing_rules_json, metadata_json, created_at, updated_at) VALUES ('allocation-a', 'team-a', 1, 'active', $1, '{"percent":0,"overflow":"deny"}', '[{"id":"project:project-a","scope":"project","targetId":"project-a","policy":{"minPercent":0,"targetPercent":100,"maxPercent":100,"hardCapPercent":100}}]', '[]', '{}', $1, $1)`, [now]);
			await database.pool.query(`INSERT INTO capacity_grants (id, membership_id, capacity_provider_id, team_id, project_id, environment, status, execution_provider_ids_json, lane_ids_json, capabilities_json, allowed_modes_json, daily_credit_limit, monthly_credit_limit, max_concurrent_assignments, unmetered, metadata_json, created_at, updated_at) VALUES ('grant-a', 'membership-a', 'provider-a', 'team-a', 'project-a', 'local', 'active', '["codex"]', '[]', '["engineering"]', '["planning"]', 10, 10, 2, 0, '{}', $1, $1)`, [now]);
			await database.pool.query(`INSERT INTO workday_capacity_envelopes (id, team_id, project_id, allocation_set_id, status, started_at, envelope_json, metadata_json, created_at, updated_at) VALUES ('workday-a', 'team-a', 'project-a', 'allocation-a', 'active', $1, '{"totalCredits":10}', '{"grantId":"grant-a"}', $1, $1)`, [now]);
			const admission: CapacityAdmissionInput = {
				now,
				request: { teamId: 'team-a', providerId: 'provider-a', membershipId: 'membership-a', projectId: 'project-a', environment: 'local', agentClassId: 'class-a', mode: 'planning', executionProviderId: 'codex', requiredCapabilities: ['engineering'], requestedCredits: 6 },
				membership: { id: 'membership-a', teamId: 'team-a', providerId: 'provider-a', status: 'approved' },
				availability: { status: 'open', availableFrom: new Date(Date.parse(now) - 1_000).toISOString(), availableUntil: new Date(Date.parse(now) + 60_000).toISOString() },
				grant: { schemaVersion: 2, id: 'grant-a', membershipId: 'membership-a', teamId: 'team-a', providerId: 'provider-a', projectId: 'project-a', environment: 'local', status: 'active', executionProviderIds: ['codex'], laneIds: [], capabilities: ['engineering'], allowedModes: ['planning'], dailyCreditLimit: 10, monthlyCreditLimit: 10, maxConcurrentAssignments: 2 },
				workday: { id: 'workday-a', status: 'active', totalCredits: 10, committedCredits: 0 },
				allocationSet: { schemaVersion: 2, id: 'allocation-a', teamId: 'team-a', version: 1, status: 'active', effectiveFrom: now, reservePolicy: { percent: 0, overflow: 'deny' }, slices: [{ id: 'project:project-a', scope: 'project', targetId: 'project-a', policy: { minPercent: 0, targetPercent: 100, maxPercent: 100, hardCapPercent: 100 } }], borrowingRules: [] },
				allocationSliceIds: ['project:project-a'], committedCreditsBySlice: { 'project:project-a': 0 },
				providerCapacity: { availableCredits: 10, availableConcurrentAssignments: 2 }, providerLocalLimits: { availableCredits: 10, availableConcurrentAssignments: 2 },
				grantCommitted: { dailyCredits: 0, monthlyCredits: 0, activeAssignments: 0 },
			};
			const concurrentAdmissions = await Promise.allSettled(['one', 'two'].map((suffix) => commitCapacityAdmission(store, {
				idempotencyKey: `phase4-admission-${suffix}`, admission, reservationId: `phase4-reservation-${suffix}`, assignmentId: `phase4-assignment-${suffix}`,
				assignment: { projectAgentClassId: 'class-a', workDayId: 'workday-a' },
			})));
			const admissionFailures = concurrentAdmissions.filter((result) => result.status === 'rejected').map((result) => ({ code: result.reason?.code, message: result.reason?.message }));
			expect(concurrentAdmissions.filter((result) => result.status === 'fulfilled'), JSON.stringify(admissionFailures)).toHaveLength(1);
			expect(concurrentAdmissions.filter((result) => result.status === 'rejected')).toHaveLength(1);
			expect(concurrentAdmissions.find((result) => result.status === 'rejected')).toMatchObject({ status: 'rejected', reason: { code: 'capacity_admission_concurrent_limit_exhausted' } });
			expect((await database.pool.query(`SELECT COUNT(*)::integer AS count FROM capacity_reservations WHERE id LIKE 'phase4-reservation-%'`)).rows[0]).toEqual({ count: 1 });
			const admitted = concurrentAdmissions.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof commitCapacityAdmission>>> => result.status === 'fulfilled')!.value;
			const reservationId = String(admitted.reservation.id);
			const assignmentId = String(admitted.assignment.id);
			await reportCapacityUsage(store, {
				teamId: 'team-a', membershipId: 'membership-a', reservationId, assignmentId,
				idempotencyKey: 'phase6-usage-incremental', usageDimension: 'provider-billing',
				accountingMode: 'incremental', actualCredits: 2, source: 'phase6_postgres_concurrency',
			});
			const rollbackStore = new Proxy(store, {
				get(target, property) {
					if (property === 'batch') return async (operations: Parameters<typeof target.batch>[0]) => target.batch([
						...operations,
						{ query: 'INSERT INTO phase6_missing_table (id) VALUES (?)', params: ['force-rollback'] },
					]);
					return Reflect.get(target, property, target);
				},
			});
			await expect(settleCapacityReservationExactlyOnce(rollbackStore, {
				settlementKey: 'phase6-forced-rollback', teamId: 'team-a', membershipId: 'membership-a', reservationId, assignmentId,
				actualCredits: 4, source: 'phase6_postgres_forced_rollback',
			})).rejects.toThrow();
			expect((await database.pool.query(`SELECT state, settlement_token FROM capacity_reservations WHERE id = $1`, [reservationId])).rows[0])
				.toMatchObject({ state: 'reserved', settlement_token: null });
			expect((await database.pool.query(`SELECT COUNT(*)::integer AS count FROM capacity_ledger_entries WHERE reservation_id = $1`, [reservationId])).rows[0]).toEqual({ count: 0 });
			expect((await database.pool.query(`SELECT COUNT(*)::integer AS count FROM capacity_usage_actuals WHERE assignment_id = $1 AND accounting_mode = 'aggregate'`, [assignmentId])).rows[0]).toEqual({ count: 0 });
			const settle = (settlementKey: string) => settleCapacityReservationExactlyOnce(store, {
				settlementKey, teamId: 'team-a', membershipId: 'membership-a', reservationId, assignmentId,
				actualCredits: 4, source: 'phase6_postgres_concurrency',
			});
			const race = await Promise.allSettled([
				settle('phase6-settlement-a'),
				settle('phase6-settlement-b'),
				reportCapacityUsage(store, { teamId: 'team-a', membershipId: 'membership-a', reservationId, assignmentId, idempotencyKey: 'phase6-usage-race', usageDimension: 'race-diagnostic', accountingMode: 'informational', actualCredits: 0, source: 'phase6_postgres_concurrency' }),
			]);
			const settlements = race.slice(0, 2).filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof settle>>> => result.status === 'fulfilled').map((result) => result.value);
			expect(settlements).toHaveLength(2);
			expect(settlements.filter((result) => result.replayed)).toHaveLength(1);
			expect(settlements.filter((result) => !result.replayed)).toHaveLength(1);
			expect((await database.pool.query(`SELECT COUNT(*)::integer AS count FROM capacity_ledger_entries WHERE reservation_id = $1 AND phase = 'task_completed_actual_settlement'`, [reservationId])).rows[0]).toEqual({ count: 1 });
			expect((await database.pool.query(`SELECT COUNT(*)::integer AS count FROM capacity_usage_actuals WHERE assignment_id = $1 AND assignment_attempt = 0 AND usage_dimension = 'aggregate'`, [assignmentId])).rows[0]).toEqual({ count: 1 });
			const lateReport = race[2];
			if (lateReport.status === 'rejected') expect(lateReport.reason).toMatchObject({ code: 'capacity_usage_reporting_closed' });
			expect((await database.pool.query(`SELECT COUNT(*)::integer AS count FROM capacity_usage_actuals WHERE assignment_id = $1 AND accounting_mode = 'incremental'`, [assignmentId])).rows[0]).toEqual({ count: 1 });
			expect((await database.pool.query(`SELECT state, consumed_credits FROM capacity_reservations WHERE id = $1`, [reservationId])).rows[0]).toMatchObject({ state: 'consumed', consumed_credits: 4 });
		} finally {
			await database.close();
			await dropDatabase(name);
		}
	}, 120_000);

	it('serializes workday events and enforces run, allocation, and graph concurrency through the domain owners', async () => {
		const name = safeDatabaseName('domains');
		await createDatabase(name);
		const database = new MarketPostgresDatabase(databaseUrl(name));
		const store = createCapacityControlPlane(new MarketControlPlaneStore({ repoRoot: process.cwd() }, database));
		try {
			await store.ensureInitialized();
			const now = new Date().toISOString();
			await store.run(`INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, ['team-domain', 'team-domain', 'Domain Team', now, now]);
			await store.run(`INSERT INTO projects (id, team_id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, ['project-domain', 'team-domain', 'project-domain', 'Domain Project', now, now]);
			await store.run(
				`INSERT INTO capacity_workday_runs (id, team_id, scenario_id, status, environment, parameters_json, created_at, updated_at)
				 VALUES (?, ?, ?, 'queued', 'local', '{}', ?, ?)`,
				['run-domain', 'team-domain', 'domain-concurrency', now, now],
			);

			const events = new CapacityWorkdayEventService(store);
			const createdEvents = await Promise.all(Array.from({ length: 20 }, (_, index) => events.create('team-domain', 'run-domain', {
				id: `event-${String(index).padStart(2, '0')}`,
				eventType: 'concurrency-proof',
				status: 'recorded',
				createdAt: new Date(Date.parse(now) + index).toISOString(),
			})));
			expect(createdEvents.map((event) => event?.eventIndex).sort((left, right) => Number(left) - Number(right)))
				.toEqual(Array.from({ length: 20 }, (_, index) => index));
			expect((await store.first(`SELECT next_event_index FROM capacity_workday_runs WHERE id = 'run-domain'`)))
				.toEqual({ next_event_index: 20 });

			const duplicateEvents = await Promise.all([
				events.create('team-domain', 'run-domain', { id: 'event-idempotent', eventType: 'idempotent' }),
				events.create('team-domain', 'run-domain', { id: 'event-idempotent', eventType: 'idempotent' }),
			]);
			expect(duplicateEvents[0]).toEqual(duplicateEvents[1]);
			expect(Number((await store.first(`SELECT COUNT(*) AS count FROM capacity_workday_events WHERE id = 'event-idempotent'`))?.count)).toBe(1);

			const runReads = new CapacityWorkdayRunRepository(store);
			const runWrites = new CapacityWorkdayRunWriteRepository(store);
			const queuedRun = await runReads.get('team-domain', 'run-domain');
			assert(queuedRun);
			const runTransitions = await Promise.all([
				runWrites.update({ ...queuedRun, status: 'cancelled', completedAt: now, updatedAt: now }, 'queued'),
				runWrites.update({ ...queuedRun, status: 'failed', completedAt: now, updatedAt: now }, 'queued'),
			]);
			expect(runTransitions.filter(Boolean)).toHaveLength(1);
			expect(['cancelled', 'failed']).toContain((await runReads.get('team-domain', 'run-domain'))?.status);

			const runStore = Object.create(store) as typeof store;
			runStore.scheduleCapacityWorkdayRun = async () => ({ projects: [], allocationSet: {} as never });
			runStore.terminalizeCapacityWorkdayAssignments = async () => ({
				assignmentCount: 0, completedAssignments: 0, failedAssignments: 0, unfinishedAssignmentCount: 0,
				terminalizedAssignments: 0, terminalizedModeRuns: 0, releasedReservations: 0, preserveActiveLeasesUntil: null,
				deferredActiveAssignmentCount: 0, settlementErrors: [], settlementErrorCount: 0, settlementErrorsTruncated: false,
			});
			runStore.terminalizeCapacityWorkdayEnvelopes = async () => ({ terminalized: 0 });
			const runs = new CapacityWorkdayRunService(runStore);
			await Promise.all([
				runs.create('team-domain', { id: 'run-successor-a', status: 'running', environment: 'local', parameters: { durationSeconds: 60 } }),
				runs.create('team-domain', { id: 'run-successor-b', status: 'running', environment: 'local', parameters: { durationSeconds: 60 } }),
			]);
			const successorStates = await store.all(`SELECT id, status FROM capacity_workday_runs WHERE id IN ('run-successor-a', 'run-successor-b') ORDER BY id`);
			expect(successorStates.filter((row) => row.status === 'running')).toHaveLength(1);
			expect(successorStates.filter((row) => row.status === 'failed')).toHaveLength(1);

			const maintenanceAt = new Date(Date.parse(now) + 700_000).toISOString();
			await store.run(
				`INSERT INTO capacity_workday_runs (id, team_id, scenario_id, status, environment, parameters_json, started_at, created_at, updated_at)
				 VALUES (?, ?, ?, 'running', 'local', ?, ?, ?, ?)`,
				['run-maintenance', 'team-domain', 'maintenance-concurrency', JSON.stringify({ durationSeconds: 60, deadlineAt: now }), now, now, now],
			);
			await Promise.all([
				store.maintainCapacityWorkdayRuns('team-domain', maintenanceAt),
				store.maintainCapacityWorkdayRuns('team-domain', maintenanceAt),
			]);
			expect(await runReads.get('team-domain', 'run-maintenance')).toMatchObject({ status: 'degraded' });
			expect(Number((await store.first(`SELECT COUNT(*) AS count FROM capacity_workday_events WHERE id = 'workday-deadline:run-maintenance'`))?.count)).toBe(1);

			const allocations = new CapacityAllocationService(store);
			const allocationPolicy = (projectId: string) => ({
				reservePolicy: { percent: 10, overflow: 'deny' },
				slices: [{ id: `project:${projectId}`, scope: 'project', targetId: projectId, policy: { minPercent: 50, targetPercent: 90, maxPercent: 90, hardCapPercent: 95 } }],
				borrowingRules: [],
	});

			const allocationA = await allocations.create('team-domain', { id: 'allocation-domain-a', version: 1, ...allocationPolicy('project-domain') }, null, 'domain-create-a');
			const allocationB = await allocations.create('team-domain', { id: 'allocation-domain-b', version: 2, ...allocationPolicy('project-domain') }, null, 'domain-create-b');
			await Promise.all([allocations.activate('team-domain', allocationA.id, 'domain-activate-a'), allocations.activate('team-domain', allocationB.id, 'domain-activate-b')]);
			const activeAllocations = await store.all(`SELECT id FROM capacity_allocation_sets WHERE team_id = 'team-domain' AND status = 'active'`);
			expect(activeAllocations).toHaveLength(1);
			const allocationVersionRace = await Promise.allSettled([
				allocations.create('team-domain', { id: 'allocation-domain-race-a', version: 3, ...allocationPolicy('project-domain') }, null, 'domain-race-a'),
				allocations.create('team-domain', { id: 'allocation-domain-race-b', version: 3, ...allocationPolicy('project-domain') }, null, 'domain-race-b'),
			]);
			expect(allocationVersionRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
			expect(allocationVersionRace.filter((result) => result.status === 'rejected')).toHaveLength(1);
			await expect(store.run(
				`INSERT INTO capacity_allocation_sets (id, team_id, version, status, effective_from, effective_until, reserve_policy_json, slices_json, borrowing_rules_json, metadata_json, created_at, updated_at)
				 VALUES (?, ?, 4, 'draft', ?, ?, '{}', '[]', '[]', '{}', ?, ?)`,
				['allocation-invalid-interval', 'team-domain', now, new Date(Date.parse(now) - 1).toISOString(), now, now],
			)).rejects.toMatchObject({ code: '23514' });

			await store.createStructuredAgentEstimate('decision-domain', {
				id: 'estimate-domain', projectId: 'project-domain', status: 'accepted', agentClass: 'engineer', minCredits: 1, expectedCredits: 2, maxCredits: 3,
				dependencies: [{ id: 'test-proof', type: 'artifact', requiredBefore: 'start', deliverableType: 'test-proof', agentClass: 'tester', summary: 'A failing regression test' }],
				expectedOutputs: [{ outputType: 'implementation', required: true }], acceptanceCriteria: ['tests pass'],
			});
			const concurrentGraphs = await Promise.allSettled([
				store.createDecisionAssignmentGraph('decision-domain', { id: 'graph-domain-a', projectId: 'project-domain' }),
				store.createDecisionAssignmentGraph('decision-domain', { id: 'graph-domain-b', projectId: 'project-domain' }),
			]);
			expect(concurrentGraphs.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
			expect(concurrentGraphs.filter((result) => result.status === 'rejected')).toHaveLength(1);
			const firstGraph = (concurrentGraphs.find((result) => result.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof store.createDecisionAssignmentGraph>>>).value;
			assert(firstGraph);
			const secondGraph = await store.createDecisionAssignmentGraph('decision-domain', { id: 'graph-domain-c', projectId: 'project-domain' });
			assert(secondGraph);
			await Promise.all([
				store.activateDecisionAssignmentGraphVersion(firstGraph.id),
				store.activateDecisionAssignmentGraphVersion(secondGraph.id),
			]);
			expect(await store.listDecisionAssignmentGraphsForDecision('decision-domain', { active: true })).toHaveLength(1);
		} finally {
			await database.close();
			await dropDatabase(name);
		}
	}, 120_000);

	it('atomically admits exactly the configured number of concurrent registration attempts', async () => {
		const name = safeDatabaseName('registration_rate_limit');
		await createDatabase(name);
		const database = new MarketPostgresDatabase(databaseUrl(name));
		const store = createCapacityControlPlane(new MarketControlPlaneStore({ repoRoot: process.cwd() }, database));
		try {
			await store.ensureInitialized();
			const repository = new CapacityRegistrationSecurityRepository(store);
			const now = new Date().toISOString();
			const expiresAt = new Date(Date.parse(now) + 60_000).toISOString();
			const outcomes = await Promise.all(Array.from({ length: 21 }, () => repository.consumeRegistrationRateLimits({
				buckets: [{ dimension: 'team', key: 'concurrent-team' }],
				now,
				expiresAt,
				limit: 20,
			})));
			expect(outcomes.filter((entry) => entry.length === 0)).toHaveLength(20);
			expect(outcomes.filter((entry) => entry.includes('team'))).toHaveLength(1);
			expect((await database.pool.query(`SELECT count FROM capacity_provider_registration_rate_limits WHERE dimension = 'team' AND bucket_key = 'concurrent-team'`)).rows).toEqual([{ count: 21 }]);

			await database.batch([
				{ query: `INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`, params: ['rotation-team-a', 'rotation-team-a', 'Rotation Team A', now, now, 'rotation-team-b', 'rotation-team-b', 'Rotation Team B', now, now] },
				{ query: `INSERT INTO capacity_providers (id, fingerprint, public_jwk_json, display_name, identity_version, status, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'active', '{}', ?, ?)`, params: ['rotation-provider', 'sha256:old', '{"kty":"OKP","crv":"Ed25519","x":"old"}', 'Rotation Provider', now, now] },
				{ query: `INSERT INTO capacity_provider_team_memberships (id, team_id, capacity_provider_id, status, approved_at, approved_by_id, metadata_json, created_at, updated_at) VALUES (?, ?, ?, 'approved', ?, ?, '{}', ?, ?), (?, ?, ?, 'approved', ?, ?, '{}', ?, ?)`, params: ['rotation-membership-a', 'rotation-team-a', 'rotation-provider', now, 'owner-a', now, now, 'rotation-membership-b', 'rotation-team-b', 'rotation-provider', now, 'owner-b', now, now] },
			]);
			const governance = new CapacityProviderIdentityRepository(store);
			const rotationInput = {
				id: 'rotation-record', providerId: 'rotation-provider', expectedVersion: 1, oldFingerprint: 'sha256:old', fingerprint: 'sha256:new',
				publicJwkJson: '{"kty":"OKP","crv":"Ed25519","x":"new"}', idempotencyKey: 'rotation-idempotency', requestDigest: 'rotation-digest', now,
				proofs: [{ fingerprint: 'sha256:old', jti: 'old-proof', expiresAt }, { fingerprint: 'sha256:new', jti: 'new-proof', expiresAt }],
			};
			const rotations = await Promise.all([governance.rotate(rotationInput), governance.rotate(rotationInput)]);
			expect(rotations).toEqual([expect.objectContaining({ identityVersion: 2, fingerprint: 'sha256:new' }), expect.objectContaining({ identityVersion: 2, fingerprint: 'sha256:new' })]);
			expect((await database.pool.query(`SELECT id FROM capacity_provider_identity_rotations WHERE capacity_provider_id = 'rotation-provider'`)).rows).toHaveLength(1);
			expect((await database.pool.query(`SELECT id FROM capacity_provider_team_memberships WHERE capacity_provider_id = 'rotation-provider' AND status = 'approved'`)).rows).toHaveLength(2);

			await store.run(`INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, ['key-race-team', 'key-race-team', 'Key Race Team', now, now]);
			await store.run(`INSERT INTO team_capacity_registration_keys (id, team_id, generation, key_prefix, key_hash, encrypted_reveal_value, status, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, 'active', ?, ?)`, ['key-race-1', 'key-race-team', 'tsrk_race1', 'hash-1', 'cipher-1', now, now]);
			const registrationAdmission = new CapacityRegistrationRequestAdmissionRepository(store);
			const keyGovernance = new CapacityGovernanceRepository(store);
			await Promise.allSettled([
				registrationAdmission.admit({ id: 'key-race-request', teamId: 'key-race-team', providerId: 'key-race-provider', fingerprint: 'sha256:key-race-provider', publicJwkJson: '{"kty":"OKP","crv":"Ed25519","x":"race"}', displayName: 'Race Provider', generation: 1, capabilities: ['research'], supplyOffer: { capabilities: ['research'] }, proofJti: 'key-race-proof', idempotencyKey: 'key-race-registration', requestDigest: 'key-race-digest', expiresAt, metadata: {}, now }),
				keyGovernance.rotateRegistrationKey({ id: 'key-race-2', teamId: 'key-race-team', generation: 2, prefix: 'tsrk_race2', hash: 'hash-2', encryptedRevealValue: 'cipher-2', idempotencyKey: 'key-race-rotation', actorId: 'owner', now }),
			]);
			expect((await database.pool.query(`SELECT id FROM capacity_provider_registration_requests WHERE team_id = 'key-race-team' AND registration_key_generation = 1 AND status = 'pending'`)).rows).toEqual([]);
			expect(Number((await database.pool.query(`SELECT COUNT(*) AS count FROM capacity_providers WHERE id = 'key-race-provider'`)).rows[0]?.count))
				.toBe(Number((await database.pool.query(`SELECT COUNT(*) AS count FROM capacity_provider_registration_requests WHERE id = 'key-race-request'`)).rows[0]?.count));
		} finally {
			await database.close();
		}
	}, 30_000);

	it('rolls back an entire failed migration file on its pinned PostgreSQL connection', async () => {
		const name = safeDatabaseName('migration');
		const migrationRoot = mkdtempSync(join(tmpdir(), 'treeseed-phase1-migrations-'));
		writeFileSync(join(migrationRoot, '0000_probe.sql'), 'CREATE TABLE committed_probe (id text PRIMARY KEY);');
		writeFileSync(join(migrationRoot, '0001_rollback.sql'), [
			'CREATE TABLE rolled_back_probe (id text PRIMARY KEY)',
			"INSERT INTO rolled_back_probe (id) VALUES ('should-not-survive')",
			'INSERT INTO missing_probe (id) VALUES (\'failure\')',
		].join(';\n'));
		await createDatabase(name);
		const database = new MarketPostgresDatabase(databaseUrl(name), { migrationRoot });
		try {
			await expect(database.migrate()).rejects.toThrow(/0001_rollback\.sql/u);
			const tables = await database.pool.query(
				`SELECT table_name FROM information_schema.tables
				 WHERE table_schema = 'public' AND table_name IN ('committed_probe', 'rolled_back_probe')
				 ORDER BY table_name`,
			);
			expect(tables.rows.map((row) => row.table_name)).toEqual(['committed_probe']);
			const applied = await database.pool.query(`SELECT name FROM treeseed_market_schema_migrations ORDER BY name`);
			expect(applied.rows.map((row) => row.name)).toEqual(['0000_probe.sql']);
		} finally {
			await database.close();
			await dropDatabase(name);
			rmSync(migrationRoot, { recursive: true, force: true });
		}
	}, 30_000);
});
