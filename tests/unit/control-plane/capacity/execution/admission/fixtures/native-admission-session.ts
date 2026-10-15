import { expect } from 'vitest';
import type { AssignmentAttempt } from '@treeseed/sdk/agent-capacity';
import type { createControlPlanePostgresDatabase } from '../../../../../../../src/api/support/control-plane-postgres.ts';
import type { DurableProviderAssignment } from '../../../../../../../src/api/capacity/repositories/capacity/assignments/assignment.ts';
import { eventObserved } from '../../../../realtime/architecture/session-postgres-fixture.ts';

/** Exact original admission under an independent session close; complete database rollback is required. */
export async function proveNativeClosedSessionAdmission(database: ReturnType<typeof createControlPlanePostgresDatabase>, peer: ReturnType<typeof createControlPlanePostgresDatabase>, attempt: AssignmentAttempt, admit: (value:AssignmentAttempt)=>Promise<DurableProviderAssignment>) {
 const snapshot = async () => Object.fromEntries(await Promise.all(['capacity_provider_assignments','capacity_reservations','execution_nodes','treedx_proxy_handles','capacity_workday_events','capacity_admission_counters','capacity_reservation_counter_claims'].map(async table => [table,(await peer.pool.query('SELECT * FROM '+table+' ORDER BY 1')).rows])));
 const before=await snapshot(), held=structuredClone(attempt), session=(await peer.pool.query("SELECT * FROM capacity_provider_availability_sessions WHERE id='session'")).rows[0]!;
 const lock=await peer.pool.connect(); let pending:Promise<unknown>|undefined;
 try {
  await lock.query('BEGIN'); await lock.query("UPDATE capacity_provider_availability_sessions SET status='closed',closed_at=$1 WHERE id='session'",[attempt.createdAt]);
  pending=admit(attempt).then(value=>({value}),error=>({error}));
  await eventObserved(async () => (await peer.pool.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%capacity_provider_availability_sessions%'")).rows.length>0,Date.now()+5_000);
  await lock.query('COMMIT');
  expect(await pending).toMatchObject({error:{code:'provider_availability_session_unavailable',status:409}}); pending=undefined;
  expect(await snapshot()).toEqual(before); expect(attempt).toEqual(held);
  await expect(admit(attempt)).rejects.toMatchObject({code:'provider_availability_session_unavailable',status:409});
  expect(await snapshot()).toEqual(before);
 } finally {
  await lock.query('ROLLBACK'); lock.release(); if(pending)await pending;
  await peer.pool.query("UPDATE capacity_provider_availability_sessions SET status=$1,closed_at=$2 WHERE id='session'",[session.status,session.closed_at]);
 }
 expect((await peer.pool.query("SELECT * FROM capacity_provider_availability_sessions WHERE id='session'")).rows).toEqual([session]);
}
