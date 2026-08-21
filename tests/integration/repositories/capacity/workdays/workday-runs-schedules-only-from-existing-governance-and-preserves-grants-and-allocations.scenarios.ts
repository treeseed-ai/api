import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataType,newDb } from 'pg-mem';
import { describe,expect,it } from 'vitest';
import { createCapacityControlPlane } from '../../../../../src/api/capacity/control-plane.ts';
import { aggregateNativeReservationDebits } from '../../../../../src/api/capacity/services/capacity/accounting/native-reservation-aggregation-service.ts';
import { CapacityGrantService } from '../../../../../src/api/capacity/services/capacity/allocations/grant-service.ts';
import { WorkdayPreflightService } from '../../../../../src/api/capacity/services/capacity/workdays/scheduling/workday-preflight-service.ts';
import { MarketControlPlaneStore } from '../../../../../src/api/persistence/store.js';
import { MarketPostgresDatabase } from '../../../../../src/api/support/market-postgres.js';
const packageRoot = process.cwd();
const marketMigrationRoot = existsSync(resolve(packageRoot, '../sdk/drizzle/market'))
    ? resolve(packageRoot, '../sdk/drizzle/market')
    : resolve(packageRoot, 'node_modules/@treeseed/sdk/drizzle/market');
function createStore() {
    const memory = newDb();
	memory.public.registerFunction({ name: "replace", args: [DataType.text, DataType.text, DataType.text], returns: DataType.text, implementation: (value: string, search: string, replacement: string) => value.split(search).join(replacement) });
    memory.public.registerFunction({
        name: 'md5',
        args: [DataType.text],
        returns: DataType.text,
        implementation: (value: string) => `md5:${value}`,
    });
    const pg = memory.adapters.createPg();
    const db = MarketPostgresDatabase.fromPool(new pg.Pool(), { migrationRoot: marketMigrationRoot });
    const store = createCapacityControlPlane(new MarketControlPlaneStore({
        repoRoot: packageRoot,
        authSecret: 'test-auth-secret',
        assertionSecret: 'test-assertion-secret',
		serviceId: 'web',
		serviceSecret: 'test-service-secret',
		fetchImpl: async () => Response.json({ ok: true, results: [], resolvedRef: 'a'.repeat(40), page: { hasMore: false, nextCursor: null } }),
    }, db));
    return { db, store };
}

describe('workday runs', () => {
it('schedules only from existing governance and preserves grants and allocations', async () => {
    const { db, store } = createStore();
    try {
        await store.ensureInitialized();
        const now = new Date().toISOString();
        const effectiveFrom = new Date(Date.now() - 60000).toISOString();
        await store.run(`INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, ['team-governed', 'team-governed', 'Governed Team', now, now]);
        await store.run(`INSERT INTO projects (id, team_id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, ['project-agent', 'team-governed', 'agent', 'Agent', now, now]);
        await store.run(`INSERT INTO capacity_providers (id, fingerprint, public_jwk_json, display_name, identity_version, status, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'active', '{}', ?, ?)`, ['provider-governed', 'sha256:provider-governed', JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: 'provider-governed', alg: 'EdDSA' }), 'Governed Provider', now, now]);
        await store.run(`INSERT INTO capacity_provider_team_memberships (id, team_id, capacity_provider_id, status, approved_at, approved_by_id, metadata_json, created_at, updated_at) VALUES (?, ?, ?, 'approved', ?, ?, '{}', ?, ?)`, ['membership-governed', 'team-governed', 'provider-governed', now, 'owner', now, now]);
        await store.run(`INSERT INTO capacity_execution_providers (id, capacity_provider_id, display_name, adapter, status, capabilities_json, native_unit, quota_visibility, max_concurrent_runners, native_limits_json, metadata_json, created_at, updated_at) VALUES ('codex', 'provider-governed', 'Codex', 'codex', 'active', '["engineering","repo_read","agent_mode_run"]', 'wall_minute', 'exact', 1, '[]', '{}', ?, ?)`, [now, now]);
        await store.run(`INSERT INTO treedx_instances (id, team_id, kind, provider, name, base_url, public_read, "primary", status, metadata_json, created_at, updated_at) VALUES (?, ?, 'local', 'local', 'Local TreeDX', 'http://127.0.0.1:4000', 0, 1, 'active', '{}', ?, ?)`, ['treedx-governed', 'team-governed', now, now]);
        await store.run(`INSERT INTO treedx_project_libraries (id, team_id, project_id, instance_id, library_id, repository_id, content_path, topology_json, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'docs/src/content', '{}', '{}', ?, ?)`, ['library-agent', 'team-governed', 'project-agent', 'treedx-governed', 'team-governed/agent', 'treeseed-agent', now, now]);
        const allocation = await store.createCapacityAllocationSet('team-governed', {
            id: 'allocation-governed', version: 1, status: 'draft', effectiveFrom,
            reservePolicy: { percent: 0, overflow: 'deny' },
            slices: [{ id: 'slice-agent', scope: 'project', targetId: 'project-agent', policy: { minPercent: 100, targetPercent: 100, maxPercent: 100, hardCapPercent: 100 } }],
            borrowingRules: [],
            idempotencyKey: 'governed-allocation-create',
        });
        await store.activateCapacityAllocationSet('team-governed', allocation.id, 'governed-allocation-activate');
        const grantService = new CapacityGrantService(store);
        const grant = await grantService.create('team-governed', {
            id: 'grant-governed', membershipId: 'membership-governed', projectId: 'project-agent', environment: 'local',
            executionProviderIds: ['codex'], laneIds: [], capabilities: ['repo_read', 'agent_mode_run'], allowedModes: ['planning'], unmetered: true,
        }, 'governed-grant-create');
        await grantService.transition('team-governed', grant!.id, 'active', 'governed-grant-activate');
        await store.run(`INSERT INTO project_agent_classes (id, team_id, project_id, slug, name, allowed_modes_json, handler_refs_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '["planning"]', ?, ?, ?)`, ['class-native-accounting', 'team-governed', 'project-agent', 'native-accounting', 'Native Accounting', JSON.stringify({ agents: [{ slug: 'accountant', activities: { planning: { handler: 'writer', purpose: 'Plan native capacity accounting.' } } }] }), now, now]);
        await store.run(`INSERT INTO capacity_reservations (
					id, idempotency_key, admission_token, membership_id, grant_id, capacity_provider_id, execution_provider_id,
					allocation_set_id, allocation_version, project_agent_class_id, mode, team_id, project_id,
					state, requested_seconds, reserved_seconds, active_seconds, elapsed_seconds, native_unit, reserved_native_amount,
					consumed_native_amount, created_at, updated_at
				) VALUES
					(?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'planning', ?, ?, 'reserved', 2, 2, 0, 0, 'wall_minute', 10, NULL, ?, ?),
					(?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'planning', ?, ?, 'consumed', 2, 2, 2, 2, 'wall_minute', NULL, 15, ?, ?)`, [
            'native-reserved', 'native-reserved', 'native-reserved-token', 'membership-governed', grant!.id, 'provider-governed', 'codex', allocation.id,
            'class-native-accounting', 'team-governed', 'project-agent', '2026-07-17T03:00:00.000Z', '2026-07-17T03:00:00.000Z',
            'native-consumed', 'native-consumed', 'native-consumed-token', 'membership-governed', grant!.id, 'provider-governed', 'codex', allocation.id,
            'class-native-accounting', 'team-governed', 'project-agent', '2026-07-17T02:00:00.000Z', '2026-07-17T02:00:00.000Z',
        ]);
        expect(await aggregateNativeReservationDebits(store, {
            teamId: 'team-governed', capacityProviderId: 'provider-governed', executionProviderId: 'codex',
            nativeUnit: 'wall_minute', providerNativeUnit: 'wall_minute', projectId: 'project-agent',
            windowStartAt: '2026-07-17T00:00:00.000Z', windowEndAt: '2026-07-18T00:00:00.000Z',
        })).toEqual({ activeReservedNativeAmount: 10, activeConsumedNativeAmount: 15 });
        expect(await store.getTeamCapacitySummary('team-governed', { now: '2026-07-17T04:00:00.000Z' })).toMatchObject({
            dailyActiveSeconds: 2,
            dailyReservedSeconds: 4,
            monthlyActiveSeconds: 2,
            monthlyReservedSeconds: 4,
        });
        const before = {
            grants: Number((await store.first(`SELECT COUNT(*) AS count FROM capacity_grants WHERE team_id = ?`, ['team-governed']))?.count ?? 0),
            allocations: Number((await store.first(`SELECT COUNT(*) AS count FROM capacity_allocation_sets WHERE team_id = ?`, ['team-governed']))?.count ?? 0),
        };
		const workdays=new WorkdayPreflightService(store);
		await expect(workdays.preflight('team-governed',{
			schemaVersion:'treeseed.workday-intent/v1',teamId:'team-governed',profileId:'unknown-profile',projects:['agent'],
			startsAt:new Date(Date.now()+60_000).toISOString(),durationSeconds:900,operatorConstraints:{providerIds:['provider-governed'],maxConcurrency:1,reservePercent:0},
		},'owner-a')).rejects.toMatchObject({code:'workday_profile_not_indexed'});
		const preflight=await workdays.preflight('team-governed',{
			schemaVersion:'treeseed.workday-intent/v1',teamId:'team-governed',profileId:allocation.id,projects:['agent'],
			startsAt:new Date(Date.now()+60_000).toISOString(),durationSeconds:900,operatorConstraints:{providerIds:['provider-governed'],maxConcurrency:1,reservePercent:0},
		},'owner-a');
		expect(preflight).toMatchObject({schemaVersion:'treeseed.workday-preflight/v1',teamId:'team-governed',profileId:allocation.id,profileGeneration:1,maxConcurrency:1,reserveSeconds:0});
		expect({
			runs: Number((await store.first(`SELECT COUNT(*) AS count FROM capacity_workday_runs WHERE team_id = ?`, ['team-governed']))?.count ?? 0),
			envelopes: Number((await store.first(`SELECT COUNT(*) AS count FROM workday_capacity_envelopes WHERE team_id = ?`, ['team-governed']))?.count ?? 0),
			events: Number((await store.first(`SELECT COUNT(*) AS count FROM capacity_workday_events WHERE team_id = ?`, ['team-governed']))?.count ?? 0),
			participants: Number((await store.first(`SELECT COUNT(*) AS count FROM workday_planning_participants`, []))?.count ?? 0),
			waves: Number((await store.first(`SELECT COUNT(*) AS count FROM workday_planning_waves`, []))?.count ?? 0),
		}).toEqual({ runs: 0, envelopes: 0, events: 0, participants: 0, waves: 0 });
		const storedRow=await store.first(`SELECT response_json FROM capacity_operation_receipts WHERE team_id=? AND resource_type='workday_preflight' AND resource_id=?`,['team-governed',preflight.id]);
		const tampered=JSON.parse(String(storedRow!.response_json));
		tampered.receipt.maxConcurrency=2;
		await store.run(`UPDATE capacity_operation_receipts SET response_json=? WHERE team_id=? AND resource_type='workday_preflight' AND resource_id=?`,[JSON.stringify(tampered),'team-governed',preflight.id]);
		await expect(workdays.start('team-governed',{preflightId:preflight.id,preflightDigest:preflight.preflightDigest,idempotencyKey:'start-tampered'},'owner-a')).rejects.toMatchObject({code:'workday_preflight_integrity_invalid'});
		await store.run(`UPDATE capacity_operation_receipts SET response_json=? WHERE team_id=? AND resource_type='workday_preflight' AND resource_id=?`,[storedRow!.response_json,'team-governed',preflight.id]);
		const started=await workdays.start('team-governed',{preflightId:preflight.id,preflightDigest:preflight.preflightDigest,idempotencyKey:'start-governed'},'owner-a');
		const run=await store.getCapacityWorkdayRun('team-governed',started.workdayId);
		expect(run).toMatchObject({
			id: started.workdayId, status: 'running',
            parameters: {
                allocationSetId: allocation.id,
                scheduledProjectIds: ['project-agent'],
                scheduledProjectSlugs: ['agent'],
                repositoryIdsByProjectId: { 'project-agent': 'treeseed-agent' },
            },
        });
		expect(await store.getWorkdayCapacityEnvelope(`workday-${started.workdayId}-agent`)).toMatchObject({
			status: 'active', workdayRunId: started.workdayId, allocationSetId: allocation.id, metadata: { grantId: grant!.id },
        });
        expect({
            grants: Number((await store.first(`SELECT COUNT(*) AS count FROM capacity_grants WHERE team_id = ?`, ['team-governed']))?.count ?? 0),
            allocations: Number((await store.first(`SELECT COUNT(*) AS count FROM capacity_allocation_sets WHERE team_id = ?`, ['team-governed']))?.count ?? 0),
        }).toEqual(before);
		await store.updateCapacityWorkdayRun('team-governed', started.workdayId, { status: 'completed' });
		expect(await store.getWorkdayCapacityEnvelope(`workday-${started.workdayId}-agent`)).toMatchObject({ status: 'completed' });
        expect(await grantService.get('team-governed', grant!.id)).toMatchObject({ status: 'active' });
    }
    finally {
        db.close();
    }
});

it('records a failed run when required governance is absent', async () => {
    const { db, store } = createStore();
    try {
        await store.ensureInitialized();
        await store.createTeam({ id: 'team-no-policy', slug: 'team-no-policy', name: 'no-policy' });
        await expect(store.createCapacityWorkdayRun('team-no-policy', {
            id: 'run-no-policy', capacityProviderId: 'provider-missing', environment: 'local', status: 'running',
            parameters: { projects: ['agent'], durationSeconds: 60 },
        })).rejects.toMatchObject({ code: 'capacity_workday_membership_not_approved' });
        expect(await store.getCapacityWorkdayRun('team-no-policy', 'run-no-policy')).toMatchObject({
            status: 'failed', error: { code: 'capacity_workday_schedule_failed' },
        });
    }
    finally {
        db.close();
    }
});

it('persists workday runs and ordered audit events', async () => {
    const { db, store } = createStore();
    try {
        await store.ensureInitialized();
        await store.createTeam({
            id: 'team-test',
            slug: 'treeseed',
            name: 'TreeSeed',
        });
        const run = await store.createCapacityWorkdayRun('team-test', {
            id: 'run-test',
            capacityProviderId: 'provider-local',
            status: 'queued',
            parameters: { providerCredentialRef: 'secret://capacity/team-test', projects: ['market'], durationSeconds: 60 },
            expected: { projects: ['market'] },
        });
        expect(run).toMatchObject({
            id: 'run-test',
            teamId: 'team-test',
            status: 'queued',
            capacityProviderId: 'provider-local',
            parameters: { providerCredentialRef: 'secret://capacity/team-test', projects: ['market'], durationSeconds: 60, deadlineAt: null },
        });
        const first = await store.createCapacityWorkdayEvent('team-test', 'run-test', {
            eventType: 'command.started',
            title: 'Started',
            parameters: { projects: ['market'] },
        });
        const second = await store.createCapacityWorkdayEvent('team-test', 'run-test', {
            eventType: 'command.completed',
            status: 'completed',
            title: 'Completed',
        });
        const idempotent = await store.createCapacityWorkdayEvent('team-test', 'run-test', {
            id: 'event-idempotent', eventType: 'command.observed', status: 'recorded', title: 'Observed',
        });
		await expect(store.createCapacityWorkdayEvent('team-test', 'run-test', {
			id: 'event-idempotent', eventType: 'command.changed', status: 'error', title: 'Must not replace',
		})).rejects.toMatchObject({ code: 'capacity_workday_event_idempotency_conflict' });
		const repeated = await store.createCapacityWorkdayEvent('team-test', 'run-test', {
			id: 'event-idempotent', eventType: 'command.observed', status: 'recorded', title: 'Observed',
			createdAt: idempotent?.createdAt,
		});
        expect(first?.eventIndex).toBe(0);
        expect(second?.eventIndex).toBe(1);
        expect(idempotent).toMatchObject({ eventIndex: 2, eventType: 'command.observed', status: 'recorded' });
        expect(repeated).toEqual(idempotent);
        expect(await store.first(`SELECT next_event_index FROM capacity_workday_runs WHERE id = ?`, ['run-test'])).toMatchObject({ next_event_index: 3 });
        await store.updateCapacityWorkdayRun('team-test', 'run-test', { status: 'running' });
        const updated = await store.updateCapacityWorkdayRun('team-test', 'run-test', {
            status: 'completed',
            metrics: { score: 100 },
            reportRefs: { jsonPath: '.treeseed/workday-reports/workday-run-test.json' },
        });
        expect(updated).toMatchObject({
            status: 'completed',
            metrics: { score: 100 },
        });
        expect(updated?.completedAt).toBeTruthy();
        await expect(store.updateCapacityWorkdayRun('team-test', 'run-test', { status: 'running' }))
            .rejects.toMatchObject({ code: 'capacity_workday_run_transition_invalid' });
        expect(await store.getCapacityWorkdayRun('team-test', 'run-test')).toMatchObject({ status: 'completed' });
        const events = (await store.listCapacityWorkdayEventsPage('team-test', 'run-test', { limit: 200 })).items;
        expect(events.map((event) => event.eventType)).toEqual(['command.started', 'command.completed', 'command.observed']);
        const runs = (await store.listCapacityWorkdayRunsPage('team-test', { limit: 100 })).items;
        expect(runs.map((entry) => entry.id)).toEqual(['run-test']);
        await expect(store.createCapacityWorkdayRun('team-test', {
            id: 'run-with-secret',
            parameters: { providerToken: 'secret-value' },
        })).rejects.toMatchObject({ code: 'capacity_workday_secret_forbidden' });
        await expect(store.createCapacityWorkdayRun('team-test', {
            id: 'run-with-invalid-engineering-workflow',
            parameters: { engineeringWorkflows: [{ schemaVersion: 1, id: 'missing-provenance' }] },
        })).rejects.toMatchObject({ code: 'engineering_workflow_config_invalid', status: 400 });
    }
    finally {
        db.close();
    }
});

it('autonomously terminalizes an elapsed run with durable degraded evidence', async () => {
    const { db, store } = createStore();
    try {
        await store.ensureInitialized();
        await store.createTeam({ id: 'team-expiry', slug: 'expiry-team', name: 'expiry-team' });
        await store.createProject('team-expiry', { id: 'project-expiry', slug: 'expiry-project', name: 'expiry-project' });
        const startedAt = new Date(Date.now() + 60000).toISOString();
        const deadlineAt = new Date(Date.parse(startedAt) + 60000).toISOString();
        const terminalizedAt = new Date(Date.parse(deadlineAt) + 600000).toISOString();
        await store.createCapacityWorkdayRun('team-expiry', {
            id: 'run-expiry',
            status: 'queued',
            startedAt,
            parameters: {
                deadlineAt,
                settlementGraceSeconds: 300,
            },
        });
        await store.updateCapacityWorkdayRun('team-expiry', 'run-expiry', {
            status: 'running',
            startedAt,
            parameters: { deadlineAt, settlementGraceSeconds: 300 },
        });
        await store.createWorkdayCapacityEnvelope({
            id: 'workday-expiry', workdayRunId: 'run-expiry', projectId: 'project-expiry', status: 'active', availableSeconds: 60,
        });
        const admissionOnlyAt = new Date(Date.parse(deadlineAt) + 60000).toISOString();
        expect(await store.maintainCapacityWorkdayRuns('team-expiry', admissionOnlyAt)).toEqual({ expired: 0, recoveredTerminalRuns: 0 });
        expect(await store.maintainCapacityWorkdayRuns('team-expiry', admissionOnlyAt)).toEqual({ expired: 0, recoveredTerminalRuns: 0 });
        expect((await store.listCapacityWorkdayEventsPage('team-expiry', 'run-expiry', { limit: 200 })).items[0]).toMatchObject({
            id: 'workday-deadline-admission:run-expiry',
            context: { deadlineAt, settlementGraceSeconds: 300 },
        });
        const concurrent = await Promise.all([
            store.maintainCapacityWorkdayRuns('team-expiry', terminalizedAt),
            store.maintainCapacityWorkdayRuns('team-expiry', terminalizedAt),
        ]);
        expect(concurrent.reduce((sum, result) => sum + result.expired, 0)).toBe(1);
        expect(await store.maintainCapacityWorkdayRuns('team-expiry', terminalizedAt)).toEqual({ expired: 0, recoveredTerminalRuns: 0 });
        const run = await store.getCapacityWorkdayRun('team-expiry', 'run-expiry');
        expect(run).toMatchObject({
            status: 'degraded',
            summary: { status: 'degraded', assignmentCount: 0 },
            metrics: { assignmentCompletionPercent: 0, modeRunSuccessPercent: 0 },
            actual: { assignmentCount: 0, contentArtifactCount: 0, deadlineTerminalizedAt: terminalizedAt },
            error: { code: 'workday_deadline_degraded' },
        });
        const events = (await store.listCapacityWorkdayEventsPage('team-expiry', 'run-expiry', { limit: 200 })).items;
        expect(events).toEqual([
            expect.objectContaining({ id: 'workday-deadline-admission:run-expiry', eventType: 'workday.deadline_admission_closed', status: 'warning' }),
            expect.objectContaining({ id: 'workday-deadline:run-expiry', eventType: 'workday.deadline_terminalized', status: 'warning' }),
        ]);
    }
    finally {
        db.close();
    }
});
});
