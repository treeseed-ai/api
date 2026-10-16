import { describe, expect, it } from 'vitest';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { initialAdmission } from '../../architecture/initial/initial-admission-fixture.ts';

describe('original workday closeout admission authority', () => {
 it('denies a previously prepared productive assignment after its owning plan closes, without creating financial or graph history', async () => {
  const f = await initialAdmission();
  try {
   const input = f.input(), original = structuredClone(input);
   await f.query('UPDATE capacity_workday_runs SET parameters_json=? WHERE id=?',
    [JSON.stringify({ appliedPlan: { ...f.plan, state: 'closing', closingAt: input.now } }), f.plan.id]);
   const held = await f.snapshot();
   await expect(f.admit(input)).rejects.toMatchObject({ code: 'workday_admission_closed', status: 409 });
   expect(await f.snapshot()).toEqual(held); expect(input).toEqual(original);
  } finally { await f.db.close(); }
 });
 it('rejects missing malformed foreign ended and contradictory original workday authority without changing it', async () => {
  const f=await initialAdmission();
  try {
   const input=f.input(),original=structuredClone(input);
   for(const parameters of [null,'{',{}, {appliedPlan:{...f.plan,id:'foreign'}},
    {appliedPlan:{...f.plan,teamId:'foreign'}},{appliedPlan:{...f.plan,executionMode:'production'}},
    {appliedPlan:{...f.plan,state:'ended'}},{appliedPlan:{...f.plan,state:'closing',closingAt:input.now}},
    {appliedPlan:{...f.plan,endsAt:input.now}}]){
    const bytes=typeof parameters==='string'?parameters:JSON.stringify(parameters);
    await f.query('UPDATE capacity_workday_runs SET parameters_json=? WHERE id=?',[bytes,f.plan.id]);
    const held=await f.snapshot(),runs=(await f.query('SELECT * FROM capacity_workday_runs ORDER BY id')).rows;
    await expect(f.admit(input)).rejects.toMatchObject({code:'workday_admission_closed',status:409});
    expect(await f.snapshot()).toEqual(held);expect((await f.query('SELECT * FROM capacity_workday_runs ORDER BY id')).rows).toEqual(runs);
    expect(input).toEqual(original);
   }
  }finally{await f.db.close();}
 });
 it('admits the exact Reporter only in closing and replays its original reservation without another charge', async () => {
  const f=await initialAdmission(undefined,true);
  try{
   const reporter=assignmentAttemptSchema.parse({...f.attempt,sourceRef:{store:'postgresql',model:'workday',id:f.plan.id,revision:1,digest:'sha256:'+'a'.repeat(64)},
    effectiveProfile:{...f.attempt.effectiveProfile,activity:'reporting',handler:'configured-reporting-handler'}});
   await f.query("UPDATE execution_nodes SET kind='reporting',source_ref_json=? WHERE id=?",[JSON.stringify(reporter.sourceRef),reporter.nodeId]);
   const input=f.input(reporter),original=structuredClone(input),before=await f.snapshot();
   await expect(f.admit(input)).rejects.toMatchObject({code:'workday_admission_closed',status:409});expect(await f.snapshot()).toEqual(before);
   await f.query('UPDATE capacity_workday_runs SET parameters_json=? WHERE id=?',[JSON.stringify({appliedPlan:{...f.plan,state:'closing',closingAt:input.now}}),f.plan.id]);
   const observed=await f.admit(input);expect(observed.assignmentAttempt).toEqual(reporter);
   const held=await f.snapshot();expect(await f.admit(input)).toEqual(observed);expect(await f.snapshot()).toEqual(held);expect(input).toEqual(original);
   const reservations=(await f.query('SELECT id,assignment_id,reserved_seconds FROM capacity_reservations')).rows;
   expect(reservations).toEqual([{id:reporter.reservationId,assignment_id:reporter.id,reserved_seconds:reporter.limits.maximumSeconds}]);
  }finally{await f.db.close();}
 });

 it('rejects a caller-supplied conversation kind for an owning closing Workday without granting another admission path',async()=>{
  const f=await initialAdmission();try{
   const input=f.input();input.executionKind='conversation';input.lanePurpose='communication';
   await f.query('UPDATE capacity_workday_runs SET parameters_json=? WHERE id=?',[JSON.stringify({appliedPlan:{...f.plan,state:'closing',closingAt:input.now}}),f.plan.id]);
   const before=await f.snapshot(),held=structuredClone(input);
   await expect(f.admit(input)).rejects.toMatchObject({code:'workday_admission_closed',status:409});
   expect(await f.snapshot()).toEqual(before);expect(input).toEqual(held);
  }finally{await f.db.close();}
 });
});
