import { readFileSync } from 'node:fs';
import { splitPostgresSqlStatements } from '../../../../../../../src/api/persistence/postgres-sql-statements.ts';
import { executePostgresBatch } from '../../../../../../../src/api/support/control-plane-postgres.ts';
import { CapacityWorkdayEventRepository } from '../../../../../../../src/api/capacity/repositories/capacity/workdays/workday-event.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workspaceId } from '../../architecture/workspace-cleanup-fixture.ts';
import { principal, report, returnedCompletion, fixture, returnFixture, completionFixture } from './terminal-report-fixture.ts';
import { cancellationDatabase } from '../../architecture/cancellation-fixture.ts';
import { emptyCapacityBudget } from '@treeseed/sdk/agent-capacity';
import { startAssignmentExecutionWindow, startAssignmentCloseoutWindow } from '../../../../../../../src/api/capacity/services/capacity/assignments/lifecycle/assignment-execution-window-service.ts';

// REAL owning SQL/transaction boundary with supplied clocks and usage.
afterEach(() => vi.useRealTimers());
describe('provider terminal reporting through original transaction and resource custody', () => {
 it('native terminal observation rolls back a zero-row assignment update and retains original accounting before exact retry',async()=>{
  const native=await completionFixture();try{
   const ddl=splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0000_control_plane.sql','utf8')).filter(sql=>sql.startsWith('CREATE TABLE "capacity_workday_events" ('));expect(ddl).toHaveLength(1);await native.db.exec(ddl[0]!);
   const before={state:await native.snapshot(),graph:(await native.query('SELECT * FROM execution_graph_revisions ORDER BY revision')).rows,workdays:(await native.query('SELECT * FROM capacity_workday_runs ORDER BY id')).rows,events:(await native.query('SELECT * FROM capacity_workday_events ORDER BY event_index')).rows};
   await native.db.exec("CREATE FUNCTION native_terminal_zero_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='completed' THEN RETURN NULL; END IF; RETURN NEW; END $$");
   await native.db.exec('CREATE TRIGGER native_terminal_zero_write BEFORE UPDATE ON capacity_provider_assignments FOR EACH ROW EXECUTE FUNCTION native_terminal_zero_write()');
   const input={leaseToken:'lease-token',activeSeconds:1,elapsedSeconds:2,completion:returnedCompletion,output:{assignmentResult:native.result}},held=structuredClone(input);
   let failure:unknown;try{await native.service.complete(principal,native.assignment.id,input);}catch(error){failure=error;}
   finally{await native.db.exec('DROP TRIGGER native_terminal_zero_write ON capacity_provider_assignments');await native.db.exec('DROP FUNCTION native_terminal_zero_write()');}
   const observed={state:await native.snapshot(),graph:(await native.query('SELECT * FROM execution_graph_revisions ORDER BY revision')).rows,workdays:(await native.query('SELECT * FROM capacity_workday_runs ORDER BY id')).rows,events:(await native.query('SELECT * FROM capacity_workday_events ORDER BY event_index')).rows};
   console.log(JSON.stringify({nativeTerminalZeroWrite:{status:(await native.repository.get('team',native.assignment.id))?.status,eventCount:observed.events.length}}));
   expect(failure).toMatchObject({message:'assignment_terminal_observation_state_mismatch'});expect(observed).toEqual(before);expect(input).toEqual(held);
   expect((await native.service.complete(principal,native.assignment.id,input))?.assignment.status).toBe('completed');
   expect((await native.query('SELECT * FROM capacity_workday_events WHERE assignment_id=?',[native.assignment.id])).rows).toHaveLength(1);
  }finally{await native.close();}
 });

	it('native execution start records the original canonical running clock once and closeout cannot rewrite it or frozen authority', async () => {
		const native = await cancellationDatabase('leased', false);
		try {
			const ddl=splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0000_control_plane.sql','utf8')).filter(sql=>sql.startsWith('CREATE TABLE "capacity_workday_events" ('));expect(ddl).toHaveLength(1);await native.db.exec(ddl[0]!);
			const owner={...native.owner,db:{transaction:async<T>(apply:(client:Parameters<typeof executePostgresBatch>[0])=>Promise<T>)=>native.db.transaction(transaction=>apply(transaction as unknown as Parameters<typeof executePostgresBatch>[0]))}};
			const startedAt = '2026-10-02T21:00:00.500Z', budget = emptyCapacityBudget(native.attempt.deadline, 3);
			const envelope = { ...native.assignment.capacityEnvelope, budget: { ...budget, time: { ...budget.time,
				executionSeconds: 3, closeoutSeconds: 1, authorityDeadlineAt: native.attempt.deadline,
				preparationDeadlineAt: native.attempt.deadline } } };
			await native.query('UPDATE capacity_provider_assignments SET capacity_envelope_json=? WHERE id=?',
				[JSON.stringify(envelope), native.assignment.id]);
			const input = { leaseToken: 'lease-token', expectedStateVersion: native.assignment.stateVersion,
				idempotencyKey: 'canonical-execution-start' }, original = structuredClone(input);
			const provider = { ...principal, scopes: ['provider:assignments:write'] };

			const proveInterruptedObservation=async(phase:'execution'|'closeout',invoke:()=>Promise<unknown>)=>{
				const snapshot=async()=>({state:await native.snapshot(),runs:(await native.query('SELECT * FROM capacity_workday_runs ORDER BY id')).rows,events:(await native.query('SELECT * FROM capacity_workday_events ORDER BY event_index')).rows});
				const original=await snapshot();
				await native.db.exec(`CREATE FUNCTION native_phase_observation_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='assignment.${phase}.started' THEN RAISE EXCEPTION 'original native phase observation interrupted'; END IF;RETURN NEW;END $$;
				 CREATE TRIGGER native_phase_observation_failure BEFORE INSERT ON capacity_workday_events FOR EACH ROW EXECUTE FUNCTION native_phase_observation_failure();`);
				try{await expect(invoke()).rejects.toThrow('original native phase observation interrupted');expect(await snapshot()).toEqual(original);}
				finally{await native.db.exec('DROP TRIGGER native_phase_observation_failure ON capacity_workday_events;DROP FUNCTION native_phase_observation_failure();');}
			};


			await proveInterruptedObservation('execution',()=>startAssignmentExecutionWindow(owner,provider,native.assignment.id,input,startedAt));
			const started = await startAssignmentExecutionWindow(owner, provider, native.assignment.id, input, startedAt);
			expect(started.assignmentAttempt).toEqual({ ...native.attempt, status: 'running', startedAt });
			const rawEvents=async()=>(await native.query('SELECT * FROM capacity_workday_events ORDER BY event_index')).rows;
			const executionEvents=await rawEvents();expect(executionEvents).toHaveLength(1);expect(executionEvents[0]).toMatchObject({assignment_id:native.assignment.id,run_id:native.attempt.workdayId,event_type:'assignment.execution.started',created_at:startedAt});
			const publicEvents=await new CapacityWorkdayEventRepository(owner).list('team',native.attempt.workdayId);expect(publicEvents.items).toHaveLength(1);expect(publicEvents.items[0]).toMatchObject({eventType:'assignment.execution.started',assignmentId:native.assignment.id,createdAt:startedAt});
			const running = await native.snapshot();
			await expect(startAssignmentExecutionWindow(owner, { ...provider, membershipId: 'foreign' },
				native.assignment.id, input, '2026-10-02T21:00:01.000Z')).rejects.toMatchObject({ status: 403 });
			await expect(startAssignmentExecutionWindow(owner, provider, native.assignment.id,
				{ ...input, leaseToken: 'foreign' }, '2026-10-02T21:00:01.000Z')).rejects.toMatchObject({ code: 'assignment_execution_lease_invalid' });
			const replay = await startAssignmentExecutionWindow(owner, provider, native.assignment.id, input,
				'2026-10-02T21:00:01.000Z');
			expect(replay).toEqual(started); expect(await native.snapshot()).toEqual(running);expect(await rawEvents()).toEqual(executionEvents);
			await proveInterruptedObservation('closeout',()=>startAssignmentCloseoutWindow(owner,provider,native.assignment.id,{...input,expectedStateVersion:started.stateVersion,idempotencyKey:'canonical-closeout'},'2026-10-02T21:00:02.000Z'));
			const closed = await startAssignmentCloseoutWindow(owner, provider, native.assignment.id,
				{ ...input, expectedStateVersion: started.stateVersion, idempotencyKey: 'canonical-closeout' }, '2026-10-02T21:00:02.000Z');
			const closeoutEvents=await rawEvents();expect(closeoutEvents).toHaveLength(2);expect(closeoutEvents[1]).toMatchObject({assignment_id:native.assignment.id,event_type:'assignment.closeout.started',created_at:'2026-10-02T21:00:02.000Z'});
			const finalPublic=await new CapacityWorkdayEventRepository(owner).list('team',native.attempt.workdayId);expect(finalPublic.items).toHaveLength(2);for(const event of closeoutEvents){const visible=finalPublic.items.find(value=>value.id===event.id);expect(visible).toMatchObject({eventType:event.event_type,assignmentId:event.assignment_id,workdayId:event.workday_id,projectId:event.project_id,createdAt:event.created_at,context:JSON.parse(String(event.context_json)),parameters:{},metadata:{},refs:{}});}expect(JSON.stringify(finalPublic)).not.toContain('lease-token');
			expect(closed.assignmentAttempt).toEqual(started.assignmentAttempt);
			expect(closed.assignmentAttempt?.deadline).toBe(native.attempt.deadline);
			expect(input).toEqual(original);
			expect((await native.query('SELECT COUNT(*) AS total FROM capacity_ledger_entries')).rows).toEqual([{ total: 0 }]);
		} finally { await native.db.close(); }
	});
	it('native terminal transitions persist canonical lifecycle metadata with exact frozen authority and immutable replay', async () => {
		for (const status of ['completed', 'failed', 'cancelled', 'returned'] as const) {
			const native = status === 'returned' ? await returnFixture() : await completionFixture();
			try {
                const ddl=splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0000_control_plane.sql','utf8')).filter(sql=>sql.startsWith('CREATE TABLE "capacity_workday_events" ('));expect(ddl).toHaveLength(1);await native.db.exec(ddl[0]!);

				if (status === 'cancelled') await native.query('UPDATE capacity_provider_assignments SET metadata_json=? WHERE id=?',
					[JSON.stringify({ ...native.assignment.metadata, cancellationRequested: true }), native.assignment.id]);
				const before = await native.repository.get('team', native.assignment.id);
				if (!before?.assignmentAttempt) throw new Error('Missing complete native canonical attempt');
				const input = { leaseToken: 'lease-token', activeSeconds: 1, elapsedSeconds: 2,
					completion: returnedCompletion, ...(status === 'completed' && 'result' in native
						? { output: { assignmentResult: native.result } } : {}) }, original = structuredClone(input);
				const transition = () => status === 'completed' ? native.service.complete(principal, before.id, input)
					: status === 'failed' ? native.service.fail(principal, before.id, { ...input, retryable: false })
						: native.service.return(principal, before.id, input);
				const result = await transition(), persisted = await native.repository.get('team', before.id);
				const expected = { ...before.assignmentAttempt, status: status === 'returned' ? 'blocked' : status,
					finishedAt: '2026-10-02T21:00:02.000Z' };
				expect(result?.assignment.status).toBe(status);
				expect(result?.assignment.assignmentAttempt).toEqual(expected);
				expect(persisted?.assignmentAttempt).toEqual(expected);
				const raw = (await native.query('SELECT assignment_attempt_json FROM capacity_provider_assignments WHERE id=?', [before.id])).rows[0];
				expect(JSON.parse(String(raw?.assignment_attempt_json))).toEqual(expected);
				expect(persisted?.attemptCount).toBe(before.attemptCount);
                const observations=(await native.query('SELECT * FROM capacity_workday_events WHERE assignment_id=? ORDER BY event_index',[before.id])).rows;
                expect(observations,'every original terminal transition requires exactly one durable scoped observation').toHaveLength(1);
                const event=observations[0]!;expect(event).toMatchObject({team_id:before.teamId,run_id:before.workDayId,workday_id:before.workDayId,project_id:before.projectId,assignment_id:before.id,event_type:'assignment.'+status,status:'recorded',created_at:expected.finishedAt});
                expect(JSON.parse(String(event.context_json))).toMatchObject({nodeId:before.assignmentAttempt.nodeId,nodeRevision:before.assignmentAttempt.nodeRevision,graphRevision:before.assignmentAttempt.graphRevision,leaseId:before.assignmentAttempt.leaseId,reservationId:before.assignmentAttempt.reservationId,status});
                expect(JSON.stringify(event)).not.toContain('lease-token');
                const events=new CapacityWorkdayEventRepository(native.owner),visible=await events.list(before.teamId,before.workDayId!,{limit:100});
                expect(visible.page).toEqual({limit:100,hasMore:false,nextCursor:null});expect(visible.items.find(value=>value.id===event.id)).toMatchObject({eventType:'assignment.'+status,createdAt:expected.finishedAt,assignmentId:before.id,context:JSON.parse(String(event.context_json))});

				const terminal = await native.snapshot(), graph = (await native.query('SELECT * FROM execution_graph_revisions ORDER BY revision')).rows;
				await expect(transition()).resolves.toBeNull();
				expect(await native.snapshot()).toEqual(terminal);
				expect((await native.query('SELECT * FROM execution_graph_revisions ORDER BY revision')).rows).toEqual(graph);
                expect((await native.query('SELECT * FROM capacity_workday_events WHERE assignment_id=? ORDER BY event_index',[before.id])).rows).toEqual(observations);
                expect(await events.list(before.teamId,before.workDayId!,{limit:100})).toEqual(visible);
				expect(input).toEqual(original);
				expect((await native.query('SELECT COUNT(*) AS total FROM capacity_ledger_entries')).rows).toEqual([{ total: 1 }]);
			} finally { await native.close(); }
		}
	});
	it('denies completed result clocks outside the immutable attempt and actual reporting interval without state mutation', async () => {
		const observations: boolean[] = [];
		for (const clock of ['2026-10-02T20:59:59.000Z', '2026-10-02T21:00:02.001Z', '2026-10-02T21:00:04.000Z']) {
			const native = await completionFixture();
			try {
				const before = await native.snapshot(), graph = (await native.query('SELECT * FROM execution_graph_revisions ORDER BY revision')).rows;
				const input = { leaseToken: 'lease-token', activeSeconds: 1, elapsedSeconds: 2,
					output: { assignmentResult: { ...native.result, completedAt: clock } } }, original = structuredClone(input);
				let denied = false;
				try { denied = await native.service.complete(principal, native.assignment.id, input) === null; } catch { denied = true; }
				observations.push(denied && JSON.stringify(await native.snapshot()) === JSON.stringify(before)
					&& JSON.stringify((await native.query('SELECT * FROM execution_graph_revisions ORDER BY revision')).rows) === JSON.stringify(graph));
				expect(input).toEqual(original);
			} finally { await native.close(); }
		}
		expect(observations).toEqual([true, true, true]);
	});
	it('retains canonical completed result after public exactly-once settlement and replays without another charge', async () => {
		const native = await completionFixture();
		try {
			const settled = await native.snapshot(), nodes = (await native.query('SELECT * FROM execution_nodes ORDER BY id')).rows,
				revisions = (await native.query('SELECT * FROM execution_graph_revisions ORDER BY revision')).rows;
			for (const field of ['id', 'assignmentId'] as const) for (const nested of [false, true]) {
				const changed = { ...native.result, [field]: ` ${native.result[field]} ` }, invalid = {
					leaseToken: 'lease-token', activeSeconds: 1, elapsedSeconds: 2,
					...(nested ? { output: { assignmentResult: changed } } : { assignmentResult: changed }) };
				const supplied = structuredClone(invalid);
				await expect(native.service.complete(principal, native.assignment.id, invalid)).rejects.toMatchObject({ code: 'assignment_result_invalid' });
				expect(invalid).toEqual(supplied); expect(await native.snapshot()).toEqual(settled);
				expect((await native.query('SELECT * FROM execution_nodes ORDER BY id')).rows).toEqual(nodes);
				expect((await native.query('SELECT * FROM execution_graph_revisions ORDER BY revision')).rows).toEqual(revisions);
			}
			const input = { leaseToken: 'lease-token', activeSeconds: 1, elapsedSeconds: 2,
				usage: { inputTokens: 7, nativeUsage: { activeSeconds: 1, tokens: 7 } }, output: { assignmentResult: native.result } }, original = structuredClone(input);
			const result = await native.service.complete(principal, native.assignment.id, input);
			expect(result?.assignment.status).toBe('completed'); expect(result?.assignment.assignmentResult).toEqual(native.result);
			const terminal = await native.snapshot();
			await expect(native.service.complete(principal, native.assignment.id, input)).resolves.toBeNull();
			expect(await native.snapshot()).toEqual(terminal); expect(input).toEqual(original);
			expect({ usage: (await native.query('SELECT active_seconds,elapsed_seconds FROM capacity_usage_actuals')).rows,
				ledger: (await native.query('SELECT COUNT(*) AS total FROM capacity_ledger_entries')).rows,
				reservation: (await native.query("SELECT state FROM capacity_reservations WHERE id='reservation'")).rows })
				.toEqual({ usage: [{ active_seconds: 1, elapsed_seconds: 2 }], ledger: [{ total: 1 }], reservation: [{ state: 'consumed' }] });
		} finally { await native.close(); }
	});
	it('denies completion before public settlement without creating a result or rewriting financial authority', async () => {
		const native = await completionFixture(false);
		try {
			const before = await native.snapshot();
			await expect(native.service.complete(principal, native.assignment.id, { leaseToken: 'lease-token',
				output: { assignmentResult: native.result } })).resolves.toBeNull();
			expect(await native.snapshot()).toEqual(before);
		} finally { await native.close(); }
	});
	it('denies noncompleted result status and wrong completion owner token or deadline without changing stored authority', async () => {
		const native = await completionFixture();
		try {
			const before = await native.snapshot(), input = { leaseToken: 'lease-token', output: { assignmentResult: native.result } };
			for (const status of ['blocked', 'failed'] as const) for (const nested of [false, true]) {
				const assignmentResult = { ...native.result, status }, supplied = { leaseToken: input.leaseToken,
					...(nested ? { output: { assignmentResult } } : { assignmentResult }) }, original = structuredClone(supplied);
				await expect(native.service.complete(principal, native.assignment.id, supplied))
					.rejects.toMatchObject({ code: 'assignment_content_result_invalid' });
				expect(supplied).toEqual(original); expect(await native.snapshot()).toEqual(before);
			}
			for (const completedAt of [undefined, 'invalid'])
				await expect(native.service.complete(principal, native.assignment.id, { ...input, output: { assignmentResult: { ...native.result, completedAt } } }))
					.rejects.toMatchObject({ code: 'assignment_result_invalid' });
			for (const owner of [{ ...principal, membershipId: 'foreign' }, { ...principal, capacityProviderId: 'foreign' }])
				await expect(native.service.complete(owner, native.assignment.id, input)).resolves.toBeNull();
			await expect(native.service.complete(principal, native.assignment.id, { ...input, leaseToken: 'foreign' })).resolves.toBeNull();
			vi.setSystemTime(new Date(native.attempt.deadline));
			await expect(native.service.complete(principal, native.assignment.id, input)).resolves.toBeNull();
			expect(await native.snapshot()).toEqual(before);
		} finally { await native.close(); }
	});
	it('advances the retryable returned node revision without rewriting its historical assignment attempt', async () => {
		const native = await returnFixture();
		try {
			const before = (await native.repository.get('team', native.assignment.id))!;
			const input = { leaseToken: 'lease-token', code: 'provider_assignment_returned',
				activeSeconds: 1, elapsedSeconds: 2, completion: returnedCompletion }, original = structuredClone(input);
			const result = await native.service.return(principal, before.id, input);
			const node = (await native.query('SELECT status,node_revision FROM execution_nodes WHERE id=?', [native.attempt.nodeId])).rows[0];
			expect(result?.assignment.status).toBe('returned'); expect(input).toEqual(original);
			expect(result?.assignment.assignmentAttempt).toEqual({ ...before.assignmentAttempt,
				status: 'blocked', finishedAt: '2026-10-02T21:00:02.000Z' });
			expect({ ordinal: result?.assignment.attemptCount, node }).toEqual({ ordinal: before.attemptCount,
				node: { status: 'ready', node_revision: native.attempt.nodeRevision + 1 } });
		} finally { await native.close(); }
	});
	it('settles measured returned work exactly once and releases its consumed reservation before another attempt', async () => {
		const native = await returnFixture();
		try {
			const input = { leaseToken: 'lease-token', activeSeconds: 1, elapsedSeconds: 2,
				usage: { inputTokens: 7, nativeUsage: { activeSeconds: 1, tokens: 7 } }, completion: returnedCompletion };
			expect((await native.service.return(principal, native.assignment.id, input))?.assignment.status).toBe('returned');
			const observations = {
				usage: (await native.query('SELECT active_seconds,elapsed_seconds FROM capacity_usage_actuals')).rows,
				ledger: (await native.query('SELECT COUNT(*) AS total FROM capacity_ledger_entries')).rows,
				reservation: (await native.query('SELECT state FROM capacity_reservations WHERE id=\'reservation\'')).rows,
			};
			const beforeReplay = await native.snapshot();
			await expect(native.service.return(principal, native.assignment.id, input)).resolves.toBeNull();
			expect(await native.snapshot()).toEqual(beforeReplay);
			expect(observations).toEqual({ usage: [{ active_seconds: 1, elapsed_seconds: 2 }],
				ledger: [{ total: 1 }], reservation: [{ state: 'consumed' }] });
		} finally { await native.close(); }
	});
	it('retains wrong-owner token and expired-return denials without changing graph or financial authority', async () => {
		const native = await returnFixture();
		try {
			const before = await native.snapshot(), graph = (await native.query('SELECT * FROM execution_nodes ORDER BY id')).rows;
			const input = { leaseToken: 'lease-token', activeSeconds: 1, elapsedSeconds: 2, completion: returnedCompletion };
			for (const owner of [{ ...principal, membershipId: 'foreign' }, { ...principal, capacityProviderId: 'foreign' }])
				await expect(native.service.return(owner, native.assignment.id, input)).resolves.toBeNull();
			await expect(native.service.return(principal, native.assignment.id, { ...input, leaseToken: 'foreign' })).resolves.toBeNull();
			vi.setSystemTime(new Date(native.attempt.deadline));
			await expect(native.service.return(principal, native.assignment.id, input)).resolves.toBeNull();
			expect(await native.snapshot()).toEqual(before); expect((await native.query('SELECT * FROM execution_nodes ORDER BY id')).rows).toEqual(graph);
		} finally { await native.close(); }
	});
	it('commits one returned transition and graph revision for concurrent matching reports and read-only replay', async () => {
		const native = await returnFixture();
		try {
			const input = { leaseToken: 'lease-token', activeSeconds: 1, elapsedSeconds: 2, completion: returnedCompletion };
			const original = structuredClone(input), revisionCount = Number((await native.query('SELECT COUNT(*) AS total FROM execution_graph_revisions')).rows[0]!.total);
			const results = await Promise.all([native.service.return(principal, native.assignment.id, input),
				native.service.return(principal, native.assignment.id, input)]);
			const observations = { transitioned: results.filter(Boolean).length,
				revisions: Number((await native.query('SELECT COUNT(*) AS total FROM execution_graph_revisions')).rows[0]!.total) - revisionCount };
			const terminal = await native.snapshot(), graph = (await native.query('SELECT * FROM execution_graph_revisions ORDER BY revision')).rows;
			await expect(native.service.return(principal, native.assignment.id, input)).resolves.toBeNull();
			expect(input).toEqual(original); expect(await native.snapshot()).toEqual(terminal);
			expect((await native.query('SELECT * FROM execution_graph_revisions ORDER BY revision')).rows).toEqual(graph);
			expect(observations).toEqual({ transitioned: 1, revisions: 1 });
		} finally { await native.close(); }
	});
	it('preserves the immutable attempt ordinal when a terminal report releases its lease and retains measured settlement', async () => {
		const native = await fixture();
		try {
			const before = (await native.repository.get('team', native.assignment.id))!, input = structuredClone(report);
			const result = await native.service.fail(principal, before.id, report);
			expect(result?.assignment.status).toBe('failed');
			expect(result?.assignment.leaseToken).toBeNull();
			expect((await native.query('SELECT active_seconds,elapsed_seconds FROM capacity_usage_actuals')).rows).toEqual([{ active_seconds: 2, elapsed_seconds: 3 }]);
			expect(report).toEqual(input);
			expect(result?.assignment.assignmentAttempt).toEqual({ ...before.assignmentAttempt,
				status: 'failed', finishedAt: '2026-10-02T21:00:04.000Z' });
			expect(result?.assignment.attemptCount).toBe(before.attemptCount);
		} finally { await native.close(); }
	});
	it('does not certify terminal revocation while the independently read exact workspace remains open', async () => {
		const native = await fixture();
		try {
			const result = await native.service.fail(principal, native.assignment.id, report);
			expect(result?.assignment.status).toBe('failed');
			const handle = (await native.query('SELECT status FROM treedx_proxy_handles')).rows;
			const remote = await native.client.workspaces.get(workspaceId);
			expect({ handle, remote }).toMatchObject({ handle: [{ status: 'revoked' }], remote: { workspaceId, status: 'closed' } });
		} finally { await native.close(); }
	});
	it('retains foreign-owner and wrong-token denials and matching terminal replay without another charge', async () => {
		const native = await fixture();
		try {
			const before = await native.snapshot();
			for (const authority of [{ ...principal, membershipId: 'foreign' }, { ...principal, capacityProviderId: 'foreign' }])
				await expect(native.service.fail(authority, native.assignment.id, report)).resolves.toBeNull();
			await expect(native.service.fail(principal, native.assignment.id, { ...report, leaseToken: 'foreign' })).resolves.toBeNull();
			expect(await native.snapshot()).toEqual(before);
			const matching = await Promise.all([native.service.fail(principal, native.assignment.id, report), native.service.fail(principal, native.assignment.id, report)]);
			expect(matching.filter(Boolean)).toHaveLength(1);
			const terminal = await native.snapshot();
			await expect(native.service.fail(principal, native.assignment.id, report)).resolves.toBeNull();
			expect(await native.snapshot()).toEqual(terminal);
			expect((await native.query('SELECT COUNT(*) AS total FROM capacity_ledger_entries')).rows).toEqual([{ total: 1 }]);
		} finally { await native.close(); }
	});
	it('rolls back a late SQL authority-revocation failure and retries terminal reporting without another settlement charge', async () => {
		const native = await fixture();
		try {
			const before = await native.snapshot(), handle = (await native.query('SELECT * FROM treedx_proxy_handles')).rows;
			await native.db.exec(`CREATE FUNCTION reject_terminal_revoke() RETURNS trigger LANGUAGE plpgsql AS $$
				BEGIN RAISE EXCEPTION 'isolated terminal revocation interruption'; END $$;
				CREATE TRIGGER reject_terminal_revoke BEFORE UPDATE ON treedx_proxy_handles
				FOR EACH ROW EXECUTE FUNCTION reject_terminal_revoke();`);
			await expect(native.service.fail(principal, native.assignment.id, report)).rejects.toThrow('isolated terminal revocation interruption');
			expect(await native.snapshot()).toEqual(before);
			expect((await native.query('SELECT * FROM treedx_proxy_handles')).rows).toEqual(handle);
			await native.db.exec('DROP TRIGGER reject_terminal_revoke ON treedx_proxy_handles; DROP FUNCTION reject_terminal_revoke();');
			expect((await native.service.fail(principal, native.assignment.id, report))?.assignment.status).toBe('failed');
			expect((await native.query('SELECT active_seconds,elapsed_seconds FROM capacity_usage_actuals')).rows).toEqual([{ active_seconds: 2, elapsed_seconds: 3 }]);
			expect((await native.query('SELECT COUNT(*) AS total FROM capacity_ledger_entries')).rows).toEqual([{ total: 1 }]);
		} finally { await native.close(); }
	});
});
