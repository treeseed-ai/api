import { describe, expect, it } from 'vitest';
import { initialAdmission } from '../architecture/initial/initial-admission-fixture.ts';

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
});
