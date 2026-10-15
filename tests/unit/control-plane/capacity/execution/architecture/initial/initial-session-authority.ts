import { expect } from 'vitest';
import type { initialAdmission } from './initial-admission-fixture.ts';

/** Original owning SQL/transaction/assignment repository, with supplied invalid session rows retained until exact restoration. */
export async function proveInitialSessionDenials(f: Awaited<ReturnType<typeof initialAdmission>>) {
 const input=f.input(),held=structuredClone(input),before=await f.snapshot(),session=(await f.query("SELECT * FROM capacity_provider_availability_sessions WHERE id='session'")).rows[0]!;
 const variants=[{status:'closed'},{status:'draining'},{status:'expired'},{status:'unknown'},{membership_id:'foreign'},{team_id:'foreign'},{capacity_provider_id:'foreign'},
  {expires_at:input.now},{expires_at:'invalid'},{available_from:input.assignment.deadline},{available_from:'invalid'},{available_until:input.now},{available_until:'invalid'}];
 for(const changed of variants){const entries=Object.entries(changed);await f.query('UPDATE capacity_provider_availability_sessions SET '+entries.map(([field])=>field+'=?').join(',')+" WHERE id='session'",entries.map(([,value])=>value));const observed=(await f.query("SELECT * FROM capacity_provider_availability_sessions WHERE id='session'")).rows;
  try{await expect(f.admit(input)).rejects.toMatchObject({code:'provider_availability_session_unavailable',status:409});expect(await f.snapshot()).toEqual(before);expect((await f.query("SELECT * FROM capacity_provider_availability_sessions WHERE id='session'")).rows).toEqual(observed);expect(input).toEqual(held);}
  finally{await f.query('UPDATE capacity_provider_availability_sessions SET '+entries.map(([field])=>field+'=?').join(',')+" WHERE id='session'",entries.map(([field])=>session[field]));}
 }
 expect((await f.query("SELECT * FROM capacity_provider_availability_sessions WHERE id='session'")).rows).toEqual([session]);
}
