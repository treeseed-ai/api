import { describe, expect, it, vi } from 'vitest';
import { assignmentWorkdayRunId } from '../../../../src/api/control-plane/repositories/providers/provider-assignment-support.ts';
import { createProviderAssignmentService, normalizeStoredTimestamp } from '../../../../src/api/control-plane/repositories/providers/provider-assignment-service.ts';
import type { ProviderAssignmentStore } from '../../../../src/api/control-plane/repositories/providers/provider-assignment-support.ts';
import { createDiagnosticEnvelopeService, type DiagnosticEnvelopeService } from '../../../../src/security/diagnostic-envelope.ts';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptedEnvelopeSchema } from '@treeseed/sdk/security';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { frozenAttempt } from '../capacity/accounting/architecture/settlement-fixture.ts';
import { workdayStartDatabase } from '../capacity/workdays/scheduling/architecture/workday-start-fixture.ts';
import { serializeProviderAssignmentRow } from '../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';

describe('provider assignment timestamps', () => {
	it('normalizes database Date values before returning communication receipts', () => {
		expect(normalizeStoredTimestamp(new Date('2026-08-31T05:00:00.123Z'))).toBe('2026-08-31T05:00:00.123Z');
		expect(normalizeStoredTimestamp('2026-08-31 05:00:00.123+00')).toBe('2026-08-31T05:00:00.123Z');
		expect(normalizeStoredTimestamp(null)).toBe('');
	});
});

describe('provider assignment workday identity', () => {
	it('refuses protected ordinary execution evidence when encryption or exact current lease authority is unavailable without writing public events or hiding caller bytes', async () => {
		const createdAt = new Date().toISOString(), deadline = new Date(Date.now() + 30_000).toISOString();
		// Controlled UNIT authority, not an issued or refreshed native deadline.
		const attempt = assignmentAttemptSchema.parse({ ...frozenAttempt, id: 'assignment-1', teamId: 'team-1',
			workdayId: 'workday-run-1', status: 'leased', createdAt, deadline,
			provider: { ...frozenAttempt.provider, providerId: 'provider-1' } });
		const assignment = serializeProviderAssignmentRow({ id: attempt.id, team_id: attempt.teamId, project_id: attempt.projectId,
			capacity_provider_id: attempt.provider.providerId, execution_provider_id: attempt.provider.executionProviderId,
			membership_id: 'membership-1', project_agent_class_id: attempt.agentClass, work_day_id: attempt.workdayId,
			mode: 'acting', status: 'leased', lease_state: 'leased', lease_token: 'original-lease', runner_id: 'original-runner',
			lease_expires_at: deadline, reservation_id: attempt.reservationId, execution_node_id: attempt.nodeId,
			execution_node_revision: attempt.nodeRevision, graph_revision: attempt.graphRevision, attempt_count: attempt.attempt,
			assignment_attempt_json: JSON.stringify(attempt), capacity_envelope_json: JSON.stringify({ teamId: attempt.teamId,
				projectId: attempt.projectId, workDayId: attempt.workdayId, mode: 'acting', projectAgentClassId: attempt.agentClass,
				capacityProviderId: attempt.provider.providerId, executionProviderId: attempt.provider.executionProviderId, reservationId: attempt.reservationId }),
			created_at: createdAt, updated_at: createdAt });
		if (!assignment) throw new Error('Original owning assignment serializer must retain the controlled UNIT row.');
		const writes: unknown[] = [];
		const store: ProviderAssignmentStore = {
			ensureInitialized: async () => undefined, first: async () => null, all: async () => [],
			run: async (query, params) => { writes.push({ query, params }); }, batch: async operations => { writes.push(operations); },
			getProviderAssignment: async () => assignment, leaseNextProviderAssignment: async () => ({}),
			renewProviderAssignmentLease: async () => null, returnProviderAssignment: async () => null,
			completeProviderAssignment: async () => null, failProviderAssignment: async () => null,
			createCapacityWorkdayEvent: async (...args) => { writes.push(args); return null; },
		};
		const auth = { principal: { teamId: 'team-1', capacityProviderId: 'provider-1', membershipId: 'membership-1', scopes: ['provider:assignments:write'] } };
		const original = { id: 'original-observation', eventType: 'provider.execution.completed', component: 'execution-provider',
			status: 'completed', message: 'Original protected observation.', leaseToken: 'original-lease', runnerId: 'original-runner', sequence: 0,
			protectedPayload: { providerEvents: [{ type: 'original-private-action' }] }, context: { sandboxId: 'original-sandbox' } };
		const service = createProviderAssignmentService(store);
		await expect(service.createEvent(auth, assignment.id, original)).rejects.toMatchObject({ status: 503, code: 'diagnostics_encryption_unavailable' });
		expect(writes).toEqual([]);
		let encryptions = 0;
		const envelopes: DiagnosticEnvelopeService = { encrypt: () => { encryptions++; return {}; }, decrypt: () => ({}), rewrap: value => value };
		const guarded = createProviderAssignmentService(store, undefined, store, envelopes);
		for (const patch of [{ leaseToken: undefined }, { leaseToken: '' }, { leaseToken: 'foreign-lease' },
			{ runnerId: undefined }, { runnerId: 'foreign-runner' }, { sequence: -1 }, { sequence: '0' }]) {
			const body = { ...original, ...patch }, before = structuredClone(body); let cause: unknown;
			try { await guarded.createEvent(auth, assignment.id, body); } catch (error) { cause = error; }
			expect(cause).toMatchObject({ status: Object.hasOwn(patch, 'sequence') ? 400 : 409 });
			expect(encryptions).toBe(0); expect(writes).toEqual([]); expect(body).toEqual(before);
		}
		for (const protectedPayload of [undefined, null, '', false, 0, [], {}]) {
			const body = { ...original, protectedPayload }, before = structuredClone(body);
			await expect(guarded.createEvent(auth, assignment.id, body)).rejects.toMatchObject({ status: 400 });
			expect(encryptions).toBe(0); expect(writes).toEqual([]); expect(body).toEqual(before);
		}
		for (const patch of [{ leaseState: 'released' }, { status: 'returned' }, { leaseExpiresAt: '' },
			{ leaseExpiresAt: 'malformed' }, { leaseExpiresAt: new Date(Date.now() - 1).toISOString() },
			{ membershipId: 'foreign-membership' }, { teamId: 'foreign-team' }]) {
			const before = structuredClone(assignment); Object.assign(assignment, patch); const held = structuredClone(assignment);
			try {
				await expect(guarded.createEvent(auth, assignment.id, original)).rejects.toMatchObject({ status: Object.hasOwn(patch, 'teamId') || Object.hasOwn(patch, 'membershipId') ? 403 : 409 });
				expect(assignment).toEqual(held); expect(encryptions).toBe(0); expect(writes).toEqual([]);
			} finally { Object.assign(assignment, before); }
		}
		expect(original.protectedPayload).toEqual({ providerEvents: [{ type: 'original-private-action' }] });
		const publicBody = { id: 'public-observation', eventType: 'provider.execution.started', component: 'provider-runner', status: 'active', message: 'Original public observation.' };
		await service.createEvent(auth, assignment.id, publicBody); expect(writes).toHaveLength(1);
	});
	it('native original event persistence encrypts exact ordinary executor evidence and retains replay conflict and interrupted-write custody without plaintext public events or financial writes', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'api-executor-diagnostics-'));
		let f: Awaited<ReturnType<typeof workdayStartDatabase>> | undefined;
		try {
			const key = join(directory, 'diagnostics.key'); await writeFile(key, randomBytes(32).toString('base64url'), { mode: 0o600 });
			const keyBytes = await readFile(key), envelopes = createDiagnosticEnvelopeService({ diagnosticsEncryptionKeyFile: key });
			f = await workdayStartDatabase(); const receipt = await f.preflight();
			let schedulingFailure: unknown;
			const schedule = f.store.scheduleCapacityWorkdayRun.bind(f.store);
			f.store.scheduleCapacityWorkdayRun = async run => {
				try { return await schedule(run); } catch (cause) { schedulingFailure = cause; throw cause; }
			};
			const run = await f.start(receipt).catch(async cause => {
				const failures = await f!.all('SELECT status,error_json FROM capacity_workday_runs ORDER BY id');
				throw new Error(`Original planning start failed: ${JSON.stringify(failures)}; ${schedulingFailure instanceof Error ? schedulingFailure.stack : String(schedulingFailure)}`, { cause });
			});
			const runId = run.workdayId, createdAt = new Date().toISOString();
			const attempt = assignmentAttemptSchema.parse({ ...frozenAttempt, status: 'leased', workdayId: runId,
				createdAt, deadline: new Date(Date.parse(createdAt) + frozenAttempt.limits.maximumSeconds * 1000).toISOString() });
			// Controlled existing executor input is required by the original native
			// FK; it is not an advertised offer or qualification receipt.
			await f.query(`INSERT INTO capacity_execution_providers (id,capacity_provider_id,display_name,adapter,native_unit,max_concurrent_runners,created_at,updated_at)
				VALUES (?,?,?,?,?,?,?,?)`, [attempt.provider.executionProviderId, 'provider', 'Original controlled executor', 'controlled-input', 'tokens', 1, createdAt, createdAt]);
			await f.query(`INSERT INTO capacity_reservations (id,idempotency_key,admission_token,membership_id,capacity_provider_id,
				project_agent_class_id,assignment_id,mode,team_id,project_id,work_day_id,requested_seconds,reserved_seconds,created_at,updated_at)
				VALUES (?,?,?,?,?,?,?,'acting',?,?,?,?,?,?,?)`, [attempt.reservationId, 'original-diagnostics-reservation', 'controlled-reservation-input',
					'membership', 'provider', 'class', attempt.id, 'team', 'project', runId, attempt.limits.maximumSeconds, attempt.limits.maximumSeconds, createdAt, createdAt]);
			await f.query(`INSERT INTO capacity_provider_assignments (id,team_id,project_id,membership_id,capacity_provider_id,
				project_agent_class_id,work_day_id,execution_provider_id,mode,status,lease_state,lease_token,runner_id,lease_expires_at,
				attempt_count,assignment_attempt_json,capacity_envelope_json,created_at,updated_at,reservation_id,execution_node_id,execution_node_revision,graph_revision)
				VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [attempt.id, 'team', 'project', 'membership', 'provider', 'class',
				runId, attempt.provider.executionProviderId, 'acting', 'leased', 'leased', 'original-lease', 'original-runner', attempt.deadline,
				attempt.attempt, JSON.stringify(attempt), JSON.stringify({ teamId: 'team', projectId: 'project', mode: 'acting', workDayId: runId,
					projectAgentClassId: 'class', capacityProviderId: attempt.provider.providerId, executionProviderId: attempt.provider.executionProviderId,
					reservationId: attempt.reservationId }), createdAt, createdAt, attempt.reservationId, attempt.nodeId, attempt.nodeRevision, attempt.graphRevision]);
			const service = createProviderAssignmentService(f.store, undefined, f.store, envelopes);
			const auth = { principal: { teamId: 'team', capacityProviderId: 'provider', membershipId: 'membership', scopes: ['provider:assignments:write'] } };
			const body = { id: 'original-protected-event', eventType: 'provider.execution.completed', component: 'execution-provider', status: 'completed',
				createdAt, message: 'Original executor completed.', leaseToken: 'original-lease', runnerId: 'original-runner', sequence: 0,
				context: { sandboxId: 'original-sandbox' }, protectedPayload: { providerEvents: [{ type: 'original-private-action', item: { id: 'original-action' } }] } };
			const original = structuredClone(body), before = await f.snapshot();
			const first = await service.createEvent(auth, attempt.id, body);
			const rows = await f.all('SELECT * FROM capacity_workday_events WHERE assignment_id=? ORDER BY event_index', [attempt.id]);
			expect(rows).toHaveLength(1); const metadata = JSON.parse(String(rows[0]!.metadata_json));
			const envelope = encryptedEnvelopeSchema.parse(metadata.protectedPayloadEnvelope);
			expect(envelope.aad).toMatchObject({ purpose: 'diagnostics', teamId: 'team', assignmentId: attempt.id,
				resourceId: String(rows[0]!.id), sequence: 0, eventType: body.eventType });
			expect(envelopes.decrypt(envelope)).toEqual(body.protectedPayload);
			expect(JSON.stringify(rows).includes('original-private-action')).toBe(false);
			const publicEvents = await f.store.listCapacityWorkdayEventsPage('team', runId);
			expect(JSON.stringify(publicEvents).includes('original-private-action')).toBe(false);
			const retained = await f.snapshot();
			for (const name of ['assignments', 'reservations', 'usage', 'ledger', 'nodes', 'edges', 'revisions'] as const) expect(retained[name]).toEqual(before[name]);
			expect(await service.createEvent(auth, attempt.id, body)).toEqual(first); expect(await f.snapshot()).toEqual(retained);
			await expect(service.createEvent(auth, attempt.id, { ...body, protectedPayload: { providerEvents: [{ type: 'substituted-private-action' }] } }))
				.rejects.toMatchObject({ status: 409, code: 'capacity_workday_event_idempotency_conflict' });
			expect(await f.snapshot()).toEqual(retained);
			await f.db.exec("CREATE FUNCTION original_diagnostic_write_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'original diagnostic interruption'; END $$; CREATE TRIGGER original_diagnostic_write_failure BEFORE INSERT ON capacity_workday_events FOR EACH ROW EXECUTE FUNCTION original_diagnostic_write_failure();");
			const retryBody = { ...body, id: 'interrupted-protected-event', sequence: 1 };
			await expect(service.createEvent(auth, attempt.id, retryBody)).rejects.toThrow('original diagnostic interruption');
			expect(await f.snapshot()).toEqual(retained);
			await f.db.exec('DROP TRIGGER original_diagnostic_write_failure ON capacity_workday_events; DROP FUNCTION original_diagnostic_write_failure();');
			expect(await f.all("SELECT tgname FROM pg_trigger WHERE tgname='original_diagnostic_write_failure'")).toEqual([]);
			await service.createEvent(auth, attempt.id, retryBody);
			expect(await f.all('SELECT * FROM capacity_workday_events WHERE id=?', [rows[0]!.id])).toEqual(rows);
			const retried = await f.all('SELECT * FROM capacity_workday_events WHERE assignment_id=? ORDER BY event_index', [attempt.id]);
			expect(retried).toHaveLength(2);
			const recovered = encryptedEnvelopeSchema.parse(JSON.parse(String(retried[1]!.metadata_json)).protectedPayloadEnvelope);
			expect(recovered.aad).toMatchObject({ resourceId: retried[1]!.id, assignmentId: attempt.id, sequence: 1 });
			expect(envelopes.decrypt(recovered)).toEqual(retryBody.protectedPayload);
			expect(JSON.stringify(retried).includes('original-private-action')).toBe(false);
			const concurrent = { ...body, id: 'concurrent-protected-event', sequence: 2 };
			const substituted = { ...concurrent, protectedPayload: { providerEvents: [{ type: 'concurrent-substituted-action' }] } };
			const competing = await Promise.allSettled([service.createEvent(auth, attempt.id, concurrent), service.createEvent(auth, attempt.id, substituted)]);
			expect(competing.filter(value => value.status === 'fulfilled')).toHaveLength(1);
			const rejected = competing.find(value => value.status === 'rejected');
			expect(rejected?.status === 'rejected' ? rejected.reason : null).toMatchObject({ status: 409, code: 'capacity_workday_event_idempotency_conflict' });
			const concurrentRows = await f.all('SELECT * FROM capacity_workday_events WHERE id=?', [`provider-runtime:${attempt.id}:${concurrent.id}`]);
			expect(concurrentRows).toHaveLength(1);
			const winner = competing[0]!.status === 'fulfilled' ? concurrent : substituted;
			expect(envelopes.decrypt(encryptedEnvelopeSchema.parse(JSON.parse(String(concurrentRows[0]!.metadata_json)).protectedPayloadEnvelope))).toEqual(winner.protectedPayload);
			const held = await f.snapshot();
			const duplicates = await Promise.all([service.createEvent(auth, attempt.id, winner), service.createEvent(auth, attempt.id, winner)]);
			expect(duplicates[0]).toEqual(duplicates[1]); expect(await f.snapshot()).toEqual(held);
			for (const name of ['assignments', 'reservations', 'usage', 'ledger', 'nodes', 'edges', 'revisions'] as const) expect(held[name]).toEqual(before[name]);
			expect(body).toEqual(original); expect((await readFile(key)).equals(keyBytes)).toBe(true);
			expect(Date.now()).toBeLessThanOrEqual(Date.parse(attempt.deadline));
		} finally { try { await f?.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
	});
	it('uses the canonical durable assignment field when metadata does not duplicate it', () => {
		expect(assignmentWorkdayRunId({ workDayId: 'workday-run-1', metadata: {} })).toBe('workday-run-1');
	});

	it('does not recover a workday from retired metadata', () => {
		expect(assignmentWorkdayRunId({ metadata: { workdayRunId: 'workday-run-1' } })).toBeNull();
	});

	it('keeps the durable assignment field authoritative', () => {
		expect(assignmentWorkdayRunId({ workDayId: 'workday-run-2', metadata: { workdayRunId: 'stale-run' } })).toBe('workday-run-2');
	});

	it('records provider runtime events against the durable workday field', async () => {
		const createCapacityWorkdayEvent = vi.fn().mockResolvedValue({ id: 'event-1' });
		const service = createProviderAssignmentService({
			getProviderAssignment: vi.fn().mockResolvedValue({
				id: 'assignment-1', capacityProviderId: 'provider-1', membershipId: 'membership-1', teamId: 'team-1', workDayId: 'workday-run-1', metadata: {},
			}),
			createCapacityWorkdayEvent,
		} as never);
		await service.createEvent({ principal: {
			membershipId: 'membership-1', teamId: 'team-1', capacityProviderId: 'provider-1', scopes: ['provider:assignments:write'],
		} }, 'assignment-1', {
			id: 'event-1', eventType: 'provider.execution.started', component: 'provider-runner', message: 'Execution started.', status: 'active',
		});
		expect(createCapacityWorkdayEvent).toHaveBeenCalledWith('team-1', 'workday-run-1', expect.objectContaining({ assignmentId: 'assignment-1' }));
	});
});
