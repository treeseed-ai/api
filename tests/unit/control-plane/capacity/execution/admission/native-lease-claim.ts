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
  const results = await Promise.all(owners.map((owner, index) => owner.leaseNextProviderAssignment(principal,
    { ...request, runnerId: index === 0 ? request.runnerId : 'native-lease-second' })));
  const winners = results.filter(result => result.assignment); expect(winners).toHaveLength(1);
  const winner = winners[0]!;
  expect(winner.assignment).toMatchObject({ id: attempt.id, leaseState: 'leased', status: 'leased', assignmentAttempt: { ...attempt, status: 'leased' } });
  expect(winner.leaseToken).toEqual(expect.any(String)); expect(winner.leaseToken).not.toBe('');
  for (const result of results.filter(value => !value.assignment)) expect(result.leaseToken).toBeNull();
  for (const owner of owners) {
    const read = await new ProviderAssignmentRepository(owner).get(attempt.teamId, attempt.id);
    expect(read?.leaseToken).toBe(winner.leaseToken); expect(read?.runnerId).toBe(winner.assignment?.runnerId);
    expect(read?.assignmentAttempt).toEqual({ ...attempt, status: 'leased' });
  }
  const after = await custody();
  expect(after).toEqual({ ...original, attempts: [{ ...original.attempts[0],
    assignment_attempt_json: JSON.stringify({ ...attempt, status: 'leased' }), lease_state: 'leased',
    lease_token: winner.leaseToken, runner_id: winner.assignment?.runnerId }] });
  expect(await owners[0]!.leaseNextProviderAssignment(principal, request)).toMatchObject({ assignment: null, leaseToken: null });
  expect(await custody()).toEqual(after); expect({ principal, request, attempt }).toEqual(held); expect(failed).toEqual(retainedFailure);
  if (failed && typeof failed === 'object' && 'audit' in failed && Array.isArray(failed.audit)) {
    const audit = (await peer.pool.query('SELECT * FROM capacity_audit_events ORDER BY id')).rows;
    for (const row of failed.audit) expect(audit).toContainEqual(row);
  }
  console.log(JSON.stringify({ nativeLeaseClaimFailedObservation: failed, winningAssignmentId: winner.assignment?.id, competingClaims: results.length }));
}
