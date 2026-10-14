import { proveNativeAssignmentWindows } from './native-assignment-windows.ts';
import { verifyNativeLeaseHistory, verifyNativeLeaseEventReadback } from '../../../../../acceptance/execution-inventory.ts';
import { CapacityWorkdayEventRepository } from '../../../../../../src/api/capacity/repositories/capacity/workdays/workday-event.ts';
import { expect } from 'vitest';
import type { AssignmentAttempt } from '@treeseed/sdk/agent-capacity';
import type { createControlPlanePostgresDatabase } from '../../../../../../src/api/support/control-plane-postgres.ts';
import { createCapacityControlPlane } from '../../../../../../src/api/capacity/control-plane.ts';
import type { ControlPlaneStore } from '../../../../../../src/api/persistence/store.ts';
import { ProviderAssignmentRepository } from '../../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';

// Extend the original allocated PostgreSQL case. Both pools, store facades and
// lease SQL are real; availability and the already admitted Attempt are inputs.
export async function proveNativeLeaseClaim(
  database: ReturnType<typeof createControlPlanePostgresDatabase>, peer: ReturnType<typeof createControlPlanePostgresDatabase>,
  accounting: ControlPlaneStore, peerAccounting: ControlPlaneStore, attempt: AssignmentAttempt,
) {
  const owners = [accounting, peerAccounting].map(host => {
    const run = host.run.bind(host);
    return createCapacityControlPlane(Object.assign(host, { run: async (sql: string, params: unknown[] = []) => { await run(sql, params); } }));
  });
  const principal = { teamId: attempt.teamId, capacityProviderId: attempt.provider.providerId, membershipId: 'membership' };
  const request = { providerSessionId: 'session', runnerId: 'native-lease-first', leaseSeconds: 30, laneId: 'workday', lanePurpose: 'workday' as const };
  const held = structuredClone({ principal, request, attempt });
  const custody = async () => ({
    attempts: (await peer.pool.query('SELECT id,assignment_attempt_json,lease_state,lease_token,runner_id FROM capacity_provider_assignments ORDER BY id')).rows,
    reservations: (await peer.pool.query('SELECT * FROM capacity_reservations ORDER BY id')).rows,
    counters: (await peer.pool.query('SELECT * FROM capacity_admission_counters ORDER BY id')).rows,
    usage: (await peer.pool.query('SELECT * FROM capacity_usage_actuals ORDER BY id')).rows,
    ledger: (await peer.pool.query('SELECT * FROM capacity_ledger_entries ORDER BY id')).rows,
    nodes: (await peer.pool.query('SELECT * FROM execution_nodes ORDER BY id')).rows,
    events: (await peer.pool.query('SELECT * FROM capacity_workday_events ORDER BY event_index')).rows,
    workdayEventIndex: (await peer.pool.query('SELECT id,next_event_index FROM capacity_workday_runs ORDER BY id')).rows,
  });
  const original = await custody();
  await database.pool.query(`CREATE FUNCTION native_claim_interruption() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.status='leased' THEN RAISE EXCEPTION 'retained native lease claim interruption'; END IF; RETURN NEW; END $$`);
  await database.pool.query('CREATE TRIGGER native_claim_interruption BEFORE UPDATE ON capacity_provider_assignments FOR EACH ROW EXECUTE FUNCTION native_claim_interruption()');
  let failed: unknown;
  try { await owners[0]!.leaseNextProviderAssignment(principal, request); }
  catch (error) { failed = { message: String(error), custody: await custody(), audit: (await peer.pool.query('SELECT * FROM capacity_audit_events ORDER BY id')).rows }; }
  finally {
    await database.pool.query('DROP TRIGGER native_claim_interruption ON capacity_provider_assignments');
    await database.pool.query('DROP FUNCTION native_claim_interruption()');
  }
  expect(failed).toMatchObject({ message: expect.stringContaining('retained native lease claim interruption'), custody: original });
  const retainedFailure = structuredClone(failed);
  await database.pool.query(`CREATE FUNCTION native_observation_interruption() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.event_type='assignment.leased' THEN RAISE EXCEPTION 'retained native lease observation interruption'; END IF; RETURN NEW; END $$`);
  await database.pool.query('CREATE TRIGGER native_observation_interruption BEFORE INSERT ON capacity_workday_events FOR EACH ROW EXECUTE FUNCTION native_observation_interruption()');
  const rawBeforeObservation=(await peer.pool.query('SELECT * FROM capacity_provider_assignments ORDER BY id')).rows;
  let observationFailure:unknown;
  try{await owners[0]!.leaseNextProviderAssignment(principal,request);}
  catch(error){observationFailure={message:String(error),custody:await custody()};}
  finally{await database.pool.query('DROP TRIGGER native_observation_interruption ON capacity_workday_events');await database.pool.query('DROP FUNCTION native_observation_interruption()');}
  expect(observationFailure).toMatchObject({message:expect.stringContaining('retained native lease observation interruption'),custody:original});
  expect((await peer.pool.query('SELECT * FROM capacity_provider_assignments ORDER BY id')).rows).toEqual(rawBeforeObservation);
  const retainedObservationFailure=structuredClone(observationFailure);

  const results = await Promise.all(owners.map((owner, index) => owner.leaseNextProviderAssignment(principal,
    { ...request, runnerId: index === 0 ? request.runnerId : 'native-lease-second' })));
  const winners = results.filter(result => result.assignment); expect(winners).toHaveLength(1);
  const winner = winners[0]!;
  expect(winner.assignment).toMatchObject({ id: attempt.id, leaseState: 'leased', status: 'leased', assignmentAttempt: { ...attempt, status: 'leased' } });
  expect(winner.leaseToken).toEqual(expect.any(String)); expect(winner.leaseToken).not.toBe('');
  const history=(await peer.pool.query("SELECT * FROM capacity_workday_events WHERE assignment_id=$1 AND event_type='assignment.leased' ORDER BY event_index",[attempt.id])).rows;
  expect(history,'native committed lease must have one durable public history observation').toHaveLength(1);
  const event=history[0]!;
  expect(event).toMatchObject({team_id:attempt.teamId,run_id:attempt.workdayId,workday_id:attempt.workdayId,project_id:attempt.projectId,assignment_id:attempt.id,status:'recorded',created_at:winner.assignment!.updatedAt});
  expect(JSON.parse(String(event.context_json))).toMatchObject({nodeId:attempt.nodeId,nodeRevision:attempt.nodeRevision,graphRevision:attempt.graphRevision,status:'leased',leaseId:attempt.leaseId,reservationId:attempt.reservationId,runnerId:winner.assignment!.runnerId});
  expect(JSON.stringify(event)).not.toContain(winner.leaseToken!);
  const publicEvents=await new CapacityWorkdayEventRepository(peerAccounting).list(attempt.teamId,attempt.workdayId,{limit:100});
  expect(publicEvents.items.filter(value=>value.id===event.id)).toHaveLength(1); expect(publicEvents.page).toEqual({limit:100,hasMore:false,nextCursor:null});
  verifyNativeLeaseEventReadback(event,publicEvents.items.find(value=>value.id===event.id));

  for (const result of results.filter(value => !value.assignment)) expect(result.leaseToken).toBeNull();
  for (const owner of owners) {
    const read = await new ProviderAssignmentRepository(owner).get(attempt.teamId, attempt.id);
    expect(read?.leaseToken).toBe(winner.leaseToken); expect(read?.runnerId).toBe(winner.assignment?.runnerId);
    expect(read?.assignmentAttempt).toEqual({ ...attempt, status: 'leased' });
  }
  const after = await custody();
  verifyNativeLeaseHistory((await peer.pool.query('SELECT * FROM capacity_provider_assignments ORDER BY id')).rows,after.events,{id:attempt.workdayId,teamId:attempt.teamId});
  expect(after).toEqual({ ...original, events: [...original.events,...history], workdayEventIndex: original.workdayEventIndex.map(row=>row.id===attempt.workdayId?{...row,next_event_index:Number(row.next_event_index)+1}:row), attempts: [{ ...original.attempts[0],
    assignment_attempt_json: JSON.stringify({ ...attempt, status: 'leased' }), lease_state: 'leased',
    lease_token: winner.leaseToken, runner_id: winner.assignment?.runnerId }] });
  expect(await owners[0]!.leaseNextProviderAssignment(principal, request)).toMatchObject({ assignment: null, leaseToken: null });
  expect(await custody()).toEqual(after); expect({ principal, request, attempt }).toEqual(held); expect(failed).toEqual(retainedFailure);
  expect(observationFailure).toEqual(retainedObservationFailure);
  if (failed && typeof failed === 'object' && 'audit' in failed && Array.isArray(failed.audit)) {
    const audit = (await peer.pool.query('SELECT * FROM capacity_audit_events ORDER BY id')).rows;
    for (const row of failed.audit) expect(audit).toContainEqual(row);
  }
  console.log(JSON.stringify({ nativeLeaseClaimFailedObservation: failed, nativeLeaseObservationFailedObservation: observationFailure, winningAssignmentId: winner.assignment?.id, competingClaims: results.length }));
  return proveNativeAssignmentWindows(database,peer,accounting,peerAccounting,attempt);
}
